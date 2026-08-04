use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE},
        HeaderMap, HeaderName, HeaderValue, Method, StatusCode,
    },
    response::IntoResponse,
    routing::{get, patch, post},
    Json, Router,
};
use futures::{SinkExt, TryStreamExt};
use mongodb::bson::{doc, oid::ObjectId, DateTime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower_http::{
    cors::CorsLayer,
    trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer},
};
use tracing::Level;

use crate::{
    auth, auth_routes, cache,
    config::AppConfig,
    error::AppError,
    kubernetes,
    models::{
        ApplyResourceRequest, ClusterDocument, ClusterResponse, CreateClusterRequest,
        HealthResponse, LogsQuery, LogsResponse, ResourceQuery, ScaleRequest, SearchQuery,
        UpdateClusterRequest, YamlResponse,
    },
    state::{client_from_kubeconfig, SharedState},
};

pub fn router(state: SharedState, config: &AppConfig) -> Result<Router, AppError> {
    let origin = config
        .cors_origin
        .parse::<HeaderValue>()
        .map_err(|_| AppError::internal("CORS_ORIGIN is invalid"))?;
    let cors = CorsLayer::new()
        .allow_origin(origin)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            CONTENT_TYPE,
            AUTHORIZATION,
            HeaderName::from_static("x-kust-trusted-device"),
        ]);

    Ok(Router::new()
        .route("/api/health", get(health))
        .route(
            "/api/auth/register/lookup",
            post(auth_routes::registration_lookup),
        )
        .route("/api/auth/register", post(auth_routes::register))
        .route("/api/auth/login", post(auth_routes::login))
        .route("/api/auth/me", get(auth_routes::me))
        .route("/api/auth/logout", post(auth_routes::logout))
        .route("/api/auth/oa/request", post(auth_routes::oa_request))
        .route("/api/auth/code", post(auth_routes::code_login))
        .route(
            "/api/auth/password/request",
            post(auth_routes::password_request),
        )
        .route(
            "/api/auth/password/reset",
            post(auth_routes::password_reset),
        )
        .route("/api/auth/2fa/setup", get(auth_routes::totp_setup))
        .route("/api/auth/2fa/verify", post(auth_routes::totp_verify))
        .route(
            "/api/auth/password/change",
            post(auth_routes::change_password),
        )
        .route(
            "/api/settings",
            get(auth_routes::settings).put(auth_routes::update_settings),
        )
        .route("/api/admin/users", get(auth_routes::admin_users))
        .route("/api/admin/roles", get(auth_routes::admin_roles))
        .route(
            "/api/admin/users/{user_id}/roles",
            patch(auth_routes::update_roles),
        )
        .route(
            "/api/admin/users/{user_id}/reset-code",
            post(auth_routes::admin_reset_code),
        )
        .route("/api/search", get(global_search))
        .route("/api/clusters", get(list_clusters).post(create_cluster))
        .route(
            "/api/clusters/{cluster_id}",
            patch(update_cluster).delete(delete_cluster),
        )
        .route("/api/clusters/{cluster_id}/overview", get(cluster_overview))
        .route("/api/clusters/{cluster_id}/map", get(resource_map))
        .route("/api/clusters/{cluster_id}/sync", post(sync_cluster))
        .route(
            "/api/clusters/{cluster_id}/resources/{kind}",
            get(list_resources),
        )
        .route(
            "/api/clusters/{cluster_id}/resources/{kind}/{namespace}/{name}",
            get(get_resource).delete(delete_resource),
        )
        .route(
            "/api/clusters/{cluster_id}/deployments/{namespace}/{name}/scale",
            patch(scale_deployment),
        )
        .route(
            "/api/clusters/{cluster_id}/pods/{namespace}/{name}/logs",
            get(pod_logs),
        )
        .route(
            "/api/clusters/{cluster_id}/pods/{namespace}/{name}/files",
            get(file_tree),
        )
        .route(
            "/api/clusters/{cluster_id}/pods/{namespace}/{name}/file",
            get(read_file).put(write_file).delete(delete_file),
        )
        .route(
            "/api/clusters/{cluster_id}/pods/{namespace}/{name}/directory",
            axum::routing::post(make_directory),
        )
        .route(
            "/api/clusters/{cluster_id}/pods/{namespace}/{name}/shell",
            get(shell),
        )
        .route(
            "/api/clusters/{cluster_id}/apply",
            axum::routing::post(apply_yaml),
        )
        .layer(cors)
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().level(Level::INFO))
                .on_response(DefaultOnResponse::new().level(Level::INFO)),
        )
        .with_state(state))
}

async fn health(State(state): State<SharedState>) -> Result<Json<HealthResponse>, AppError> {
    state.database.run_command(doc! { "ping": 1 }).await?;
    Ok(Json(HealthResponse {
        status: "ok",
        database: "connected",
    }))
}

async fn list_clusters(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ClusterResponse>>, AppError> {
    auth::authenticate(&state, &headers, "authenticated").await?;
    let cursor = state
        .clusters
        .find(doc! {})
        .sort(doc! { "created_at": 1 })
        .await?;
    let clusters: Vec<ClusterDocument> = cursor.try_collect().await?;
    Ok(Json(clusters.into_iter().map(Into::into).collect()))
}

async fn create_cluster(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(request): Json<CreateClusterRequest>,
) -> Result<impl IntoResponse, AppError> {
    let actor = auth::require_admin(&state, &headers).await?;
    let name = request.name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err(AppError::bad_request(
            "cluster name must contain between 1 and 80 characters",
        ));
    }
    if request.kubeconfig.len() > 2_000_000 {
        return Err(AppError::bad_request("kubeconfig is too large"));
    }
    if state
        .clusters
        .find_one(doc! { "name": name })
        .await?
        .is_some()
    {
        return Err(AppError::conflict(
            "a cluster with this name already exists",
        ));
    }

    let parsed = kube::config::Kubeconfig::from_yaml(&request.kubeconfig)
        .map_err(|error| AppError::bad_request(format!("kubeconfig is invalid: {error}")))?;
    let context = request
        .context
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| parsed.current_context.clone())
        .ok_or_else(|| AppError::bad_request("kubeconfig has no current context"))?;
    let context_entry = parsed
        .contexts
        .iter()
        .find(|item| item.name == context)
        .ok_or_else(|| AppError::bad_request(format!("context '{context}' does not exist")))?;
    let cluster_name = context_entry
        .context
        .as_ref()
        .map(|context| context.cluster.as_str())
        .ok_or_else(|| AppError::bad_request(format!("context '{context}' is empty")))?;
    let server = parsed
        .clusters
        .iter()
        .find(|item| item.name == cluster_name)
        .and_then(|item| item.cluster.as_ref())
        .and_then(|cluster| cluster.server.clone())
        .ok_or_else(|| AppError::bad_request("selected context has no cluster server"))?;
    let client = client_from_kubeconfig(&request.kubeconfig, Some(context.clone())).await?;
    let version = tokio::time::timeout(Duration::from_secs(8), client.apiserver_version())
        .await
        .ok()
        .and_then(Result::ok)
        .map(|info| info.git_version);
    let now = DateTime::now();
    let document = ClusterDocument {
        id: ObjectId::new(),
        name: name.into(),
        description: request.description.trim().into(),
        context,
        server,
        kubernetes_version: version.clone(),
        kubeconfig_encrypted: state.secrets.encrypt(&request.kubeconfig)?,
        source: "user".into(),
        read_only: false,
        preset_key: None,
        owner_user_id: Some(actor.user.id),
        created_at: now,
        updated_at: now,
        last_connected_at: version.map(|_| now),
    };
    state.clusters.insert_one(&document).await?;
    Ok((StatusCode::CREATED, Json(ClusterResponse::from(document))))
}

async fn update_cluster(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(cluster_id): Path<String>,
    Json(request): Json<UpdateClusterRequest>,
) -> Result<Json<ClusterResponse>, AppError> {
    auth::require_admin(&state, &headers).await?;
    let mut cluster = state.cluster(&cluster_id).await?;
    if cluster.read_only || cluster.source == "preset" {
        return Err(AppError::forbidden("preset cluster configs are read-only"));
    }
    if let Some(name) = request.name {
        let name = name.trim();
        if name.is_empty() || name.len() > 80 {
            return Err(AppError::bad_request(
                "cluster name must contain between 1 and 80 characters",
            ));
        }
        if state
            .clusters
            .find_one(doc! { "name": name, "_id": { "$ne": cluster.id } })
            .await?
            .is_some()
        {
            return Err(AppError::conflict(
                "a cluster with this name already exists",
            ));
        }
        cluster.name = name.into();
    }
    if let Some(description) = request.description {
        cluster.description = description.trim().to_string();
    }
    if request.kubeconfig.is_some() || request.context.is_some() {
        let kubeconfig = match request.kubeconfig {
            Some(value) if value.len() <= 2_000_000 => value,
            Some(_) => return Err(AppError::bad_request("kubeconfig is too large")),
            None => state.secrets.decrypt(&cluster.kubeconfig_encrypted)?,
        };
        let parsed = kube::config::Kubeconfig::from_yaml(&kubeconfig)
            .map_err(|error| AppError::bad_request(format!("kubeconfig is invalid: {error}")))?;
        let context = request
            .context
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| parsed.current_context.clone())
            .unwrap_or_else(|| cluster.context.clone());
        let context_entry = parsed
            .contexts
            .iter()
            .find(|item| item.name == context)
            .ok_or_else(|| AppError::bad_request(format!("context '{context}' does not exist")))?;
        let cluster_name = context_entry
            .context
            .as_ref()
            .map(|value| value.cluster.as_str())
            .ok_or_else(|| AppError::bad_request(format!("context '{context}' is empty")))?;
        let server = parsed
            .clusters
            .iter()
            .find(|item| item.name == cluster_name)
            .and_then(|item| item.cluster.as_ref())
            .and_then(|item| item.server.clone())
            .ok_or_else(|| AppError::bad_request("selected context has no cluster server"))?;
        let client = client_from_kubeconfig(&kubeconfig, Some(context.clone())).await?;
        let version = tokio::time::timeout(Duration::from_secs(8), client.apiserver_version())
            .await
            .ok()
            .and_then(Result::ok)
            .map(|info| info.git_version);
        cluster.context = context;
        cluster.server = server;
        cluster.kubernetes_version = version.clone();
        cluster.kubeconfig_encrypted = state.secrets.encrypt(&kubeconfig)?;
        cluster.last_connected_at = version.map(|_| DateTime::now());
        cache::remove_cluster(&state, cluster.id).await?;
    }
    cluster.updated_at = DateTime::now();
    state
        .clusters
        .replace_one(doc! { "_id": cluster.id }, &cluster)
        .await?;
    Ok(Json(cluster.into()))
}

async fn delete_cluster(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(cluster_id): Path<String>,
) -> Result<StatusCode, AppError> {
    auth::require_admin(&state, &headers).await?;
    let cluster = state.cluster(&cluster_id).await?;
    if cluster.read_only || cluster.source == "preset" {
        return Err(AppError::forbidden("preset cluster configs are read-only"));
    }
    let result = state
        .clusters
        .delete_one(doc! { "_id": cluster.id })
        .await?;
    if result.deleted_count == 0 {
        return Err(AppError::not_found("cluster was not found"));
    }
    cache::remove_cluster(&state, cluster.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn cluster_overview(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(cluster_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    auth::authenticate(&state, &headers, "authenticated").await?;
    Ok(Json(cache::overview(&state, &cluster_id).await?))
}

async fn list_resources(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((cluster_id, kind)): Path<(String, String)>,
    Query(query): Query<ResourceQuery>,
) -> Result<impl IntoResponse, AppError> {
    auth::authenticate(&state, &headers, "authenticated").await?;
    Ok(Json(
        cache::list_resources(
            &state,
            &cluster_id,
            &kind,
            query.namespace.as_deref(),
            query.label_selector.as_deref(),
        )
        .await?,
    ))
}

async fn delete_resource(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((cluster_id, kind, namespace, name)): Path<(String, String, String, String)>,
) -> Result<StatusCode, AppError> {
    require_resource_write(&state, &headers).await?;
    let client = state.kube_client(&cluster_id).await?;
    let namespace = (namespace != "_").then_some(namespace.as_str());
    kubernetes::delete_resource(client, &kind, namespace, &name).await?;
    cache::sync_kind(&state, &cluster_id, &kind).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_resource(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((cluster_id, kind, namespace, name)): Path<(String, String, String, String)>,
) -> Result<impl IntoResponse, AppError> {
    auth::authenticate(&state, &headers, "authenticated").await?;
    let client = state.kube_client(&cluster_id).await?;
    let namespace = (namespace != "_").then_some(namespace.as_str());
    let yaml = kubernetes::resource_yaml(client, &kind, namespace, &name).await?;
    Ok(Json(YamlResponse { yaml }))
}

async fn scale_deployment(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((cluster_id, namespace, name)): Path<(String, String, String)>,
    Json(request): Json<ScaleRequest>,
) -> Result<impl IntoResponse, AppError> {
    require_resource_write(&state, &headers).await?;
    let client = state.kube_client(&cluster_id).await?;
    let row = kubernetes::scale_deployment(client, &namespace, &name, request.replicas).await?;
    cache::sync_kind(&state, &cluster_id, "deployments").await?;
    Ok(Json(row))
}

async fn pod_logs(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((cluster_id, namespace, name)): Path<(String, String, String)>,
    Query(query): Query<LogsQuery>,
) -> Result<impl IntoResponse, AppError> {
    auth::authenticate(&state, &headers, "authenticated").await?;
    let client = state.kube_client(&cluster_id).await?;
    let logs = kubernetes::pod_logs(
        client,
        &namespace,
        &name,
        query.container,
        query.tail_lines.unwrap_or(500),
    )
    .await?;
    Ok(Json(LogsResponse { logs }))
}

async fn apply_yaml(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(cluster_id): Path<String>,
    Json(request): Json<ApplyResourceRequest>,
) -> Result<impl IntoResponse, AppError> {
    require_resource_write(&state, &headers).await?;
    let client = state.kube_client(&cluster_id).await?;
    let response =
        kubernetes::apply_yaml(client, &request.yaml, request.namespace.as_deref()).await?;
    let normalized = cache::normalize_kind(&response.kind);
    if cache::RESOURCE_KINDS.contains(&normalized.as_str()) {
        cache::sync_kind(&state, &cluster_id, &normalized).await?;
    }
    Ok((StatusCode::CREATED, Json(response)))
}

async fn file_tree(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((cluster_id, namespace, name)): Path<(String, String, String)>,
    Query(query): Query<crate::models::FileQuery>,
) -> Result<impl IntoResponse, AppError> {
    auth::authenticate(&state, &headers, "authenticated").await?;
    let client = state.kube_client(&cluster_id).await?;
    Ok(Json(
        kubernetes::pod_file_tree(client, &namespace, &name, &query.path, query.container).await?,
    ))
}

async fn read_file(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((cluster_id, namespace, name)): Path<(String, String, String)>,
    Query(query): Query<crate::models::FileQuery>,
) -> Result<impl IntoResponse, AppError> {
    auth::authenticate(&state, &headers, "authenticated").await?;
    let client = state.kube_client(&cluster_id).await?;
    Ok(Json(
        kubernetes::pod_read_file(client, &namespace, &name, &query.path, query.container).await?,
    ))
}

async fn write_file(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((cluster_id, namespace, name)): Path<(String, String, String)>,
    Json(request): Json<crate::models::FileWriteRequest>,
) -> Result<impl IntoResponse, AppError> {
    require_resource_write(&state, &headers).await?;
    let client = state.kube_client(&cluster_id).await?;
    let bytes = kubernetes::pod_write_file(
        client,
        &namespace,
        &name,
        &request.path,
        &request.content,
        request.container,
    )
    .await?;
    Ok(Json(
        serde_json::json!({ "path": request.path, "bytes": bytes }),
    ))
}

async fn make_directory(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((cluster_id, namespace, name)): Path<(String, String, String)>,
    Json(request): Json<crate::models::DirectoryRequest>,
) -> Result<StatusCode, AppError> {
    require_resource_write(&state, &headers).await?;
    let client = state.kube_client(&cluster_id).await?;
    kubernetes::pod_make_directory(client, &namespace, &name, &request.path, request.container)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_file(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((cluster_id, namespace, name)): Path<(String, String, String)>,
    Query(query): Query<crate::models::FileQuery>,
) -> Result<StatusCode, AppError> {
    require_resource_write(&state, &headers).await?;
    let client = state.kube_client(&cluster_id).await?;
    kubernetes::pod_delete_file(client, &namespace, &name, &query.path, query.container).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn shell(
    State(state): State<SharedState>,
    Path((cluster_id, namespace, name)): Path<(String, String, String)>,
    Query(query): Query<crate::models::ShellQuery>,
    upgrade: WebSocketUpgrade,
) -> Result<impl IntoResponse, AppError> {
    let actor = auth::authenticate_token(&state, &query.access_token, "authenticated").await?;
    if !actor
        .user
        .roles
        .iter()
        .any(|role| matches!(role.as_str(), "admin" | "operator"))
    {
        return Err(AppError::forbidden("resource write permission is required"));
    }
    let client = state.kube_client(&cluster_id).await?;
    Ok(upgrade.on_upgrade(move |socket| async move {
        if let Err(error) = stream_shell(socket, client, namespace, name, query.container).await {
            tracing::warn!(%error, "pod shell session ended");
        }
    }))
}

async fn global_search(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
) -> Result<impl IntoResponse, AppError> {
    auth::authenticate(&state, &headers, "authenticated").await?;
    Ok(Json(
        cache::search(
            &state,
            &query.q,
            query.cluster_id.as_deref(),
            query.limit.unwrap_or(30).clamp(1, 100),
        )
        .await?,
    ))
}

async fn resource_map(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(cluster_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    auth::authenticate(&state, &headers, "authenticated").await?;
    Ok(Json(cache::resource_map(&state, &cluster_id).await?))
}

async fn sync_cluster(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(cluster_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    require_resource_write(&state, &headers).await?;
    state.cluster(&cluster_id).await?;
    let mut synchronized = 0_usize;
    let mut skipped = Vec::new();
    for kind in cache::RESOURCE_KINDS {
        match cache::sync_kind(&state, &cluster_id, kind).await {
            Ok(_) => synchronized += 1,
            Err(error) => skipped.push(serde_json::json!({
                "kind": kind,
                "error": error.to_string()
            })),
        }
    }
    Ok(Json(serde_json::json!({
        "synchronized": synchronized,
        "skipped": skipped,
        "syncedAt": DateTime::now().try_to_rfc3339_string().unwrap_or_default()
    })))
}

async fn require_resource_write(
    state: &SharedState,
    headers: &HeaderMap,
) -> Result<auth::AuthenticatedUser, AppError> {
    let actor = auth::authenticate(state, headers, "authenticated").await?;
    if !actor
        .user
        .roles
        .iter()
        .any(|role| matches!(role.as_str(), "admin" | "operator"))
    {
        return Err(AppError::forbidden("resource write permission is required"));
    }
    Ok(actor)
}

async fn stream_shell(
    mut socket: WebSocket,
    client: kube::Client,
    namespace: String,
    pod: String,
    container: Option<String>,
) -> Result<(), AppError> {
    let mut process = kubernetes::pod_shell(client, &namespace, &pod, container).await?;
    let mut stdin = process
        .stdin()
        .ok_or_else(|| AppError::internal("pod shell did not provide stdin"))?;
    let mut stdout = process
        .stdout()
        .ok_or_else(|| AppError::internal("pod shell did not provide stdout"))?;
    let mut terminal_size = process.terminal_size();
    let mut output = [0_u8; 8192];
    loop {
        tokio::select! {
            message = socket.recv() => {
                let Some(message) = message else { break };
                let message = message.map_err(|error| AppError::upstream(format!("shell websocket failed: {error}")))?;
                match message {
                    Message::Text(text) => {
                        let payload: serde_json::Value = serde_json::from_str(&text)
                            .map_err(|error| AppError::bad_request(format!("shell message is invalid: {error}")))?;
                        match payload.get("type").and_then(serde_json::Value::as_str) {
                            Some("input") => {
                                if let Some(data) = payload.get("data").and_then(serde_json::Value::as_str) {
                                    stdin.write_all(data.as_bytes()).await.map_err(|error| AppError::upstream(format!("unable to write shell input: {error}")))?;
                                }
                            }
                            Some("resize") => {
                                if let (Some(cols), Some(rows)) = (
                                    payload.get("cols").and_then(serde_json::Value::as_u64),
                                    payload.get("rows").and_then(serde_json::Value::as_u64),
                                ) {
                                    if let Some(sender) = terminal_size.as_mut() {
                                        sender.send(kube::api::TerminalSize {
                                            width: cols.min(u16::MAX as u64) as u16,
                                            height: rows.min(u16::MAX as u64) as u16,
                                        }).await.map_err(|error| AppError::upstream(format!("unable to resize shell: {error}")))?;
                                    }
                                }
                            }
                            Some("close") => break,
                            _ => {}
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            read = stdout.read(&mut output) => {
                let read = read.map_err(|error| AppError::upstream(format!("unable to read shell output: {error}")))?;
                if read == 0 { break; }
                socket.send(Message::Text(String::from_utf8_lossy(&output[..read]).to_string().into())).await
                    .map_err(|error| AppError::upstream(format!("shell websocket failed: {error}")))?;
            }
        }
    }
    process.abort();
    Ok(())
}
