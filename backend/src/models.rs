use std::collections::BTreeMap;

use mongodb::bson::{oid::ObjectId, DateTime};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClusterDocument {
    #[serde(rename = "_id")]
    pub id: ObjectId,
    pub name: String,
    pub description: String,
    pub context: String,
    pub server: String,
    pub kubernetes_version: Option<String>,
    pub kubeconfig_encrypted: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub preset_key: Option<String>,
    #[serde(default)]
    pub owner_user_id: Option<ObjectId>,
    #[serde(default)]
    pub member_user_ids: Vec<ObjectId>,
    pub created_at: DateTime,
    pub updated_at: DateTime,
    pub last_connected_at: Option<DateTime>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GitCredentialDocument {
    #[serde(rename = "_id")]
    pub id: ObjectId,
    pub owner_user_id: ObjectId,
    pub name: String,
    pub credential_type: String,
    pub username: Option<String>,
    pub secret_encrypted: String,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCredentialResponse {
    pub id: String,
    pub name: String,
    pub credential_type: String,
    pub username: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<GitCredentialDocument> for GitCredentialResponse {
    fn from(value: GitCredentialDocument) -> Self {
        Self {
            id: value.id.to_hex(),
            name: value.name,
            credential_type: value.credential_type,
            username: value.username,
            created_at: value.created_at.try_to_rfc3339_string().unwrap_or_default(),
            updated_at: value.updated_at.try_to_rfc3339_string().unwrap_or_default(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HostedApplicationDocument {
    #[serde(rename = "_id")]
    pub id: ObjectId,
    pub owner_user_id: ObjectId,
    #[serde(default)]
    pub member_user_ids: Vec<ObjectId>,
    pub name: String,
    pub slug: String,
    pub repository_url: String,
    pub git_ref: String,
    pub credential_id: Option<ObjectId>,
    pub build_mode: String,
    pub source_subdirectory: Option<String>,
    pub build_command: Option<String>,
    pub output_directory: Option<String>,
    pub container_port: i32,
    pub health_path: String,
    pub cluster_id: ObjectId,
    pub namespace: String,
    pub replicas: i32,
    pub cpu_request: String,
    pub memory_request: String,
    pub cpu_limit: String,
    pub memory_limit: String,
    pub route_host: String,
    pub route_path: String,
    pub gateway_name: String,
    pub gateway_namespace: String,
    #[serde(default)]
    pub auto_deploy: bool,
    #[serde(default)]
    pub webhook_secret_encrypted: Option<String>,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApplicationBuildDocument {
    #[serde(rename = "_id")]
    pub id: ObjectId,
    pub application_id: ObjectId,
    pub triggered_by_user_id: Option<ObjectId>,
    pub git_commit: Option<String>,
    pub git_ref: String,
    pub status: String,
    pub jenkins_build_url: Option<String>,
    pub image_ref: Option<String>,
    pub image_digest_ref: Option<String>,
    pub message: Option<String>,
    #[serde(default)]
    pub source_lease_token_hash: Option<String>,
    #[serde(default)]
    pub source_lease_expires_at: Option<DateTime>,
    #[serde(default)]
    pub source_lease_consumed_at: Option<DateTime>,
    #[serde(default)]
    pub callback_token_hash: Option<String>,
    #[serde(default)]
    pub callback_token_expires_at: Option<DateTime>,
    pub created_at: DateTime,
    pub started_at: Option<DateTime>,
    pub finished_at: Option<DateTime>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedApplicationResponse {
    pub id: String,
    pub owner_user_id: String,
    pub name: String,
    pub slug: String,
    pub repository_url: String,
    pub git_ref: String,
    pub credential_id: Option<String>,
    pub build_mode: String,
    pub source_subdirectory: Option<String>,
    pub build_command: Option<String>,
    pub output_directory: Option<String>,
    pub container_port: i32,
    pub health_path: String,
    pub cluster_id: String,
    pub namespace: String,
    pub replicas: i32,
    pub cpu_request: String,
    pub memory_request: String,
    pub cpu_limit: String,
    pub memory_limit: String,
    pub route_host: String,
    pub route_path: String,
    pub gateway_name: String,
    pub gateway_namespace: String,
    pub auto_deploy: bool,
    pub webhook_configured: bool,
    pub created_at: String,
    pub updated_at: String,
    pub latest_build: Option<ApplicationBuildResponse>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationBuildResponse {
    pub id: String,
    pub application_id: String,
    pub git_commit: Option<String>,
    pub git_ref: String,
    pub status: String,
    pub jenkins_build_url: Option<String>,
    pub image_ref: Option<String>,
    pub image_digest_ref: Option<String>,
    pub message: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

impl From<ApplicationBuildDocument> for ApplicationBuildResponse {
    fn from(value: ApplicationBuildDocument) -> Self {
        Self {
            id: value.id.to_hex(),
            application_id: value.application_id.to_hex(),
            git_commit: value.git_commit,
            git_ref: value.git_ref,
            status: value.status,
            jenkins_build_url: value.jenkins_build_url,
            image_ref: value.image_ref,
            image_digest_ref: value.image_digest_ref,
            message: value.message,
            created_at: value.created_at.try_to_rfc3339_string().unwrap_or_default(),
            started_at: value
                .started_at
                .and_then(|value| value.try_to_rfc3339_string().ok()),
            finished_at: value
                .finished_at
                .and_then(|value| value.try_to_rfc3339_string().ok()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGitCredentialRequest {
    pub name: String,
    pub credential_type: String,
    pub username: Option<String>,
    pub secret: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateHostedApplicationRequest {
    pub name: String,
    pub repository_url: String,
    #[serde(default = "default_git_ref")]
    pub git_ref: String,
    pub credential_id: Option<String>,
    #[serde(default = "default_build_mode")]
    pub build_mode: String,
    pub source_subdirectory: Option<String>,
    pub build_command: Option<String>,
    pub output_directory: Option<String>,
    #[serde(default = "default_container_port")]
    pub container_port: i32,
    #[serde(default = "default_health_path")]
    pub health_path: String,
    pub cluster_id: String,
    #[serde(default = "default_namespace")]
    pub namespace: String,
    #[serde(default = "default_replicas")]
    pub replicas: i32,
    #[serde(default = "default_cpu_request")]
    pub cpu_request: String,
    #[serde(default = "default_memory_request")]
    pub memory_request: String,
    #[serde(default = "default_cpu_limit")]
    pub cpu_limit: String,
    #[serde(default = "default_memory_limit")]
    pub memory_limit: String,
    pub route_host: Option<String>,
    pub route_path: String,
    pub gateway_name: Option<String>,
    pub gateway_namespace: Option<String>,
    #[serde(default)]
    pub auto_deploy: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateHostedApplicationRequest {
    pub git_ref: Option<String>,
    pub build_mode: Option<String>,
    pub source_subdirectory: Option<String>,
    pub build_command: Option<String>,
    pub output_directory: Option<String>,
    pub container_port: Option<i32>,
    pub health_path: Option<String>,
    pub replicas: Option<i32>,
    pub cpu_request: Option<String>,
    pub memory_request: Option<String>,
    pub cpu_limit: Option<String>,
    pub memory_limit: Option<String>,
    pub route_path: Option<String>,
    pub auto_deploy: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationBuildCallbackRequest {
    pub status: String,
    pub git_commit: Option<String>,
    pub image_ref: Option<String>,
    pub image_digest_ref: Option<String>,
    pub jenkins_build_url: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationWebhookResponse {
    pub url: String,
    pub secret: String,
}

fn default_git_ref() -> String {
    "main".into()
}
fn default_build_mode() -> String {
    "dockerfile".into()
}
fn default_container_port() -> i32 {
    8080
}
fn default_health_path() -> String {
    "/".into()
}
fn default_namespace() -> String {
    "default".into()
}
fn default_replicas() -> i32 {
    1
}
fn default_cpu_request() -> String {
    "100m".into()
}
fn default_memory_request() -> String {
    "128Mi".into()
}
fn default_cpu_limit() -> String {
    "500m".into()
}
fn default_memory_limit() -> String {
    "512Mi".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogDocument {
    #[serde(rename = "_id")]
    pub id: ObjectId,
    pub actor_user_id: Option<ObjectId>,
    pub action: String,
    pub target: Option<String>,
    pub cluster_id: Option<ObjectId>,
    pub metadata: serde_json::Value,
    pub created_at: DateTime,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditQuery {
    pub action: Option<String>,
    pub user_id: Option<String>,
    pub cluster_id: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogResponse {
    pub id: String,
    pub actor_user_id: Option<String>,
    pub action: String,
    pub target: Option<String>,
    pub cluster_id: Option<String>,
    pub metadata: serde_json::Value,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationDocument {
    #[serde(rename = "_id")]
    pub id: ObjectId,
    pub user_id: ObjectId,
    pub cluster_id: Option<ObjectId>,
    pub kind: String,
    pub resource_name: Option<String>,
    pub severity: String,
    pub title: String,
    pub message: String,
    pub read_at: Option<DateTime>,
    pub created_at: DateTime,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationResponse {
    pub id: String,
    pub cluster_id: Option<String>,
    pub kind: String,
    pub resource_name: Option<String>,
    pub severity: String,
    pub title: String,
    pub message: String,
    pub read_at: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryResourceResponse {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub resource: String,
    pub namespaced: bool,
    pub verbs: Vec<String>,
}

impl From<NotificationDocument> for NotificationResponse {
    fn from(value: NotificationDocument) -> Self {
        Self {
            id: value.id.to_hex(),
            cluster_id: value.cluster_id.map(|id| id.to_hex()),
            kind: value.kind,
            resource_name: value.resource_name,
            severity: value.severity,
            title: value.title,
            message: value.message,
            read_at: value
                .read_at
                .and_then(|date| date.try_to_rfc3339_string().ok()),
            created_at: value.created_at.try_to_rfc3339_string().unwrap_or_default(),
        }
    }
}

impl From<AuditLogDocument> for AuditLogResponse {
    fn from(value: AuditLogDocument) -> Self {
        Self {
            id: value.id.to_hex(),
            actor_user_id: value.actor_user_id.map(|id| id.to_hex()),
            action: value.action,
            target: value.target,
            cluster_id: value.cluster_id.map(|id| id.to_hex()),
            metadata: value.metadata,
            created_at: value.created_at.try_to_rfc3339_string().unwrap_or_default(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateClusterRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub context: Option<String>,
    pub kubeconfig: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateClusterRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub context: Option<String>,
    pub kubeconfig: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateClusterMembersRequest {
    pub user_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterResponse {
    pub id: String,
    pub name: String,
    pub description: String,
    pub context: String,
    pub server: String,
    pub kubernetes_version: Option<String>,
    pub status: String,
    pub created_at: String,
    pub last_connected_at: Option<String>,
    #[serde(default)]
    pub preset: bool,
    pub read_only: bool,
    pub source: String,
    #[serde(default)]
    pub member_count: usize,
}

impl From<ClusterDocument> for ClusterResponse {
    fn from(value: ClusterDocument) -> Self {
        let status = if value.last_connected_at.is_some() {
            "connected"
        } else {
            "unknown"
        };
        let source = if value.source.is_empty() {
            "user".to_string()
        } else {
            value.source.clone()
        };
        Self {
            id: value.id.to_hex(),
            name: value.name,
            description: value.description,
            context: value.context,
            server: value.server,
            kubernetes_version: value.kubernetes_version,
            status: status.into(),
            created_at: value.created_at.try_to_rfc3339_string().unwrap_or_default(),
            last_connected_at: value
                .last_connected_at
                .and_then(|date| date.try_to_rfc3339_string().ok()),
            preset: source == "preset",
            read_only: value.read_only,
            source,
            member_count: value.member_user_ids.len() + usize::from(value.owner_user_id.is_some()),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReference {
    pub api_version: String,
    pub kind: String,
    pub name: String,
    pub uid: String,
    #[serde(default)]
    pub controller: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRow {
    pub uid: String,
    pub name: String,
    pub namespace: Option<String>,
    pub kind: String,
    pub status: String,
    pub ready: Option<String>,
    pub restarts: Option<i32>,
    pub created_at: Option<String>,
    pub node: Option<String>,
    pub labels: BTreeMap<String, String>,
    #[serde(default)]
    pub annotations: BTreeMap<String, String>,
    #[serde(default)]
    pub owner_references: Vec<ResourceReference>,
    #[serde(default)]
    pub generation: Option<i64>,
    #[serde(default)]
    pub resource_version: Option<String>,
    pub details: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceListResponse {
    pub kind: String,
    pub items: Vec<ResourceRow>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewResponse {
    pub cpu_percent: Option<f64>,
    pub memory_percent: Option<f64>,
    pub pods: StatusCount,
    pub nodes: StatusCount,
    pub workloads: Vec<ResourceRow>,
    pub events: Vec<ResourceRow>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSummaryResponse {
    pub available: bool,
    pub cpu_millicores: i64,
    pub memory_bytes: i64,
    pub nodes: usize,
    pub pods: usize,
    pub collected_at: String,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusCount {
    pub healthy: usize,
    pub total: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceQuery {
    pub namespace: Option<String>,
    pub label_selector: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResourceRequest {
    pub yaml: String,
    pub namespace: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResourceResponse {
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ScaleRequest {
    pub replicas: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsQuery {
    pub container: Option<String>,
    pub tail_lines: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct LogsResponse {
    pub logs: String,
}

#[derive(Debug, Serialize)]
pub struct YamlResponse {
    pub yaml: String,
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub database: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: Option<u64>,
    pub mode: Option<String>,
    pub modified_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeResponse {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentResponse {
    pub path: String,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileQuery {
    pub path: String,
    pub container: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteRequest {
    pub path: String,
    pub content: String,
    pub container: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryRequest {
    pub path: String,
    pub container: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellQuery {
    pub container: Option<String>,
    pub access_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodContainersResponse {
    pub containers: Vec<String>,
    pub init_containers: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResourceSnapshotDocument {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    pub cluster_id: ObjectId,
    pub kind: String,
    pub response: ResourceListResponse,
    pub synced_at: DateTime,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RoleDocument {
    #[serde(rename = "_id")]
    pub id: ObjectId,
    pub name: String,
    pub label: String,
    pub permissions: Vec<String>,
    pub built_in: bool,
    pub created_at: DateTime,
    pub updated_at: DateTime,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UserDocument {
    #[serde(rename = "_id")]
    pub id: ObjectId,
    pub username: String,
    pub display_name: String,
    pub real_name: String,
    pub email: Option<String>,
    pub itcode: Option<String>,
    pub source: String,
    pub password_hash: String,
    pub password_unset: bool,
    pub roles: Vec<String>,
    pub disabled: bool,
    pub totp_secret_encrypted: Option<String>,
    pub totp_enabled: bool,
    pub totp_required_since: Option<DateTime>,
    pub two_factor_remember_days: i32,
    pub created_at: DateTime,
    pub updated_at: DateTime,
    pub last_login_at: Option<DateTime>,
}

impl UserDocument {
    pub fn is_admin(&self) -> bool {
        self.roles.iter().any(|role| role == "admin")
    }

    pub fn response(&self) -> UserResponse {
        UserResponse {
            id: self.id.to_hex(),
            username: self.username.clone(),
            display_name: self.display_name.clone(),
            real_name: self.real_name.clone(),
            email: self.email.clone(),
            itcode: self.itcode.clone(),
            source: self.source.clone(),
            roles: self.roles.clone(),
            disabled: self.disabled,
            password_unset: self.password_unset,
            two_factor_enabled: self.totp_enabled,
            two_factor_required: self.is_admin(),
            two_factor_remember_days: self.two_factor_remember_days,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleResponse {
    pub id: String,
    pub name: String,
    pub label: String,
    pub permissions: Vec<String>,
    pub built_in: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl RoleDocument {
    pub fn response(&self) -> RoleResponse {
        RoleResponse {
            id: self.id.to_hex(),
            name: self.name.clone(),
            label: self.label.clone(),
            permissions: self.permissions.clone(),
            built_in: self.built_in,
            created_at: self.created_at.try_to_rfc3339_string().unwrap_or_default(),
            updated_at: self.updated_at.try_to_rfc3339_string().unwrap_or_default(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserResponse {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub real_name: String,
    pub email: Option<String>,
    pub itcode: Option<String>,
    pub source: String,
    pub roles: Vec<String>,
    pub disabled: bool,
    pub password_unset: bool,
    pub two_factor_enabled: bool,
    pub two_factor_required: bool,
    pub two_factor_remember_days: i32,
}

fn default_enabled() -> bool {
    true
}

fn default_role() -> String {
    "viewer".into()
}

fn default_cache_ttl_seconds() -> i64 {
    45
}

fn default_cache_sync_seconds() -> i64 {
    60
}

fn default_session_timeout_hours() -> i64 {
    12
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlatformSettingsDocument {
    #[serde(rename = "_id")]
    pub id: String,
    #[serde(default = "default_enabled")]
    pub registration_enabled: bool,
    #[serde(default = "default_enabled")]
    pub oa_login_enabled: bool,
    #[serde(default = "default_role")]
    pub default_role: String,
    #[serde(default = "default_cache_ttl_seconds")]
    pub cache_ttl_seconds: i64,
    #[serde(default = "default_cache_sync_seconds")]
    pub cache_sync_seconds: i64,
    #[serde(default = "default_session_timeout_hours")]
    pub session_timeout_hours: i64,
    pub updated_at: DateTime,
    #[serde(default)]
    pub updated_by: Option<ObjectId>,
}

impl PlatformSettingsDocument {
    pub fn response(&self, oa_user_source_configured: bool) -> PlatformSettingsResponse {
        PlatformSettingsResponse {
            registration_enabled: self.registration_enabled,
            oa_login_enabled: self.oa_login_enabled && oa_user_source_configured,
            default_role: self.default_role.clone(),
            cache_ttl_seconds: self.cache_ttl_seconds,
            cache_sync_seconds: self.cache_sync_seconds,
            session_timeout_hours: self.session_timeout_hours,
            oa_user_source_configured,
            preset_clusters_read_only: true,
            updated_at: self.updated_at.try_to_rfc3339_string().unwrap_or_default(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformSettingsResponse {
    pub registration_enabled: bool,
    pub oa_login_enabled: bool,
    pub default_role: String,
    pub cache_ttl_seconds: i64,
    pub cache_sync_seconds: i64,
    pub session_timeout_hours: i64,
    pub oa_user_source_configured: bool,
    pub preset_clusters_read_only: bool,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePlatformSettingsRequest {
    pub registration_enabled: bool,
    pub oa_login_enabled: bool,
    pub default_role: String,
    pub cache_ttl_seconds: i64,
    pub cache_sync_seconds: i64,
    pub session_timeout_hours: i64,
}

#[derive(Debug, Deserialize)]
pub struct UserStatusRequest {
    pub disabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionDocument {
    #[serde(rename = "_id")]
    pub id: ObjectId,
    pub token_hash: String,
    pub user_id: ObjectId,
    pub stage: String,
    pub created_at: DateTime,
    pub expires_at: DateTime,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrustedDeviceDocument {
    #[serde(rename = "_id")]
    pub id: ObjectId,
    pub token_hash: String,
    pub user_id: ObjectId,
    pub created_at: DateTime,
    pub expires_at: DateTime,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuthCodeDocument {
    #[serde(rename = "_id")]
    pub id: ObjectId,
    pub code_hash: String,
    pub user_id: ObjectId,
    pub purpose: String,
    pub created_at: DateTime,
    pub expires_at: DateTime,
    pub used_at: Option<DateTime>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UserSettingsDocument {
    #[serde(rename = "_id")]
    pub id: ObjectId,
    pub user_id: ObjectId,
    pub theme: String,
    #[serde(default = "default_shell_theme")]
    pub shell_theme: String,
    pub pointer_highlight: bool,
    pub refraction: bool,
    pub backdrop_blur: bool,
    pub hover_motion: bool,
    pub auto_refresh: bool,
    pub page_size: i32,
    #[serde(default = "default_window_close_confirmation")]
    pub window_close_confirmation: bool,
    #[serde(default)]
    pub visual_effects_version: i32,
    pub updated_at: DateTime,
}

pub const USER_SETTINGS_VISUAL_EFFECTS_VERSION: i32 = 1;

fn default_window_close_confirmation() -> bool {
    true
}

fn default_shell_theme() -> String {
    "system".into()
}

impl UserSettingsDocument {
    pub fn new(user_id: ObjectId) -> Self {
        Self {
            id: ObjectId::new(),
            user_id,
            theme: "system".into(),
            shell_theme: default_shell_theme(),
            pointer_highlight: false,
            refraction: false,
            backdrop_blur: true,
            hover_motion: true,
            auto_refresh: true,
            page_size: 25,
            window_close_confirmation: true,
            visual_effects_version: USER_SETTINGS_VISUAL_EFFECTS_VERSION,
            updated_at: DateTime::now(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSettingsResponse {
    pub theme: String,
    pub shell_theme: String,
    pub pointer_highlight: bool,
    pub refraction: bool,
    pub backdrop_blur: bool,
    pub hover_motion: bool,
    pub auto_refresh: bool,
    pub page_size: i32,
    pub window_close_confirmation: bool,
    pub two_factor_enabled: bool,
    pub two_factor_required: bool,
    pub two_factor_remember_days: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsRequest {
    pub theme: String,
    #[serde(default = "default_shell_theme")]
    pub shell_theme: String,
    pub pointer_highlight: bool,
    pub refraction: bool,
    pub backdrop_blur: bool,
    pub hover_motion: bool,
    pub auto_refresh: bool,
    pub page_size: i32,
    pub window_close_confirmation: bool,
    pub two_factor_enabled: bool,
    pub two_factor_remember_days: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
    pub password_confirmation: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationProfileResponse {
    pub username: String,
    pub display_name: String,
    pub real_name: String,
    pub email: Option<String>,
    pub itcode: String,
    pub source: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct CodeLoginRequest {
    pub username: String,
    pub code: String,
}

#[derive(Debug, Deserialize)]
pub struct UsernameRequest {
    pub username: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetPasswordRequest {
    pub username: String,
    pub code: String,
    pub new_password: String,
}

#[derive(Debug, Deserialize)]
pub struct TotpVerifyRequest {
    pub code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStateResponse {
    pub user: UserResponse,
    pub next: String,
    pub token: Option<String>,
    pub trusted_device_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCapabilitiesResponse {
    pub registration_enabled: bool,
    pub oa_login_enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpSetupResponse {
    pub secret: String,
    pub uri: String,
}

#[derive(Debug, Deserialize)]
pub struct RoleUpdateRequest {
    pub roles: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub q: String,
    pub cluster_id: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub category: String,
    pub cluster_id: Option<String>,
    pub path: String,
    pub status: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMapNode {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub status: String,
    pub group: String,
    pub resource_kind: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMapEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub relation: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMapResponse {
    pub nodes: Vec<ResourceMapNode>,
    pub edges: Vec<ResourceMapEdge>,
    pub synced_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{UserSettingsDocument, USER_SETTINGS_VISUAL_EFFECTS_VERSION};
    use mongodb::bson::oid::ObjectId;

    #[test]
    fn new_user_settings_use_performance_safe_visual_defaults() {
        let settings = UserSettingsDocument::new(ObjectId::new());

        assert!(!settings.pointer_highlight);
        assert!(!settings.refraction);
        assert!(settings.backdrop_blur);
        assert!(settings.hover_motion);
        assert_eq!(settings.shell_theme, "system");
        assert_eq!(
            settings.visual_effects_version,
            USER_SETTINGS_VISUAL_EFFECTS_VERSION
        );
    }
}
