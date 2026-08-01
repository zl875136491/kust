use std::sync::Arc;

use kube::{config::KubeConfigOptions, Client, Config};
use mongodb::{
    bson::{doc, oid::ObjectId},
    Collection, Database,
};

use crate::{crypto::SecretBox, error::AppError, models::ClusterDocument};

#[derive(Clone)]
pub struct AppState {
    pub database: Database,
    pub clusters: Collection<ClusterDocument>,
    pub secrets: SecretBox,
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
