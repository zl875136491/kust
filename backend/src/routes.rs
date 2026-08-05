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
        ApplyResourceRequest, AuditLogDocument, AuditLogResponse, AuditQuery, ClusterDocument,
        ClusterResponse, CreateClusterRequest, HealthResponse, LogsQuery, LogsResponse,
        NotificationDocument, NotificationResponse, ResourceQuery, ScaleRequest, SearchQuery,
        UpdateClusterMembersRequest, UpdateClusterRequest, YamlResponse,
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
            "/api/auth/capabilities",
            get(auth_routes::auth_capabilities),
        )
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
            "/api/admin/settings",
            get(auth_routes::admin_platform_settings).put(auth_routes::update_platform_settings),
        )
        .route(
            "/api/admin/users/{user_id}/roles",
            patch(auth_routes::update_roles),
        )
        .route(
            "/api/admin/users/{user_id}/status",
            patch(auth_routes::update_user_status),
        )
        .route(
            "/api/admin/users/{user_id}/reset-code",
            post(auth_routes::admin_reset_code),
        )
        .route("/api/admin/audit-logs", get(admin_audit_logs))
        .route("/api/notifications", get(list_notifications))
        .route(
            "/api/notifications/{notification_id}/read",
            patch(mark_notification_read),
        )
        .route(
            "/api/notifications/read-all",
            post(mark_all_notifications_read),
        )
        .route("/api/search", get(global_search))
        .route("/api/clusters", get(list_clusters).post(create_cluster))
        .route(
            "/api/clusters/{cluster_id}",
            patch(update_cluster).delete(delete_cluster),
        )
        .route(
            "/api/clusters/{cluster_id}/members",
            get(cluster_members).put(update_cluster_members),
        )
        .route("/api/clusters/{cluster_id}/overview", get(cluster_overview))
        .route(
            "/api/clusters/{cluster_id}/metrics/summary",
            get(metrics_summary),
        )
        .route("/api/clusters/{cluster_id}/discovery", get(discovery))
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
            "/api/clusters/{cluster_id}/workloads/{kind}/{namespace}/{name}/scale",
            patch(scale_workload),
        )
        .route(
            "/api/clusters/{cluster_id}/workloads/{kind}/{namespace}/{name}/restart",
            post(restart_workload),
        )
        .route(
            "/api/clusters/{cluster_id}/pods/{namespace}/{name}/logs",
            get(pod_logs),
        )
        .route(
            "/api/clusters/{cluster_id}/pods/{namespace}/{name}/containers",
            get(pod_containers),
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
    let actor = auth::authenticate(&state, &headers, "authenticated").await?;
    let cursor = state
        .clusters
        .find(if actor.user.is_admin() {
            doc! {}
        } else {
            doc! { "$or": [
                { "source": "preset" },
                { "owner_user_id": actor.user.id },
                { "member_user_ids": actor.user.id },
            ] }
        })
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
        member_user_ids: Vec::new(),
        created_at: now,
        updated_at: now,
        last_connected_at: version.map(|_| now),
    };
    state.clusters.insert_one(&document).await?;
    write_audit(
        &state,
        Some(actor.user.id),
        "cluster.create",
        Some(&document.name),
        Some(document.id),
        serde_json::json!({}),
    )
    .await?;
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

async fn cluster_members(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(cluster_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    auth::require_admin(&state, &headers).await?;
    let cluster = state.cluster(&cluster_id).await?;
    let ids = cluster
        .member_user_ids
        .iter()
        .chain(cluster.owner_user_id.iter())
        .copied()
        .collect::<Vec<_>>();
    let users: Vec<crate::models::UserDocument> = state
        .users
        .find(doc! { "_id": { "$in": ids } })
        .await?
        .try_collect()
        .await?;
    Ok(Json(
        serde_json::json!({ "ownerUserId": cluster.owner_user_id.map(|id| id.to_hex()), "members": users.into_iter().map(|user| user.response()).collect::<Vec<_>>() }),
    ))
}

async fn update_cluster_members(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(cluster_id): Path<String>,
    Json(request): Json<UpdateClusterMembersRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let actor = auth::require_admin(&state, &headers).await?;
    let mut cluster = state.cluster(&cluster_id).await?;
    if cluster.read_only || cluster.source == "preset" {
        return Err(AppError::forbidden("preset cluster configs are read-only"));
    }
    let mut ids = Vec::new();
    for id in request.user_ids {
        ids.push(ObjectId::parse_str(id).map_err(|_| AppError::bad_request("user id is invalid"))?);
    }
    ids.sort();
    ids.dedup();
    ids.retain(|id| Some(*id) != cluster.owner_user_id);
    cluster.member_user_ids = ids;
    cluster.updated_at = DateTime::now();
    state
        .clusters
        .replace_one(doc! { "_id": cluster.id }, &cluster)
        .await?;
    write_audit(
        &state,
        Some(actor.user.id),
        "cluster.members.update",
        Some(&cluster.name),
        Some(cluster.id),
        serde_json::json!({ "memberCount": cluster.member_user_ids.len() }),
    )
    .await?;
    Ok(Json(
        serde_json::json!({ "memberCount": cluster.member_user_ids.len() }),
    ))
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
    require_cluster_access(&state, &headers, &cluster_id).await?;
    Ok(Json(cache::overview(&state, &cluster_id).await?))
}

async fn metrics_summary(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(cluster_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    require_cluster_access(&state, &headers, &cluster_id).await?;
    let client = state.kube_client(&cluster_id).await?;
    Ok(Json(kubernetes::metrics_summary(client).await?))
}

async fn discovery(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(cluster_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    require_cluster_access(&state, &headers, &cluster_id).await?;
    Ok(Json(
        kubernetes::discover_resources(state.kube_client(&cluster_id).await?).await?,
    ))
}

async fn list_resources(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((cluster_id, kind)): Path<(String, String)>,
    Query(query): Query<ResourceQuery>,
) -> Result<impl IntoResponse, AppError> {
    require_cluster_access(&state, &headers, &cluster_id).await?;
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
    require_cluster_access(&state, &headers, &cluster_id).await?;
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

async fn scale_workload(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((cluster_id, kind, namespace, name)): Path<(String, String, String, String)>,
    Json(request): Json<ScaleRequest>,
) -> Result<impl IntoResponse, AppError> {
    require_resource_write(&state, &headers).await?;
    let client = state.kube_client(&cluster_id).await?;
    let normalized = cache::normalize_kind(&kind);
    let row = kubernetes::scale_workload(client, &normalized, &namespace, &name, request.replicas)
        .await?;
    cache::sync_kind(&state, &cluster_id, &normalized).await?;
    Ok(Json(row))
}

async fn restart_workload(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((cluster_id, kind, namespace, name)): Path<(String, String, String, String)>,
) -> Result<impl IntoResponse, AppError> {
    require_resource_write(&state, &headers).await?;
    let client = state.kube_client(&cluster_id).await?;
    let normalized = cache::normalize_kind(&kind);
    let row = kubernetes::restart_workload(client, &normalized, &namespace, &name).await?;
    cache::sync_kind(&state, &cluster_id, &normalized).await?;
    Ok(Json(row))
}

async fn pod_logs(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((cluster_id, namespace, name)): Path<(String, String, String)>,
    Query(query): Query<LogsQuery>,
) -> Result<impl IntoResponse, AppError> {
    require_cluster_access(&state, &headers, &cluster_id).await?;
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

async fn pod_containers(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path((cluster_id, namespace, name)): Path<(String, String, String)>,
) -> Result<impl IntoResponse, AppError> {
    require_cluster_access(&state, &headers, &cluster_id).await?;
    let client = state.kube_client(&cluster_id).await?;
    Ok(Json(
        kubernetes::pod_containers(client, &namespace, &name).await?,
    ))
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
    require_cluster_access(&state, &headers, &cluster_id).await?;
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
    require_cluster_access(&state, &headers, &cluster_id).await?;
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
    let cluster = state.cluster(&cluster_id).await?;
    if !actor.user.is_admin()
        && cluster.source != "preset"
        && cluster.owner_user_id != Some(actor.user.id)
        && !cluster.member_user_ids.contains(&actor.user.id)
    {
        return Err(AppError::forbidden("cluster access is not allowed"));
    }
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

async fn require_cluster_access(
    state: &SharedState,
    headers: &HeaderMap,
    cluster_id: &str,
) -> Result<auth::AuthenticatedUser, AppError> {
    let actor = auth::authenticate(state, headers, "authenticated").await?;
    let cluster = state.cluster(cluster_id).await?;
    if !actor.user.is_admin()
        && cluster.source != "preset"
        && cluster.owner_user_id != Some(actor.user.id)
        && !cluster.member_user_ids.contains(&actor.user.id)
    {
        return Err(AppError::forbidden("cluster access is not allowed"));
    }
    Ok(actor)
}

async fn write_audit(
    state: &SharedState,
    actor_user_id: Option<ObjectId>,
    action: &str,
    target: Option<&str>,
    cluster_id: Option<ObjectId>,
    metadata: serde_json::Value,
) -> Result<(), AppError> {
    state
        .database
        .collection::<AuditLogDocument>("audit_logs")
        .insert_one(AuditLogDocument {
            id: ObjectId::new(),
            actor_user_id,
            action: action.into(),
            target: target.map(str::to_owned),
            cluster_id,
            metadata,
            created_at: DateTime::now(),
        })
        .await?;
    Ok(())
}

async fn admin_audit_logs(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(query): Query<AuditQuery>,
) -> Result<Json<Vec<AuditLogResponse>>, AppError> {
    auth::require_admin(&state, &headers).await?;
    let mut filter = doc! {};
    if let Some(action) = query.action {
        filter.insert("action", action);
    }
    if let Some(user_id) = query
        .user_id
        .and_then(|value| ObjectId::parse_str(value).ok())
    {
        filter.insert("actor_user_id", user_id);
    }
    if let Some(cluster_id) = query
        .cluster_id
        .and_then(|value| ObjectId::parse_str(value).ok())
    {
        filter.insert("cluster_id", cluster_id);
    }
    let logs: Vec<AuditLogDocument> = state
        .database
        .collection("audit_logs")
        .find(filter)
        .sort(doc! { "created_at": -1 })
        .limit(query.limit.unwrap_or(100).clamp(1, 500))
        .await?
        .try_collect()
        .await?;
    Ok(Json(logs.into_iter().map(Into::into).collect()))
}

async fn list_notifications(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(query): Query<crate::models::AuditQuery>,
) -> Result<Json<Vec<NotificationResponse>>, AppError> {
    let actor = auth::authenticate(&state, &headers, "authenticated").await?;
    let mut filter = doc! { "user_id": actor.user.id };
    if let Some(cluster_id) = query
        .cluster_id
        .and_then(|value| ObjectId::parse_str(value).ok())
    {
        filter.insert("cluster_id", cluster_id);
    }
    let items: Vec<NotificationDocument> = state
        .notifications
        .find(filter)
        .sort(doc! { "created_at": -1 })
        .limit(query.limit.unwrap_or(100).clamp(1, 500))
        .await?
        .try_collect()
        .await?;
    Ok(Json(items.into_iter().map(Into::into).collect()))
}

async fn mark_notification_read(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(notification_id): Path<String>,
) -> Result<StatusCode, AppError> {
    let actor = auth::authenticate(&state, &headers, "authenticated").await?;
    let id = ObjectId::parse_str(notification_id)
        .map_err(|_| AppError::bad_request("notification id is invalid"))?;
    state
        .notifications
        .update_one(
            doc! { "_id": id, "user_id": actor.user.id },
            doc! { "$set": { "read_at": DateTime::now() } },
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn mark_all_notifications_read(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<StatusCode, AppError> {
    let actor = auth::authenticate(&state, &headers, "authenticated").await?;
    state
        .notifications
        .update_many(
            doc! { "user_id": actor.user.id, "read_at": null },
            doc! { "$set": { "read_at": DateTime::now() } },
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
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
