use axum::{
    extract::{Path, State},
    http::{
        header::{AUTHORIZATION, COOKIE, SET_COOKIE},
        HeaderMap, StatusCode,
    },
    response::{IntoResponse, Response},
    Json,
};
use futures::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, DateTime};
use serde_json::json;
use std::{collections::BTreeMap, net::IpAddr};
use url::Url;

use crate::{
    auth,
    error::AppError,
    kubernetes,
    models::{
        ApplicationBuildCallbackRequest, ApplicationBuildDocument, ApplicationBuildResponse,
        ApplicationWebhookResponse, CreateGitCredentialRequest, CreateHostedApplicationRequest,
        GitCredentialDocument, GitCredentialResponse, HostedApplicationDocument,
        HostedApplicationResponse, UpdateHostedApplicationRequest,
    },
    routes::write_audit,
    state::SharedState,
};

// Jenkins may queue hosting builds behind other untrusted repository builds. Keep the
// one-time source lease valid for the full pipeline window plus a small queue buffer.
const SOURCE_LEASE_TTL_MILLIS: i64 = 60 * 60 * 1_000;
const CALLBACK_TOKEN_TTL_MILLIS: i64 = 90 * 60 * 1_000;
const UNCLAIMED_BUILD_GRACE_MILLIS: i64 = 15 * 60 * 1_000;
// A build that claimed its source but never calls back is normally an aborted or
// disconnected Jenkins job. A build with a cleared callback token has already
// handed its immutable image to Kust, so allow extra time for rollout before
// making it eligible for a retry as well.
// Jenkins jobs are capped at 45 minutes. Allow a small delivery buffer before
// reclaiming a job that produced no immutable image or callback at all.
const UNCALLED_BUILD_GRACE_MILLIS: i64 = 60 * 60 * 1_000;
const UNFINISHED_ROLLOUT_GRACE_MILLIS: i64 = 45 * 60 * 1_000;

pub fn router_routes(router: axum::Router<SharedState>) -> axum::Router<SharedState> {
    router
        .route(
            "/api/hosting/capabilities",
            axum::routing::get(capabilities),
        )
        .route(
            "/api/hosting/credentials",
            axum::routing::get(list_credentials).post(create_credential),
        )
        .route(
            "/api/hosting/credentials/{credential_id}",
            axum::routing::delete(delete_credential),
        )
        .route(
            "/api/hosting/applications",
            axum::routing::get(list_applications).post(create_application),
        )
        .route(
            "/api/hosting/applications/{application_id}",
            axum::routing::get(get_application)
                .patch(update_application)
                .delete(delete_application),
        )
        .route(
            "/api/hosting/applications/{application_id}/builds",
            axum::routing::get(list_builds),
        )
        .route(
            "/api/hosting/applications/{application_id}/deploy",
            axum::routing::post(deploy_application),
        )
        .route(
            "/api/hosting/applications/{application_id}/redeploy",
            axum::routing::post(redeploy_application),
        )
        .route(
            "/api/hosting/applications/{application_id}/rollback",
            axum::routing::post(rollback_application),
        )
        .route(
            "/api/hosting/applications/{application_id}/webhook",
            axum::routing::post(rotate_webhook),
        )
        .route(
            "/api/hosting/webhooks/gitlab/{application_id}",
            axum::routing::post(gitlab_webhook),
        )
        .route(
            "/api/hosting/builds/{build_id}/callback",
            axum::routing::post(build_callback),
        )
        .route(
            "/api/hosting/builds/{build_id}/source",
            axum::routing::get(build_source),
        )
}

async fn capabilities(State(state): State<SharedState>) -> Json<serde_json::Value> {
    Json(json!({
        "hostingEnabled": state.config.app_hosting_enabled,
        "jenkinsConfigured": state.config.jenkins_url.is_some() && state.config.jenkins_api_token.is_some(),
        "allowedNamespaces": state.config.app_allowed_namespaces,
        "defaultNamespace": state.config.app_allowed_namespaces.first().cloned().unwrap_or_else(|| "default".into()),
    }))
}

fn validate_credential_request(request: &CreateGitCredentialRequest) -> Result<(), AppError> {
    if request.name.trim().is_empty() || request.name.len() > 80 {
        return Err(AppError::bad_request(
            "credential name must contain between 1 and 80 characters",
        ));
    }
    if !matches!(request.credential_type.as_str(), "token" | "ssh_key") {
        return Err(AppError::bad_request(
            "credential type must be token or ssh_key",
        ));
    }
    if request.secret.trim().is_empty() || request.secret.len() > 32_000 {
        return Err(AppError::bad_request("credential secret is invalid"));
    }
    Ok(())
}

async fn list_credentials(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Json<Vec<GitCredentialResponse>>, AppError> {
    let actor = auth::authenticate(&state, &headers, "authenticated").await?;
    let filter = if actor.user.is_admin() {
        doc! {}
    } else {
        doc! { "owner_user_id": actor.user.id }
    };
    let values: Vec<GitCredentialDocument> = state
        .git_credentials
        .find(filter)
        .sort(doc! { "updated_at": -1 })
        .await?
        .try_collect()
        .await?;
    Ok(Json(values.into_iter().map(Into::into).collect()))
}

async fn create_credential(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(request): Json<CreateGitCredentialRequest>,
) -> Result<impl IntoResponse, AppError> {
    let actor = auth::authenticate(&state, &headers, "authenticated").await?;
    validate_credential_request(&request)?;
    if state
        .git_credentials
        .find_one(doc! { "owner_user_id": actor.user.id, "name": request.name.trim() })
        .await?
        .is_some()
    {
        return Err(AppError::conflict(
            "a credential with this name already exists",
        ));
    }
    let now = DateTime::now();
    let value = GitCredentialDocument {
        id: ObjectId::new(),
        owner_user_id: actor.user.id,
        name: request.name.trim().to_string(),
        credential_type: request.credential_type,
        username: request
            .username
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        secret_encrypted: state.secrets.encrypt(&request.secret)?,
        created_at: now,
        updated_at: now,
    };
    state.git_credentials.insert_one(&value).await?;
    write_audit(
        &state,
        Some(actor.user.id),
        "hosting.credential.create",
        Some(&value.name),
        None,
        json!({"credentialType": value.credential_type}),
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(GitCredentialResponse::from(value)),
    ))
}

async fn delete_credential(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(credential_id): Path<String>,
) -> Result<StatusCode, AppError> {
    let actor = auth::authenticate(&state, &headers, "authenticated").await?;
    let id = parse_id(&credential_id, "credential id")?;
    let value = state
        .git_credentials
        .find_one(doc! { "_id": id })
        .await?
        .ok_or_else(|| AppError::not_found("credential was not found"))?;
    if !actor.user.is_admin() && value.owner_user_id != actor.user.id {
        return Err(AppError::forbidden("credential access is not allowed"));
    }
    state.git_credentials.delete_one(doc! { "_id": id }).await?;
    write_audit(
        &state,
        Some(actor.user.id),
        "hosting.credential.delete",
        Some(&value.name),
        None,
        json!({}),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

fn parse_id(value: &str, label: &str) -> Result<ObjectId, AppError> {
    ObjectId::parse_str(value).map_err(|_| AppError::bad_request(format!("{label} is invalid")))
}
fn valid_dns_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}
fn slugify(value: &str) -> String {
    let mut out = String::new();
    for c in value.to_ascii_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(53).collect()
}
fn validate_repository(value: &str) -> Result<String, AppError> {
    let raw = value.trim();
    let normalized = if !raw.contains("://") {
        let (identity, path) = raw
            .split_once(':')
            .ok_or_else(|| AppError::bad_request("repository URL is invalid"))?;
        let (username, host) = identity
            .split_once('@')
            .ok_or_else(|| AppError::bad_request("repository URL is invalid"))?;
        if username.is_empty() || host.is_empty() || path.is_empty() || path.starts_with('/') {
            return Err(AppError::bad_request("repository URL is invalid"));
        }
        format!("ssh://{username}@{host}/{path}")
    } else {
        raw.to_string()
    };
    let parsed =
        Url::parse(&normalized).map_err(|_| AppError::bad_request("repository URL is invalid"))?;
    if !matches!(parsed.scheme(), "https" | "http" | "ssh" | "git") || parsed.host_str().is_none() {
        return Err(AppError::bad_request(
            "repository URL must use http(s), ssh or git",
        ));
    }
    if matches!(parsed.scheme(), "http" | "https")
        && (!parsed.username().is_empty() || parsed.password().is_some())
    {
        return Err(AppError::bad_request(
            "repository URL must not contain embedded credentials",
        ));
    }
    let host = parsed.host_str().unwrap_or_default().trim_end_matches('.');
    let path = parsed.path();
    if path.is_empty()
        || path == "/"
        || path.contains("://")
        || path
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(AppError::bad_request("repository URL path is invalid"));
    }
    if host.eq_ignore_ascii_case("localhost")
        || host.eq_ignore_ascii_case("metadata.google.internal")
        || host.ends_with(".localhost")
        || host.ends_with(".local")
    {
        return Err(AppError::bad_request(
            "repository host is not allowed for application builds",
        ));
    }
    if let Ok(address) = host.parse::<IpAddr>() {
        let blocked = match address {
            IpAddr::V4(value) => {
                value.is_loopback()
                    || value.is_private()
                    || value.is_link_local()
                    || value.is_unspecified()
                    || value.is_multicast()
                    || value.octets() == [169, 254, 169, 254]
            }
            IpAddr::V6(value) => {
                value.is_loopback()
                    || value.is_unspecified()
                    || value.is_multicast()
                    || value.is_unique_local()
                    || value.is_unicast_link_local()
            }
        };
        if blocked {
            return Err(AppError::bad_request(
                "repository host must not point to a private or link-local address",
            ));
        }
    }
    Ok(normalized)
}

fn validate_repository_host(host: &str, allowed_hosts: &[String]) -> Result<(), AppError> {
    if allowed_hosts.is_empty() {
        return Ok(());
    }
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    if allowed_hosts.iter().any(|candidate| {
        let candidate = candidate.trim_end_matches('.').to_ascii_lowercase();
        normalized == candidate || normalized.ends_with(&format!(".{candidate}"))
    }) {
        Ok(())
    } else {
        Err(AppError::bad_request(
            "repository host is outside the platform allowlist",
        ))
    }
}

fn valid_hostname(value: &str) -> bool {
    !value.is_empty() && value.len() <= 253 && value.split('.').all(valid_dns_label)
}

fn normalized_route_path(prefix: &str, requested: &str, slug: &str) -> Result<String, AppError> {
    let path = if requested.trim().is_empty() || requested.trim() == "/" {
        format!("{prefix}/{slug}")
    } else if requested.starts_with('/') {
        requested.trim_end_matches('/').to_string()
    } else {
        format!("/{requested}")
    };
    if path.len() > 160
        || path.contains("..")
        || path.chars().any(|character| character.is_whitespace())
    {
        return Err(AppError::bad_request("route path is invalid"));
    }
    if path != prefix && !path.starts_with(&format!("{prefix}/")) {
        return Err(AppError::bad_request(format!(
            "route path must be within {prefix}"
        )));
    }
    Ok(path)
}

fn validate_source_subdirectory(value: Option<&str>) -> Result<(), AppError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if value.starts_with('/')
        || value.contains("..")
        || value.chars().any(|character| character.is_control())
        || value.len() > 240
    {
        return Err(AppError::bad_request("source subdirectory is invalid"));
    }
    Ok(())
}

fn validate_relative_directory(value: Option<&str>, label: &str) -> Result<(), AppError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if value.starts_with('/')
        || value.contains("..")
        || value.chars().any(|character| character.is_control())
        || value.len() > 240
    {
        return Err(AppError::bad_request(format!("{label} is invalid")));
    }
    Ok(())
}

fn validate_git_ref(value: &str) -> Result<(), AppError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 255
        || value.starts_with('-')
        || value.contains("..")
        || value.ends_with('/')
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(AppError::bad_request("Git ref is invalid"));
    }
    Ok(())
}

fn validate_health_path(value: &str) -> Result<(), AppError> {
    if !value.starts_with('/')
        || value.contains("..")
        || value.len() > 160
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(AppError::bad_request("health path is invalid"));
    }
    Ok(())
}

fn validate_health_scheme(value: &str) -> Result<(), AppError> {
    if !matches!(value, "HTTP" | "HTTPS") {
        return Err(AppError::bad_request("health scheme is invalid"));
    }
    Ok(())
}

fn validate_service_scheme(value: &str) -> Result<(), AppError> {
    if !matches!(value, "HTTP" | "HTTPS") {
        return Err(AppError::bad_request("service scheme is invalid"));
    }
    Ok(())
}

fn valid_quantity(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
}

fn validate_resources(request: &CreateHostedApplicationRequest) -> Result<(), AppError> {
    if [
        request.cpu_request.as_str(),
        request.memory_request.as_str(),
        request.cpu_limit.as_str(),
        request.memory_limit.as_str(),
    ]
    .iter()
    .any(|value| !valid_quantity(value))
    {
        return Err(AppError::bad_request("resource quantity is invalid"));
    }
    Ok(())
}

fn valid_build_environment_key(value: &str) -> bool {
    let mut characters = value.bytes();
    matches!(characters.next(), Some(byte) if byte.is_ascii_uppercase() || byte == b'_')
        && characters.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && value.len() <= 64
}

fn valid_build_environment_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'.' | b'_' | b'/' | b':' | b'=' | b'@' | b'%' | b'+' | b',' | b'-'
                )
        })
}

fn validate_build_environment(environment: &BTreeMap<String, String>) -> Result<(), AppError> {
    if environment.len() > 32
        || environment.iter().any(|(key, value)| {
            !valid_build_environment_key(key)
                || !valid_build_environment_value(value)
                || key.starts_with("KUST_")
                || matches!(
                    key.as_str(),
                    "HTTP_PROXY"
                        | "HTTPS_PROXY"
                        | "NO_PROXY"
                        | "GLOBAL_AGENT_HTTP_PROXY"
                        | "GLOBAL_AGENT_HTTPS_PROXY"
                )
        })
    {
        return Err(AppError::bad_request(
            "build environment contains an invalid or reserved value",
        ));
    }
    Ok(())
}

fn validate_runtime_environment(environment: &BTreeMap<String, String>) -> Result<(), AppError> {
    if environment.len() > 32
        || environment.iter().any(|(key, value)| {
            !valid_build_environment_key(key)
                || !valid_build_environment_value(value)
                || key.starts_with("KUST_")
                || matches!(
                    key.as_str(),
                    "HTTP_PROXY"
                        | "HTTPS_PROXY"
                        | "NO_PROXY"
                        | "GLOBAL_AGENT_HTTP_PROXY"
                        | "GLOBAL_AGENT_HTTPS_PROXY"
                )
        })
    {
        return Err(AppError::bad_request(
            "runtime environment contains an invalid or reserved value",
        ));
    }
    Ok(())
}

fn validate_runtime_profile(value: &str) -> Result<(), AppError> {
    if !matches!(value, "non_root" | "root_compatible") {
        return Err(AppError::bad_request("runtime profile is invalid"));
    }
    Ok(())
}

fn hosted_application_proxy_image(state: &SharedState) -> Result<&str, AppError> {
    const PROXY_REPOSITORY: &str = "10.17.158.118/kust/kust_app_proxy@sha256:";
    let image =
        state.config.app_proxy_image.as_deref().ok_or_else(|| {
            AppError::conflict("application hosting proxy image is not configured")
        })?;
    if !valid_digest_reference(image, PROXY_REPOSITORY) {
        return Err(AppError::conflict(
            "application hosting proxy image must be a platform immutable digest",
        ));
    }
    Ok(image)
}

fn hosted_application_public_url(
    state: &SharedState,
    application: &HostedApplicationDocument,
) -> Result<Url, AppError> {
    let base = state
        .config
        .app_public_verify_url
        .as_deref()
        .ok_or_else(|| {
            AppError::conflict("application hosting public verification URL is not configured")
        })?;
    public_route_url(base, &application.route_path)
}

fn public_route_url(base: &str, route_path: &str) -> Result<Url, AppError> {
    let mut url = Url::parse(base).map_err(|_| {
        AppError::conflict("application hosting public verification URL is invalid")
    })?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(AppError::conflict(
            "application hosting public verification URL must be an HTTP(S) URL",
        ));
    }
    let path = format!("{}/", route_path.trim_end_matches('/'));
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

async fn verify_hosted_application_route(
    state: &SharedState,
    application: &HostedApplicationDocument,
) -> Result<(), AppError> {
    let mut url = hosted_application_public_url(state, application)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Kust/0.1 hosted-route-verifier")
        .build()
        .map_err(|error| AppError::internal(format!("unable to create route verifier: {error}")))?;
    for _ in 0..=3 {
        let response = client
            .get(url.clone())
            .header(reqwest::header::HOST, &application.route_host)
            .send()
            .await
            .map_err(|error| {
                AppError::upstream(format!("hosted application route request failed: {error}"))
            })?;
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    AppError::upstream("hosted application route redirected without Location")
                })?;
            let next = url.join(location).map_err(|_| {
                AppError::upstream("hosted application route returned an invalid redirect")
            })?;
            if next.host_str() != url.host_str()
                || next.port_or_known_default() != url.port_or_known_default()
                || !next.path().starts_with(&application.route_path)
            {
                return Err(AppError::upstream(
                    "hosted application route redirected outside its managed path",
                ));
            }
            url = next;
            continue;
        }
        if !status.is_success() {
            return Err(AppError::upstream(format!(
                "hosted application route returned {status} at {url}",
            )));
        }
        let body = response.bytes().await.map_err(|error| {
            AppError::upstream(format!(
                "hosted application route body could not be read: {error}"
            ))
        })?;
        return (!body.is_empty()).then_some(()).ok_or_else(|| {
            AppError::upstream(format!(
                "hosted application route returned an empty response at {url}",
            ))
        });
    }
    Err(AppError::upstream(
        "hosted application route exceeded the redirect limit",
    ))
}

async fn apply_and_verify_hosted_application(
    state: &SharedState,
    application: &HostedApplicationDocument,
    image_digest_ref: &str,
) -> Result<(), AppError> {
    let proxy_image = hosted_application_proxy_image(state)?;
    let client = state.kube_client(&application.cluster_id.to_hex()).await?;
    kubernetes::apply_hosted_application(
        client,
        application,
        image_digest_ref,
        proxy_image,
        state.config.app_image_pull_secret.as_deref(),
    )
    .await?;
    kubernetes::wait_for_hosted_application_ready(
        state.kube_client(&application.cluster_id.to_hex()).await?,
        application,
        std::time::Duration::from_secs(state.config.app_rollout_timeout_seconds),
    )
    .await?;
    verify_hosted_application_route(state, application).await
}

fn validate_app_request(
    state: &SharedState,
    request: &CreateHostedApplicationRequest,
) -> Result<(String, String, String, String), AppError> {
    let name = request.name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err(AppError::bad_request("application name is invalid"));
    }
    let slug = slugify(name);
    if !valid_dns_label(&slug) {
        return Err(AppError::bad_request(
            "application name cannot produce a valid slug",
        ));
    }
    let repository_url = validate_repository(&request.repository_url)?;
    let repository_host = Url::parse(&repository_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .ok_or_else(|| AppError::bad_request("repository host is invalid"))?;
    validate_repository_host(&repository_host, &state.config.app_allowed_git_hosts)?;
    validate_source_subdirectory(request.source_subdirectory.as_deref())?;
    validate_relative_directory(request.output_directory.as_deref(), "output directory")?;
    validate_git_ref(&request.git_ref)?;
    validate_health_path(&request.health_path)?;
    validate_health_scheme(&request.health_scheme)?;
    validate_service_scheme(&request.service_scheme)?;
    if !matches!(
        request.build_mode.as_str(),
        "dockerfile" | "buildpack" | "static" | "custom"
    ) {
        return Err(AppError::bad_request("unsupported build mode"));
    }
    if !(1..=65535).contains(&request.container_port) || !(1..=100).contains(&request.replicas) {
        return Err(AppError::bad_request(
            "container port or replicas is invalid",
        ));
    }
    if matches!(request.build_mode.as_str(), "static" | "custom") && request.container_port != 8080
    {
        return Err(AppError::bad_request(
            "static hosting uses fixed container port 8080",
        ));
    }
    if !request
        .namespace
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || request.namespace.len() > 63
        || request.namespace.starts_with('-')
        || request.namespace.ends_with('-')
    {
        return Err(AppError::bad_request("namespace is invalid"));
    }
    if !state.config.app_allowed_namespaces.is_empty()
        && !state
            .config
            .app_allowed_namespaces
            .iter()
            .any(|namespace| namespace == &request.namespace)
    {
        return Err(AppError::forbidden(
            "namespace is outside the hosting allowlist",
        ));
    }
    validate_resources(request)?;
    validate_build_environment(&request.build_environment)?;
    validate_runtime_environment(&request.runtime_environment)?;
    validate_runtime_profile(&request.runtime_profile)?;
    hosted_application_proxy_image(state)?;
    let verify_base = state
        .config
        .app_public_verify_url
        .as_deref()
        .ok_or_else(|| {
            AppError::conflict("application hosting public verification URL is not configured")
        })?;
    public_route_url(verify_base, "/apps/verification")?;
    normalized_route_path(&state.config.app_route_prefix, &request.route_path, &slug)?;
    let host =
        state.config.app_default_route_host.clone().ok_or_else(|| {
            AppError::conflict("application hosting route host is not configured")
        })?;
    if request
        .route_host
        .as_deref()
        .is_some_and(|requested| requested != host)
    {
        return Err(AppError::forbidden("route host is platform-managed"));
    }
    if !valid_hostname(&host) {
        return Err(AppError::bad_request("route host is invalid"));
    }
    let gateway = state
        .config
        .app_default_gateway_name
        .clone()
        .ok_or_else(|| AppError::conflict("application hosting gateway is not configured"))?;
    let gateway_ns = state
        .config
        .app_default_gateway_namespace
        .clone()
        .unwrap_or_else(|| "default".into());
    if request
        .gateway_name
        .as_deref()
        .is_some_and(|requested| requested != gateway)
        || request
            .gateway_namespace
            .as_deref()
            .is_some_and(|requested| requested != gateway_ns)
    {
        return Err(AppError::forbidden("Gateway reference is platform-managed"));
    }
    if !valid_dns_label(&gateway) || !valid_dns_label(&gateway_ns) {
        return Err(AppError::bad_request("gateway reference is invalid"));
    }
    Ok((
        slug,
        repository_url,
        host,
        format!("{}|{}", gateway, gateway_ns),
    ))
}

fn app_response(
    app: HostedApplicationDocument,
    latest_build: Option<ApplicationBuildDocument>,
) -> HostedApplicationResponse {
    HostedApplicationResponse {
        id: app.id.to_hex(),
        owner_user_id: app.owner_user_id.to_hex(),
        name: app.name,
        slug: app.slug,
        repository_url: app.repository_url,
        git_ref: app.git_ref,
        credential_id: app.credential_id.map(|v| v.to_hex()),
        build_mode: app.build_mode,
        source_subdirectory: app.source_subdirectory,
        build_command: app.build_command,
        output_directory: app.output_directory,
        build_environment: app.build_environment,
        runtime_environment: app.runtime_environment,
        runtime_profile: app.runtime_profile,
        container_port: app.container_port,
        health_path: app.health_path,
        health_scheme: app.health_scheme,
        service_scheme: app.service_scheme,
        cluster_id: app.cluster_id.to_hex(),
        namespace: app.namespace,
        replicas: app.replicas,
        cpu_request: app.cpu_request,
        memory_request: app.memory_request,
        cpu_limit: app.cpu_limit,
        memory_limit: app.memory_limit,
        route_host: app.route_host,
        route_path: app.route_path,
        gateway_name: app.gateway_name,
        gateway_namespace: app.gateway_namespace,
        auto_deploy: app.auto_deploy,
        webhook_configured: app.webhook_secret_encrypted.is_some(),
        created_at: app.created_at.try_to_rfc3339_string().unwrap_or_default(),
        updated_at: app.updated_at.try_to_rfc3339_string().unwrap_or_default(),
        latest_build: latest_build.map(Into::into),
    }
}

async fn list_applications(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Json<Vec<HostedApplicationResponse>>, AppError> {
    let actor = auth::authenticate(&state, &headers, "authenticated").await?;
    let filter = if actor.user.is_admin() {
        doc! {}
    } else {
        doc! { "$or": [{"owner_user_id": actor.user.id}, {"member_user_ids": actor.user.id}] }
    };
    let apps: Vec<HostedApplicationDocument> = state
        .hosted_applications
        .find(filter)
        .sort(doc! {"updated_at": -1})
        .await?
        .try_collect()
        .await?;
    let mut response = Vec::new();
    for app in apps {
        let build = state
            .application_builds
            .find_one(doc! {"application_id": app.id})
            .sort(doc! {"created_at": -1})
            .await?;
        response.push(app_response(app, build));
    }
    Ok(Json(response))
}

async fn create_application(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(request): Json<CreateHostedApplicationRequest>,
) -> Result<impl IntoResponse, AppError> {
    if !state.config.app_hosting_enabled {
        return Err(AppError::conflict("application hosting is disabled"));
    }
    let actor = auth::authenticate(&state, &headers, "authenticated").await?;
    require_hosting_write(&actor)?;
    let (slug, repository_url, host, gateway) = validate_app_request(&state, &request)?;
    let cluster_id = parse_id(&request.cluster_id, "cluster id")?;
    let cluster = state
        .clusters
        .find_one(doc! {"_id": cluster_id})
        .await?
        .ok_or_else(|| AppError::not_found("cluster was not found"))?;
    if !actor.user.is_admin()
        && cluster.source != "preset"
        && cluster.owner_user_id != Some(actor.user.id)
        && !cluster.member_user_ids.contains(&actor.user.id)
    {
        return Err(AppError::forbidden("cluster access is not allowed"));
    }
    let credential_id = request
        .credential_id
        .as_deref()
        .map(|v| parse_id(v, "credential id"))
        .transpose()?;
    if let Some(id) = credential_id {
        let c = state
            .git_credentials
            .find_one(doc! {"_id": id})
            .await?
            .ok_or_else(|| AppError::not_found("credential was not found"))?;
        if !actor.user.is_admin() && c.owner_user_id != actor.user.id {
            return Err(AppError::forbidden("credential access is not allowed"));
        }
        let scheme = Url::parse(&repository_url)
            .ok()
            .map(|url| url.scheme().to_string())
            .unwrap_or_default();
        if c.credential_type == "token" && !matches!(scheme.as_str(), "http" | "https") {
            return Err(AppError::bad_request(
                "Access Token credentials require an HTTP(S) repository URL",
            ));
        }
        if c.credential_type == "ssh_key" && scheme != "ssh" {
            return Err(AppError::bad_request(
                "SSH keys require an ssh:// repository URL",
            ));
        }
    }
    let (gateway_name, gateway_namespace) = gateway.split_once('|').unwrap();
    let now = DateTime::now();
    let route_path =
        normalized_route_path(&state.config.app_route_prefix, &request.route_path, &slug)?;
    let app = HostedApplicationDocument {
        id: ObjectId::new(),
        owner_user_id: actor.user.id,
        member_user_ids: Vec::new(),
        name: request.name.trim().into(),
        slug,
        repository_url,
        git_ref: request.git_ref.trim().into(),
        credential_id,
        build_mode: request.build_mode,
        source_subdirectory: request.source_subdirectory,
        build_command: request.build_command,
        output_directory: request.output_directory,
        build_environment: request.build_environment,
        runtime_environment: request.runtime_environment,
        runtime_profile: request.runtime_profile,
        container_port: request.container_port,
        health_path: request.health_path,
        health_scheme: request.health_scheme,
        service_scheme: request.service_scheme,
        cluster_id,
        namespace: request.namespace,
        replicas: request.replicas,
        cpu_request: request.cpu_request,
        memory_request: request.memory_request,
        cpu_limit: request.cpu_limit,
        memory_limit: request.memory_limit,
        route_host: host,
        route_path,
        gateway_name: gateway_name.into(),
        gateway_namespace: gateway_namespace.into(),
        auto_deploy: request.auto_deploy,
        webhook_secret_encrypted: None,
        created_at: now,
        updated_at: now,
    };
    if state
        .hosted_applications
        .find_one(
            doc! {"cluster_id": app.cluster_id, "namespace": &app.namespace, "slug": &app.slug},
        )
        .await?
        .is_some()
    {
        return Err(AppError::conflict(
            "an application with this name already exists in the namespace",
        ));
    }
    state.hosted_applications.insert_one(&app).await?;
    write_audit(
        &state,
        Some(actor.user.id),
        "hosting.application.create",
        Some(&app.name),
        Some(app.cluster_id),
        json!({"applicationId": app.id.to_hex()}),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(app_response(app, None))))
}

async fn get_app_for_actor(
    state: &SharedState,
    headers: &HeaderMap,
    id: &str,
) -> Result<(auth::AuthenticatedUser, HostedApplicationDocument), AppError> {
    let actor = auth::authenticate(state, headers, "authenticated").await?;
    let app_id = parse_id(id, "application id")?;
    let app = state
        .hosted_applications
        .find_one(doc! {"_id": app_id})
        .await?
        .ok_or_else(|| AppError::not_found("application was not found"))?;
    if !actor.user.is_admin()
        && app.owner_user_id != actor.user.id
        && !app.member_user_ids.contains(&actor.user.id)
    {
        return Err(AppError::forbidden("application access is not allowed"));
    }
    Ok((actor, app))
}

async fn get_application(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(application_id): Path<String>,
) -> Result<Json<HostedApplicationResponse>, AppError> {
    let (_, app) = get_app_for_actor(&state, &headers, &application_id).await?;
    let build = state
        .application_builds
        .find_one(doc! {"application_id": app.id})
        .sort(doc! {"created_at": -1})
        .await?;
    Ok(Json(app_response(app, build)))
}

async fn list_builds(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(application_id): Path<String>,
) -> Result<Json<Vec<ApplicationBuildResponse>>, AppError> {
    let (_, app) = get_app_for_actor(&state, &headers, &application_id).await?;
    let builds: Vec<ApplicationBuildDocument> = state
        .application_builds
        .find(doc! {"application_id": app.id})
        .sort(doc! {"created_at": -1})
        .limit(100)
        .await?
        .try_collect()
        .await?;
    Ok(Json(builds.into_iter().map(Into::into).collect()))
}

async fn update_application(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(application_id): Path<String>,
    Json(request): Json<UpdateHostedApplicationRequest>,
) -> Result<Json<HostedApplicationResponse>, AppError> {
    let (actor, mut app) = get_app_for_actor(&state, &headers, &application_id).await?;
    if !actor.user.is_admin() && app.owner_user_id != actor.user.id {
        return Err(AppError::forbidden(
            "only the application owner can update it",
        ));
    }
    if let Some(v) = request.git_ref {
        validate_git_ref(&v)?;
        app.git_ref = v.trim().into();
    }
    if let Some(v) = request.build_mode {
        if !matches!(v.as_str(), "dockerfile" | "buildpack" | "static" | "custom") {
            return Err(AppError::bad_request("unsupported build mode"));
        }
        app.build_mode = v;
    }
    if let Some(v) = request.container_port {
        if !(1..=65535).contains(&v) {
            return Err(AppError::bad_request("container port is invalid"));
        }
        app.container_port = v;
    }
    if matches!(app.build_mode.as_str(), "static" | "custom") && app.container_port != 8080 {
        return Err(AppError::bad_request(
            "static hosting uses fixed container port 8080",
        ));
    }
    if let Some(v) = request.replicas {
        if !(1..=100).contains(&v) {
            return Err(AppError::bad_request("replicas is invalid"));
        }
        app.replicas = v;
    }
    if let Some(v) = request.health_path {
        app.health_path = if v.starts_with('/') {
            v
        } else {
            format!("/{v}")
        };
        validate_health_path(&app.health_path)?;
    }
    if let Some(v) = request.health_scheme {
        validate_health_scheme(&v)?;
        app.health_scheme = v;
    }
    if let Some(v) = request.service_scheme {
        validate_service_scheme(&v)?;
        app.service_scheme = v;
    }
    if let Some(v) = request.source_subdirectory {
        validate_source_subdirectory(Some(&v))?;
        app.source_subdirectory = Some(v);
    }
    if let Some(v) = request.build_command {
        app.build_command = Some(v);
    }
    if let Some(v) = request.output_directory {
        validate_relative_directory(Some(&v), "output directory")?;
        app.output_directory = Some(v);
    }
    if let Some(v) = request.build_environment {
        validate_build_environment(&v)?;
        app.build_environment = v;
    }
    if let Some(v) = request.runtime_environment {
        validate_runtime_environment(&v)?;
        app.runtime_environment = v;
    }
    if let Some(v) = request.runtime_profile {
        validate_runtime_profile(&v)?;
        app.runtime_profile = v;
    }
    if let Some(v) = request.cpu_request {
        app.cpu_request = v;
    }
    if let Some(v) = request.memory_request {
        app.memory_request = v;
    }
    if let Some(v) = request.cpu_limit {
        app.cpu_limit = v;
    }
    if let Some(v) = request.memory_limit {
        app.memory_limit = v;
    }
    if let Some(v) = request.route_path {
        app.route_path = normalized_route_path(&state.config.app_route_prefix, &v, &app.slug)?;
    }
    if let Some(v) = request.auto_deploy {
        app.auto_deploy = v;
    }
    app.updated_at = DateTime::now();
    state
        .hosted_applications
        .replace_one(doc! {"_id":app.id}, &app)
        .await?;
    write_audit(
        &state,
        Some(actor.user.id),
        "hosting.application.update",
        Some(&app.name),
        Some(app.cluster_id),
        json!({}),
    )
    .await?;
    let build = state
        .application_builds
        .find_one(doc! {"application_id":app.id})
        .sort(doc! {"created_at":-1})
        .await?;
    Ok(Json(app_response(app, build)))
}

async fn delete_application(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(application_id): Path<String>,
) -> Result<StatusCode, AppError> {
    let (actor, app) = get_app_for_actor(&state, &headers, &application_id).await?;
    if !actor.user.is_admin() && app.owner_user_id != actor.user.id {
        return Err(AppError::forbidden(
            "only the application owner can delete it",
        ));
    }
    // Resource discovery and Kubernetes finalizers can outlive the public gateway
    // timeout. Remove the application from the platform immediately and clean up
    // only its ownership-checked resources in the background.
    let cleanup_state = state.clone();
    let cleanup_app = app.clone();
    tokio::spawn(async move {
        let result = async {
            let client = cleanup_state
                .kube_client(&cleanup_app.cluster_id.to_hex())
                .await?;
            kubernetes::delete_hosted_application(client, &cleanup_app).await
        }
        .await;
        if let Err(error) = result {
            tracing::warn!(
                %error,
                application_id = %cleanup_app.id.to_hex(),
                "unable to clean up hosted application Kubernetes resources"
            );
        }
    });
    state
        .hosted_applications
        .delete_one(doc! {"_id":app.id})
        .await?;
    state
        .application_builds
        .delete_many(doc! {"application_id":app.id})
        .await?;
    write_audit(
        &state,
        Some(actor.user.id),
        "hosting.application.delete",
        Some(&app.name),
        Some(app.cluster_id),
        json!({}),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn deploy_application(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(application_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let (actor, app) = get_app_for_actor(&state, &headers, &application_id).await?;
    require_hosting_write(&actor)?;
    if !actor.user.is_admin() && app.owner_user_id != actor.user.id {
        return Err(AppError::forbidden(
            "only the application owner can deploy it",
        ));
    }
    trigger_build(&state, &app, actor.user.id).await
}

async fn redeploy_application(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(application_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let (actor, app) = get_app_for_actor(&state, &headers, &application_id).await?;
    require_hosting_write(&actor)?;
    if !actor.user.is_admin() && app.owner_user_id != actor.user.id {
        return Err(AppError::forbidden(
            "only the application owner can redeploy it",
        ));
    }
    let previous = state
        .application_builds
        .find(doc! {"application_id": app.id, "image_digest_ref": {"$type": "string"}})
        .sort(doc! {"created_at": -1})
        .await?
        .try_next()
        .await?
        .ok_or_else(|| AppError::conflict("no previously built image is available to redeploy"))?;
    let image = previous
        .image_digest_ref
        .clone()
        .ok_or_else(|| AppError::conflict("no previously built image is available to redeploy"))?;
    if state
        .application_builds
        .find_one(doc! {"application_id": app.id, "status": {"$in": ["queued", "running"]}})
        .await?
        .is_some()
    {
        return Err(AppError::conflict(
            "an application build is already queued or running",
        ));
    }
    let now = DateTime::now();
    let build = ApplicationBuildDocument {
        id: ObjectId::new(),
        application_id: app.id,
        triggered_by_user_id: Some(actor.user.id),
        git_commit: previous.git_commit,
        git_ref: previous.git_ref,
        status: "running".into(),
        jenkins_build_url: previous.jenkins_build_url,
        image_ref: previous.image_ref,
        image_digest_ref: Some(image.clone()),
        message: Some("Reapplying the latest immutable image with current runtime settings".into()),
        source_lease_token_hash: None,
        source_lease_expires_at: None,
        source_lease_consumed_at: None,
        callback_token_hash: None,
        callback_token_expires_at: None,
        created_at: now,
        started_at: Some(now),
        finished_at: None,
    };
    let id = build.id;
    state.application_builds.insert_one(&build).await?;
    let deployment_state = state.clone();
    let deployment_app = app.clone();
    let deployment_image = image.clone();
    tokio::spawn(async move {
        let result = apply_and_verify_hosted_application(
            &deployment_state,
            &deployment_app,
            &deployment_image,
        )
        .await;
        let (status, message) = match result {
            Ok(()) => (
                "succeeded",
                "Deployment, Service, HTTPRoute and public application route are ready".to_string(),
            ),
            Err(error) => ("failed", format!("Kubernetes redeployment failed: {error}")),
        };
        if let Err(error) = deployment_state
            .application_builds
            .update_one(
                doc! {"_id": id, "status": "running"},
                doc! {"$set": {"status": status, "message": message, "finished_at": DateTime::now()}},
            )
            .await
        {
            tracing::warn!(%error, build_id = %id.to_hex(), "unable to record hosted application redeployment result");
        }
    });
    write_audit(
        &state,
        Some(actor.user.id),
        "hosting.redeploy",
        Some(&app.name),
        Some(app.cluster_id),
        json!({"buildId": id.to_hex(), "imageDigestRef": image}),
    )
    .await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(ApplicationBuildResponse::from(build)),
    ))
}

async fn rollback_application(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(application_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let (actor, app) = get_app_for_actor(&state, &headers, &application_id).await?;
    require_hosting_write(&actor)?;
    if !actor.user.is_admin() && app.owner_user_id != actor.user.id {
        return Err(AppError::forbidden(
            "only the application owner can roll back it",
        ));
    }
    let build = state
        .application_builds
        .find(
            doc! {"application_id":app.id,"status":"succeeded","image_digest_ref":{"$exists":true}},
        )
        .sort(doc! {"created_at":-1})
        .skip(1)
        .await?
        .try_next()
        .await?
        .ok_or_else(|| AppError::conflict("no previous successful release is available"))?;
    let image = build.image_digest_ref.clone().unwrap();
    apply_and_verify_hosted_application(&state, &app, &image).await?;
    write_audit(
        &state,
        Some(actor.user.id),
        "hosting.rollback",
        Some(&app.name),
        Some(app.cluster_id),
        json!({"buildId":build.id.to_hex()}),
    )
    .await?;
    Ok(Json(ApplicationBuildResponse::from(build)))
}

async fn rotate_webhook(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(application_id): Path<String>,
) -> Result<Json<ApplicationWebhookResponse>, AppError> {
    let (actor, mut app) = get_app_for_actor(&state, &headers, &application_id).await?;
    require_hosting_write(&actor)?;
    if !actor.user.is_admin() && app.owner_user_id != actor.user.id {
        return Err(AppError::forbidden(
            "only the application owner can manage its webhook",
        ));
    }
    let secret = auth::random_token(32);
    app.webhook_secret_encrypted = Some(state.secrets.encrypt(&secret)?);
    app.updated_at = DateTime::now();
    state
        .hosted_applications
        .replace_one(doc! {"_id": app.id}, &app)
        .await?;
    write_audit(
        &state,
        Some(actor.user.id),
        "hosting.webhook.rotate",
        Some(&app.name),
        Some(app.cluster_id),
        json!({}),
    )
    .await?;
    Ok(Json(ApplicationWebhookResponse {
        url: format!(
            "{}/api/hosting/webhooks/gitlab/{}",
            state.config.frontend_url.trim_end_matches('/'),
            app.id.to_hex()
        ),
        secret,
    }))
}

async fn gitlab_webhook(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(application_id): Path<String>,
    Json(payload): Json<serde_json::Value>,
) -> Result<Response, AppError> {
    let app_id = parse_id(&application_id, "application id")?;
    let app = state
        .hosted_applications
        .find_one(doc! {"_id": app_id})
        .await?
        .ok_or_else(|| AppError::not_found("application was not found"))?;
    let expected = app
        .webhook_secret_encrypted
        .as_deref()
        .ok_or_else(|| AppError::forbidden("application webhook is not configured"))?;
    let supplied = headers
        .get("x-gitlab-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if state.secrets.decrypt(expected)? != supplied {
        return Err(AppError::unauthorized("invalid GitLab webhook token"));
    }
    let event = headers
        .get("x-gitlab-event")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !matches!(event, "Push Hook" | "Tag Push Hook") {
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({"ignored": "unsupported GitLab event"})),
        )
            .into_response());
    }
    if !app.auto_deploy {
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({"ignored": "auto deployment is disabled"})),
        )
            .into_response());
    }
    let reference = payload
        .get("ref")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let expected_ref = if app.git_ref.starts_with("refs/") {
        app.git_ref.clone()
    } else if event == "Tag Push Hook" {
        format!("refs/tags/{}", app.git_ref)
    } else {
        format!("refs/heads/{}", app.git_ref)
    };
    if reference != expected_ref {
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({"ignored": "Git reference does not match this application"})),
        )
            .into_response());
    }
    let result = trigger_build(&state, &app, app.owner_user_id).await?;
    Ok(result.into_response())
}

async fn trigger_build(
    state: &SharedState,
    app: &HostedApplicationDocument,
    user_id: ObjectId,
) -> Result<impl IntoResponse, AppError> {
    if !state.config.app_hosting_enabled {
        return Err(AppError::conflict("application hosting is disabled"));
    }
    // Reclaim abandoned asynchronous work before enforcing the single active build
    // invariant. Pipeline compilation failures never claim a source lease, a
    // cancelled Jenkins job claims it but never calls back, and an API restart can
    // interrupt the background rollout after the image callback. Each state gets
    // its own conservative grace period so valid, long-running builds are not
    // pre-empted.
    let unclaimed_build_deadline =
        DateTime::from_millis(DateTime::now().timestamp_millis() - UNCLAIMED_BUILD_GRACE_MILLIS);
    let uncalled_build_deadline =
        DateTime::from_millis(DateTime::now().timestamp_millis() - UNCALLED_BUILD_GRACE_MILLIS);
    let unfinished_rollout_deadline =
        DateTime::from_millis(DateTime::now().timestamp_millis() - UNFINISHED_ROLLOUT_GRACE_MILLIS);
    state
        .application_builds
        .update_many(
            doc! {
                "application_id": app.id,
                "status": {"$in": ["queued", "running"]},
                "source_lease_consumed_at": null,
                "created_at": {"$lt": unclaimed_build_deadline},
            },
            doc! {
                "$set": {
                    "status": "failed",
                    "message": "Jenkins did not claim the source lease before the build grace period expired",
                    "finished_at": DateTime::now(),
                },
            },
        )
        .await?;
    state
        .application_builds
        .update_many(
            doc! {
                "application_id": app.id,
                "status": {"$in": ["queued", "running"]},
                // Older build records created before callback tokens were stored
                // must be recoverable too. After the callback window has elapsed,
                // the absence of an image is the durable signal that Jenkins never
                // reached the deployment callback.
                "image_digest_ref": null,
                "created_at": {"$lt": uncalled_build_deadline},
            },
            doc! {
                "$set": {
                    "status": "failed",
                    "message": "Jenkins did not report a build result before the callback grace period expired",
                    "finished_at": DateTime::now(),
                },
            },
        )
        .await?;
    state
        .application_builds
        .update_many(
            doc! {
                "application_id": app.id,
                "status": "running",
                "callback_token_hash": null,
                "image_digest_ref": {"$ne": null},
                "created_at": {"$lt": unfinished_rollout_deadline},
            },
            doc! {
                "$set": {
                    "status": "failed",
                    "message": "Kubernetes rollout did not finish before the recovery grace period expired",
                    "finished_at": DateTime::now(),
                },
            },
        )
        .await?;
    if state
        .application_builds
        .find_one(doc! {"application_id": app.id, "status": {"$in": ["queued", "running"]}})
        .await?
        .is_some()
    {
        return Err(AppError::conflict(
            "an application build is already queued or running",
        ));
    }
    let image_repository = state
        .config
        .app_harbor_repository_prefix
        .as_deref()
        .map(|prefix| format!("{}/{}", prefix.trim_end_matches('/'), app.slug))
        .ok_or_else(|| {
            AppError::conflict("application Harbor repository prefix is not configured")
        })?;
    let source_lease_token = auth::random_token(32);
    let callback_token = auth::random_token(32);
    let now = DateTime::now();
    let build = ApplicationBuildDocument {
        id: ObjectId::new(),
        application_id: app.id,
        triggered_by_user_id: Some(user_id),
        git_commit: None,
        git_ref: app.git_ref.clone(),
        status: "queued".into(),
        jenkins_build_url: None,
        image_ref: None,
        image_digest_ref: None,
        message: None,
        created_at: now,
        started_at: None,
        finished_at: None,
        source_lease_token_hash: Some(auth::token_hash(&source_lease_token)),
        source_lease_expires_at: Some(DateTime::from_millis(
            now.timestamp_millis() + SOURCE_LEASE_TTL_MILLIS,
        )),
        source_lease_consumed_at: None,
        callback_token_hash: Some(auth::token_hash(&callback_token)),
        callback_token_expires_at: Some(DateTime::from_millis(
            now.timestamp_millis() + CALLBACK_TOKEN_TTL_MILLIS,
        )),
    };
    let build_id = build.id;
    state.application_builds.insert_one(&build).await?;
    let mut result = build.clone();
    if let (Some(base), Some(token)) = (
        state.config.jenkins_url.as_deref(),
        state.config.jenkins_api_token.as_deref(),
    ) {
        let endpoint = jenkins_endpoint(base, &state.config.jenkins_app_job, "buildWithParameters");
        let params = [
            ("APPLICATION_ID", app.id.to_hex()),
            ("BUILD_ID", build_id.to_hex()),
            ("REPOSITORY_URL", app.repository_url.clone()),
            ("GIT_REF", app.git_ref.clone()),
            ("BUILD_MODE", app.build_mode.clone()),
            ("IMAGE_REPOSITORY", image_repository),
            (
                "KUST_CALLBACK_URL",
                callback_url(state, build_id, "callback"),
            ),
            (
                "KUST_CALLBACK_RESOLVE",
                state
                    .config
                    .app_callback_resolve
                    .clone()
                    .unwrap_or_default(),
            ),
            ("KUST_SOURCE_TOKEN", source_lease_token),
            ("KUST_CALLBACK_TOKEN", callback_token),
        ];
        let jenkins_user = state.config.jenkins_user.clone().unwrap_or_default();
        let mut trigger = state
            .http
            .post(endpoint)
            .basic_auth(&jenkins_user, Some(token));
        let crumb_endpoint = format!("{}/crumbIssuer/api/json", base.trim_end_matches('/'));
        if let Ok(crumb_response) = state
            .http
            .get(crumb_endpoint)
            .basic_auth(&jenkins_user, Some(token))
            .send()
            .await
        {
            if let Some(cookies) = jenkins_session_cookie(crumb_response.headers()) {
                trigger = trigger.header(COOKIE, cookies);
            }
            if crumb_response.status().is_success() {
                if let Ok(crumb) = crumb_response.json::<serde_json::Value>().await {
                    if let (Some(field), Some(value)) = (
                        crumb
                            .get("crumbRequestField")
                            .and_then(serde_json::Value::as_str),
                        crumb.get("crumb").and_then(serde_json::Value::as_str),
                    ) {
                        trigger = trigger.header(field, value);
                    }
                }
            }
        }
        let response = match trigger.form(&params).send().await {
            Ok(response) => response,
            Err(error) => {
                result.status = "failed".into();
                result.message = Some(format!("Jenkins trigger failed: {error}"));
                result.finished_at = Some(DateTime::now());
                state
                    .application_builds
                    .replace_one(doc! {"_id": build_id}, &result)
                    .await?;
                return Err(AppError::upstream(format!(
                    "Jenkins request failed: {error}"
                )));
            }
        };
        if !response.status().is_success() {
            let status = response.status();
            result.status = "failed".into();
            result.message = Some(format!("Jenkins returned {status}"));
            result.finished_at = Some(DateTime::now());
            state
                .application_builds
                .replace_one(doc! {"_id": build_id}, &result)
                .await?;
            return Err(AppError::upstream(format!("Jenkins returned {}", status)));
        }
        result.jenkins_build_url = Some(format!(
            "{}/job/{}/",
            base.trim_end_matches('/'),
            state.config.jenkins_app_job.replace('/', "/job/")
        ));
        result.status = "running".into();
        result.started_at = Some(DateTime::now());
        state
            .application_builds
            .replace_one(doc! {"_id": build_id}, &result)
            .await?;
    } else {
        result.message = Some("Jenkins is not configured; build remains queued".into());
        state
            .application_builds
            .replace_one(doc! {"_id": build_id}, &result)
            .await?;
    }
    write_audit(
        state,
        Some(user_id),
        "hosting.deploy.trigger",
        Some(&app.name),
        Some(app.cluster_id),
        json!({"buildId": build_id.to_hex()}),
    )
    .await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(ApplicationBuildResponse::from(result)),
    ))
}

fn callback_url(state: &SharedState, build_id: ObjectId, suffix: &str) -> String {
    let base = state
        .config
        .app_callback_base_url
        .as_deref()
        .unwrap_or(&state.config.frontend_url);
    format!(
        "{}/api/hosting/builds/{}/{}",
        base.trim_end_matches('/'),
        build_id.to_hex(),
        suffix
    )
}

fn require_hosting_write(actor: &auth::AuthenticatedUser) -> Result<(), AppError> {
    if actor
        .user
        .roles
        .iter()
        .any(|role| matches!(role.as_str(), "admin" | "operator"))
    {
        Ok(())
    } else {
        Err(AppError::forbidden(
            "application hosting write permission is required",
        ))
    }
}

fn jenkins_endpoint(base: &str, job: &str, action: &str) -> String {
    let path = job
        .split('/')
        .map(|value| format!("job/{value}"))
        .collect::<Vec<_>>()
        .join("/");
    format!("{}/{path}/{action}", base.trim_end_matches('/'))
}

fn jenkins_session_cookie(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let value = headers
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| value.split(';').next())
        .collect::<Vec<_>>()
        .join("; ");
    (!value.is_empty()).then_some(value)
}

async fn build_callback(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(build_id): Path<String>,
    Json(request): Json<ApplicationBuildCallbackRequest>,
) -> Result<impl IntoResponse, AppError> {
    if !matches!(
        request.status.as_str(),
        "running" | "succeeded" | "failed" | "cancelled"
    ) {
        return Err(AppError::bad_request("build status is invalid"));
    }
    let id = parse_id(&build_id, "build id")?;
    let mut build = state
        .application_builds
        .find_one(doc! {"_id":id})
        .await?
        .ok_or_else(|| AppError::not_found("build was not found"))?;
    require_build_callback_token(&build, &headers)?;
    if !matches!(build.status.as_str(), "queued" | "running") {
        return Err(AppError::conflict("build is already in a terminal state"));
    }
    if request.status == "succeeded" {
        let image = request
            .image_digest_ref
            .as_deref()
            .ok_or_else(|| AppError::bad_request("successful build must include image digest"))?;
        let app = state
            .hosted_applications
            .find_one(doc! {"_id": build.application_id})
            .await?
            .ok_or_else(|| AppError::not_found("application was not found"))?;
        let expected_prefix = state
            .config
            .app_harbor_repository_prefix
            .as_deref()
            .map(|prefix| format!("{}/{}@sha256:", prefix.trim_end_matches('/'), app.slug))
            .ok_or_else(|| {
                AppError::conflict("application Harbor repository prefix is not configured")
            })?;
        if !valid_digest_reference(image, &expected_prefix) {
            return Err(AppError::bad_request(
                "image must be an immutable digest from this application's Harbor repository",
            ));
        }
        // A callback travels through the public gateway, which has a shorter timeout
        // than a Kubernetes rollout. Acknowledge the immutable image immediately and
        // let the API own the longer apply/readiness operation in the background.
        // This keeps a successful Jenkins build from being marked failed solely because
        // the gateway closed a long-running callback response.
        build.status = "running".into();
        build.git_commit = request.git_commit.clone();
        build.image_ref = request.image_ref.clone();
        build.image_digest_ref = request.image_digest_ref.clone();
        build.jenkins_build_url = request.jenkins_build_url.clone();
        build.message =
            Some("Image pushed; Kust is applying controlled Kubernetes resources".into());
        build.callback_token_hash = None;
        build.callback_token_expires_at = None;
        build.started_at.get_or_insert_with(DateTime::now);
        state
            .application_builds
            .replace_one(doc! {"_id": id}, &build)
            .await?;

        let deployment_state = state.clone();
        let deployment_app = app.clone();
        let deployment_image = image.to_string();
        tokio::spawn(async move {
            let result = apply_and_verify_hosted_application(
                &deployment_state,
                &deployment_app,
                &deployment_image,
            )
            .await;

            let (status, message) = match result {
                Ok(()) => (
                    "succeeded",
                    "Deployment, Service, HTTPRoute and public application route are ready"
                        .to_string(),
                ),
                Err(error) => ("failed", format!("Kubernetes deployment failed: {error}")),
            };
            if let Err(error) = deployment_state
                .application_builds
                .update_one(
                    doc! {"_id": id, "status": "running"},
                    doc! {"$set": {"status": status, "message": message, "finished_at": DateTime::now()}},
                )
                .await
            {
                tracing::warn!(%error, build_id = %id.to_hex(), "unable to record hosted application rollout result");
            }
        });

        write_audit(
            &state,
            None,
            "hosting.deploy.callback",
            Some(&build_id),
            None,
            json!({"status": "running"}),
        )
        .await?;
        return Ok(Json(ApplicationBuildResponse::from(build)));
    }
    build.status = request.status.clone();
    build.git_commit = request.git_commit;
    build.image_ref = request.image_ref;
    build.image_digest_ref = request.image_digest_ref.clone();
    build.jenkins_build_url = request.jenkins_build_url;
    build.message = request.message;
    if request.status == "running" {
        build.started_at = Some(DateTime::now());
    }
    if matches!(
        request.status.as_str(),
        "succeeded" | "failed" | "cancelled"
    ) {
        build.finished_at = Some(DateTime::now());
    }
    state
        .application_builds
        .replace_one(doc! {"_id":id}, &build)
        .await?;
    write_audit(
        &state,
        None,
        "hosting.deploy.callback",
        Some(&build_id),
        None,
        json!({"status":request.status}),
    )
    .await?;
    Ok(Json(ApplicationBuildResponse::from(build)))
}

fn valid_digest_reference(value: &str, expected_prefix: &str) -> bool {
    value.starts_with(expected_prefix)
        && value.len() == expected_prefix.len() + 64
        && value[expected_prefix.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
}

async fn build_source(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(build_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let id = parse_id(&build_id, "build id")?;
    let build = state
        .application_builds
        .find_one(doc! {"_id": id})
        .await?
        .ok_or_else(|| AppError::not_found("build was not found"))?;
    require_source_lease_token(&build, &headers)?;
    if !matches!(build.status.as_str(), "queued" | "running") {
        return Err(AppError::conflict("build source is no longer available"));
    }
    let lease = state
        .application_builds
        .update_one(
            doc! {"_id": id, "source_lease_consumed_at": null},
            doc! {"$set": {"source_lease_consumed_at": DateTime::now()}},
        )
        .await?;
    if lease.modified_count != 1 {
        return Err(AppError::conflict(
            "build source lease has already been consumed",
        ));
    }
    let application = state
        .hosted_applications
        .find_one(doc! {"_id": build.application_id})
        .await?
        .ok_or_else(|| AppError::not_found("application was not found"))?;
    let credential = if let Some(id) = application.credential_id {
        let credential = state
            .git_credentials
            .find_one(doc! {"_id": id})
            .await?
            .ok_or_else(|| AppError::not_found("source credential was not found"))?;
        Some(json!({
            "type": credential.credential_type,
            "username": credential.username,
            "secret": state.secrets.decrypt(&credential.secret_encrypted)?,
        }))
    } else {
        None
    };
    Ok(Json(json!({
        "repositoryUrl": application.repository_url,
        "gitRef": build.git_ref,
        "sourceSubdirectory": application.source_subdirectory,
        "buildCommand": application.build_command,
        "outputDirectory": application.output_directory,
        "buildEnvironment": application.build_environment,
        "credential": credential,
    })))
}

fn supplied_build_token(headers: &HeaderMap) -> &str {
    headers
        .get("x-kust-build-token")
        .and_then(|value| value.to_str().ok())
        .or_else(|| {
            headers
                .get(AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
        })
        .unwrap_or_default()
}

fn require_source_lease_token(
    build: &ApplicationBuildDocument,
    headers: &HeaderMap,
) -> Result<(), AppError> {
    let expected = build
        .source_lease_token_hash
        .as_deref()
        .ok_or_else(|| AppError::forbidden("build source lease is unavailable"))?;
    if build.source_lease_consumed_at.is_some()
        || build
            .source_lease_expires_at
            .is_none_or(|expires_at| expires_at < DateTime::now())
        || auth::token_hash(supplied_build_token(headers)) != expected
    {
        return Err(AppError::unauthorized(
            "invalid or expired build source lease",
        ));
    }
    Ok(())
}

fn require_build_callback_token(
    build: &ApplicationBuildDocument,
    headers: &HeaderMap,
) -> Result<(), AppError> {
    let expected = build
        .callback_token_hash
        .as_deref()
        .ok_or_else(|| AppError::forbidden("build callbacks are unavailable"))?;
    if build
        .callback_token_expires_at
        .is_none_or(|expires_at| expires_at < DateTime::now())
        || auth::token_hash(supplied_build_token(headers)) != expected
    {
        return Err(AppError::unauthorized(
            "invalid or expired build callback token",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        jenkins_session_cookie, slugify, valid_digest_reference, valid_dns_label, validate_git_ref,
        validate_relative_directory, validate_repository,
    };

    #[test]
    fn creates_rfc1123_application_slugs() {
        assert_eq!(slugify("Orders Web V2!"), "orders-web-v2");
        assert!(valid_dns_label(&slugify("Orders Web V2!")));
        assert!(!valid_dns_label("-invalid"));
    }

    #[test]
    fn accepts_supported_repository_urls_without_embedded_secrets() {
        assert!(validate_repository("https://gitlab.example.com/team/service.git").is_ok());
        assert!(validate_repository("ssh://git@gitlab.example.com/team/service.git").is_ok());
        assert_eq!(
            validate_repository("git@gitlab.example.com:team/service.git").unwrap(),
            "ssh://git@gitlab.example.com/team/service.git"
        );
        assert!(validate_repository("https://token@gitlab.example.com/team/service.git").is_err());
        assert!(
            validate_repository("https://token:secret@gitlab.example.com/team/service.git")
                .is_err()
        );
        assert!(validate_repository("file:///tmp/service").is_err());
        assert!(validate_repository("https://127.0.0.1/team/service.git").is_err());
        assert!(validate_repository("https://gitlab.local/team/service.git").is_err());
        assert!(validate_repository("https://github.com/linuxserver/docker-code-serverhttps://github.com/linuxserver/docker-code-server").is_err());
    }

    #[test]
    fn callback_images_are_pinned_to_the_application_repository() {
        let prefix = "10.17.158.118/kust-apps/demo@sha256:";
        assert!(valid_digest_reference("10.17.158.118/kust-apps/demo@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", prefix));
        assert!(!valid_digest_reference("10.17.158.118/kust-apps/other@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", prefix));
    }

    #[test]
    fn reserves_the_platform_route_prefix() {
        assert_eq!(
            super::normalized_route_path("/apps", "/", "demo-web").unwrap(),
            "/apps/demo-web"
        );
        assert!(super::normalized_route_path("/apps", "/kust", "demo-web").is_err());
        assert!(super::validate_source_subdirectory(Some("../secrets")).is_err());
    }

    #[test]
    fn rejects_build_inputs_that_escape_the_checkout() {
        assert!(validate_git_ref("main").is_ok());
        assert!(validate_git_ref("refs/tags/v1.2.3").is_ok());
        assert!(validate_git_ref("--upload-pack=bad").is_err());
        assert!(validate_git_ref("release..candidate").is_err());
        assert!(validate_relative_directory(Some("dist/client"), "output directory").is_ok());
        assert!(validate_relative_directory(Some("../secrets"), "output directory").is_err());
    }

    #[test]
    fn public_route_verification_uses_a_trailing_app_path() {
        assert_eq!(
            super::public_route_url(
                "http://traefik.traefik-system.svc.cluster.local",
                "/apps/demo"
            )
            .unwrap()
            .as_str(),
            "http://traefik.traefik-system.svc.cluster.local/apps/demo/"
        );
        assert!(super::public_route_url("not a URL", "/apps/demo").is_err());
    }

    #[test]
    fn forwards_only_jenkins_cookie_pairs_with_the_crumb() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.append(
            reqwest::header::SET_COOKIE,
            "JSESSIONID=node0; Path=/; HttpOnly".parse().unwrap(),
        );
        headers.append(
            reqwest::header::SET_COOKIE,
            "jenkins-timestamper-offset=1; Path=/".parse().unwrap(),
        );
        assert_eq!(
            jenkins_session_cookie(&headers).as_deref(),
            Some("JSESSIONID=node0; jenkins-timestamper-offset=1")
        );
    }
}
