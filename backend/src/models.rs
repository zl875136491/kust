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
    pub created_at: DateTime,
    pub updated_at: DateTime,
    pub last_connected_at: Option<DateTime>,
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
}

impl From<ClusterDocument> for ClusterResponse {
    fn from(value: ClusterDocument) -> Self {
        let status = if value.last_connected_at.is_some() {
            "connected"
        } else {
            "unknown"
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
        }
    }
}

#[derive(Clone, Debug, Serialize)]
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
    pub details: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceListResponse {
    pub kind: String,
    pub items: Vec<ResourceRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewResponse {
    pub cpu_percent: Option<f64>,
    pub memory_percent: Option<f64>,
    pub pods: StatusCount,
    pub nodes: StatusCount,
    pub workloads: Vec<ResourceRow>,
    pub events: Vec<ResourceRow>,
}

#[derive(Debug, Serialize)]
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
}
