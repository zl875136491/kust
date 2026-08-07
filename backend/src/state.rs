use std::{fs, path::Path, sync::Arc};

use futures::TryStreamExt;
use kube::{config::KubeConfigOptions, Client, Config};
use mongodb::{
    bson::{doc, oid::ObjectId, DateTime},
    Collection, Database,
};

use crate::{
    config::AppConfig,
    crypto::SecretBox,
    error::AppError,
    models::{
        ApplicationBuildDocument, AuthCodeDocument, ClusterDocument, GitCredentialDocument,
        HostedApplicationDocument, PlatformSettingsDocument, ResourceSnapshotDocument,
        RoleDocument, SessionDocument, TrustedDeviceDocument, UserDocument, UserSettingsDocument,
    },
};

#[derive(Clone, Debug)]
pub struct PresetCluster {
    pub preset_key: String,
    pub name: String,
    pub description: String,
    pub context: String,
    pub server: String,
    pub kubeconfig: String,
}

#[derive(Clone)]
pub struct AppState {
    pub database: Database,
    pub clusters: Collection<ClusterDocument>,
    pub resource_snapshots: Collection<ResourceSnapshotDocument>,
    pub users: Collection<UserDocument>,
    pub roles: Collection<RoleDocument>,
    pub sessions: Collection<SessionDocument>,
    pub trusted_devices: Collection<TrustedDeviceDocument>,
    pub auth_codes: Collection<AuthCodeDocument>,
    pub user_settings: Collection<UserSettingsDocument>,
    pub platform_settings: Collection<PlatformSettingsDocument>,
    pub notifications: Collection<crate::models::NotificationDocument>,
    pub git_credentials: Collection<GitCredentialDocument>,
    pub hosted_applications: Collection<HostedApplicationDocument>,
    pub application_builds: Collection<ApplicationBuildDocument>,
    pub platform_config: Arc<tokio::sync::RwLock<PlatformSettingsDocument>>,
    pub secrets: SecretBox,
    pub config: Arc<AppConfig>,
    pub http: reqwest::Client,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub async fn cluster(&self, id: &str) -> Result<ClusterDocument, AppError> {
        let object_id =
            ObjectId::parse_str(id).map_err(|_| AppError::bad_request("cluster id is invalid"))?;
        self.clusters
            .find_one(doc! { "_id": object_id })
            .await?
            .ok_or_else(|| AppError::not_found("cluster was not found"))
    }

    pub async fn kube_client(&self, id: &str) -> Result<Client, AppError> {
        let cluster = self.cluster(id).await?;
        let kubeconfig_yaml = self.secrets.decrypt(&cluster.kubeconfig_encrypted)?;
        client_from_kubeconfig(&kubeconfig_yaml, Some(cluster.context)).await
    }
}

pub async fn sync_preset_clusters(
    state: &SharedState,
    presets: Vec<PresetCluster>,
) -> Result<usize, AppError> {
    let mut active_keys = Vec::with_capacity(presets.len());
    for preset in presets {
        active_keys.push(preset.preset_key.clone());
        let existing_by_key = state
            .clusters
            .find_one(doc! { "preset_key": &preset.preset_key })
            .await?;
        let existing = match existing_by_key {
            Some(cluster) => Some(cluster),
            None => {
                state
                    .clusters
                    .find_one(doc! {
                        "name": &preset.name,
                        "$or": [
                            { "source": "preset" },
                            { "read_only": true }
                        ]
                    })
                    .await?
            }
        };
        let now = DateTime::now();
        let document = ClusterDocument {
            id: existing
                .as_ref()
                .map(|value| value.id)
                .unwrap_or_else(ObjectId::new),
            name: preset.name,
            description: preset.description,
            context: preset.context,
            server: preset.server,
            kubernetes_version: existing
                .as_ref()
                .and_then(|value| value.kubernetes_version.clone()),
            kubeconfig_encrypted: state.secrets.encrypt(&preset.kubeconfig)?,
            source: "preset".into(),
            read_only: true,
            preset_key: Some(preset.preset_key),
            owner_user_id: None,
            member_user_ids: Vec::new(),
            created_at: existing
                .as_ref()
                .map(|value| value.created_at)
                .unwrap_or(now),
            updated_at: now,
            last_connected_at: existing.and_then(|value| value.last_connected_at),
        };
        state
            .clusters
            .replace_one(doc! { "_id": document.id }, &document)
            .upsert(true)
            .await?;
    }

    let active_count = active_keys.len();
    let filter = if active_keys.is_empty() {
        doc! { "source": "preset" }
    } else {
        doc! { "source": "preset", "preset_key": { "$nin": active_keys } }
    };
    let stale: Vec<ClusterDocument> = state
        .clusters
        .find(filter.clone())
        .await?
        .try_collect()
        .await?;
    for cluster in &stale {
        state
            .resource_snapshots
            .delete_many(doc! { "cluster_id": cluster.id })
            .await?;
    }
    state.clusters.delete_many(filter).await?;
    Ok(active_count)
}

pub fn load_preset_clusters(path: &Path) -> Result<Vec<PresetCluster>, String> {
    let files = if path.is_file() {
        vec![path.to_path_buf()]
    } else if path.is_dir() {
        let mut files = fs::read_dir(path)
            .map_err(|error| {
                format!(
                    "unable to read preset config directory {}: {error}",
                    path.display()
                )
            })?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|entry| entry.is_file())
            .filter(
                |entry| match entry.extension().and_then(|value| value.to_str()) {
                    None => true,
                    Some(extension) => matches!(extension, "yaml" | "yml"),
                },
            )
            .collect::<Vec<_>>();
        files.sort();
        files
    } else {
        return Ok(Vec::new());
    };

    let mut presets = Vec::new();
    for file in files {
        let yaml = fs::read_to_string(&file)
            .map_err(|error| format!("unable to read preset config {}: {error}", file.display()))?;
        let config = kube::config::Kubeconfig::from_yaml(&yaml)
            .map_err(|error| format!("preset config {} is invalid: {error}", file.display()))?;
        let single_context = config.contexts.len() == 1;
        let file_label = file
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("预设配置");
        for context in &config.contexts {
            let context_name = context.name.clone();
            let Some(context_data) = context.context.as_ref() else {
                continue;
            };
            let Some(cluster_name) =
                (!context_data.cluster.is_empty()).then_some(context_data.cluster.as_str())
            else {
                continue;
            };
            let Some(cluster_data) = config
                .clusters
                .iter()
                .find(|item| item.name == cluster_name)
                .and_then(|item| item.cluster.as_ref())
            else {
                continue;
            };
            let Some(server) = cluster_data.server.clone() else {
                continue;
            };
            presets.push(PresetCluster {
                preset_key: stable_id(&file, &context_name),
                name: if single_context {
                    file_label.to_string()
                } else {
                    context_name.clone()
                },
                description: format!(
                    "预设配置 · {}",
                    file.file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("config")
                ),
                context: context_name,
                server,
                kubeconfig: yaml.clone(),
            });
        }
    }
    Ok(presets)
}

fn stable_id(path: &Path, context: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update([0]);
    hasher.update(context.as_bytes());
    hex::encode(&hasher.finalize()[..12])
}

pub async fn client_from_kubeconfig(
    yaml: &str,
    context: Option<String>,
) -> Result<Client, AppError> {
    let kubeconfig = kube::config::Kubeconfig::from_yaml(yaml)
        .map_err(|error| AppError::bad_request(format!("kubeconfig is invalid: {error}")))?;
    let context = context.or_else(|| kubeconfig.current_context.clone());
    let options = KubeConfigOptions {
        context,
        ..Default::default()
    };
    let config = Config::from_custom_kubeconfig(kubeconfig, &options)
        .await
        .map_err(|error| AppError::bad_request(format!("unable to load kubeconfig: {error}")))?;
    Client::try_from(config).map_err(|error| {
        AppError::bad_request(format!("unable to create Kubernetes client: {error}"))
    })
}
