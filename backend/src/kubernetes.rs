use std::{collections::BTreeMap, fmt::Debug};

use k8s_openapi::api::{
    apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet},
    batch::v1::{CronJob, Job},
    core::v1::{
        ConfigMap, Endpoints, Event, Namespace, Node, PersistentVolume, PersistentVolumeClaim, Pod,
        Secret, Service, ServiceAccount,
    },
    discovery::v1::EndpointSlice,
    networking::v1::{Ingress, NetworkPolicy},
    rbac::v1::{ClusterRole, ClusterRoleBinding, Role, RoleBinding},
    storage::v1::StorageClass,
};
use kube::{
    api::{DeleteParams, ListParams, LogParams, Patch, PatchParams},
    core::{ClusterResourceScope, DynamicObject, GroupVersionKind, NamespaceResourceScope},
    discovery::{Discovery, Scope},
    Api, Client, Resource, ResourceExt,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::{
    error::AppError,
    models::{
        ApplyResourceResponse, OverviewResponse, ResourceListResponse, ResourceRow, StatusCount,
    },
};

fn list_params(label_selector: Option<&str>) -> ListParams {
    match label_selector.filter(|value| !value.trim().is_empty()) {
        Some(selector) => ListParams::default().labels(selector),
        None => ListParams::default(),
    }
}

async fn list_namespaced<K, F>(
    client: Client,
    namespace: Option<&str>,
    params: &ListParams,
    mapper: F,
) -> Result<Vec<ResourceRow>, AppError>
where
    K: Clone
        + Debug
        + DeserializeOwned
        + Resource<DynamicType = (), Scope = NamespaceResourceScope>,
    F: Fn(&K) -> ResourceRow,
{
    let api: Api<K> = match namespace.filter(|value| !value.is_empty() && *value != "all") {
        Some(namespace) => Api::namespaced(client, namespace),
        None => Api::all(client),
    };
    Ok(api.list(params).await?.iter().map(mapper).collect())
}

async fn list_cluster<K, F>(
    client: Client,
    params: &ListParams,
    mapper: F,
) -> Result<Vec<ResourceRow>, AppError>
where
    K: Clone + Debug + DeserializeOwned + Resource<DynamicType = (), Scope = ClusterResourceScope>,
    F: Fn(&K) -> ResourceRow,
{
    let api: Api<K> = Api::all(client);
    Ok(api.list(params).await?.iter().map(mapper).collect())
}

fn base_row<K>(resource: &K, kind: &str) -> ResourceRow
where
    K: Resource<DynamicType = ()>,
{
    let metadata = resource.meta();
    ResourceRow {
        uid: metadata
            .uid
            .clone()
            .unwrap_or_else(|| format!("{kind}:{}", resource.name_any())),
        name: resource.name_any(),
        namespace: resource.namespace(),
        kind: kind.into(),
        status: "Unknown".into(),
        ready: None,
        restarts: None,
        created_at: metadata
            .creation_timestamp
            .as_ref()
            .map(|time| time.0.to_rfc3339()),
        node: None,
        labels: metadata.labels.clone().unwrap_or_default(),
        details: Value::Object(Default::default()),
    }
}

fn pod_row(pod: &Pod) -> ResourceRow {
    let mut row = base_row(pod, "Pod");
    let statuses = pod
        .status
        .as_ref()
        .and_then(|status| status.container_statuses.as_ref());
    let ready = statuses
        .map(|items| items.iter().filter(|item| item.ready).count())
        .unwrap_or(0);
    let total = pod
        .spec
        .as_ref()
        .map(|spec| spec.containers.len())
        .unwrap_or(0);
    row.status = pod
        .status
        .as_ref()
        .and_then(|status| status.phase.clone())
        .unwrap_or_else(|| "Pending".into());
    row.ready = Some(format!("{ready}/{total}"));
    row.restarts = statuses.map(|items| items.iter().map(|item| item.restart_count).sum());
    row.node = pod.spec.as_ref().and_then(|spec| spec.node_name.clone());
    row.details = json!({
        "podIP": pod.status.as_ref().and_then(|status| status.pod_ip.clone()),
        "qosClass": pod.status.as_ref().and_then(|status| status.qos_class.clone()),
        "images": pod.spec.as_ref().map(|spec| spec.containers.iter().map(|container| container.image.clone().unwrap_or_default()).collect::<Vec<_>>()).unwrap_or_default(),
        "containers": pod.spec.as_ref().map(|spec| spec.containers.iter().map(|container| container.name.clone()).collect::<Vec<_>>()).unwrap_or_default(),
    });
    row
}

fn deployment_row(item: &Deployment) -> ResourceRow {
    let mut row = base_row(item, "Deployment");
    let desired = item
        .spec
        .as_ref()
        .and_then(|spec| spec.replicas)
        .unwrap_or(1);
    let ready = item
        .status
        .as_ref()
        .and_then(|status| status.ready_replicas)
        .unwrap_or(0);
    let available = item
        .status
        .as_ref()
        .and_then(|status| status.available_replicas)
        .unwrap_or(0);
    row.status = if ready == desired {
        "Ready"
    } else {
        "Progressing"
    }
    .into();
    row.ready = Some(format!("{ready}/{desired}"));
    row.details = json!({
        "available": available,
        "desired": desired,
        "strategy": item.spec.as_ref().and_then(|spec| spec.strategy.as_ref()).and_then(|strategy| strategy.type_.clone()),
    });
    row
}

fn stateful_set_row(item: &StatefulSet) -> ResourceRow {
    let mut row = base_row(item, "StatefulSet");
    let desired = item
        .spec
        .as_ref()
        .and_then(|spec| spec.replicas)
        .unwrap_or(1);
    let ready = item
        .status
        .as_ref()
        .and_then(|status| status.ready_replicas)
        .unwrap_or(0);
    row.status = if ready == desired {
        "Ready"
    } else {
        "Progressing"
    }
    .into();
    row.ready = Some(format!("{ready}/{desired}"));
    row.details = json!({
        "serviceName": item.spec.as_ref().map(|spec| spec.service_name.clone()),
        "currentRevision": item.status.as_ref().and_then(|status| status.current_revision.clone()),
        "updateRevision": item.status.as_ref().and_then(|status| status.update_revision.clone()),
    });
    row
}

fn daemon_set_row(item: &DaemonSet) -> ResourceRow {
    let mut row = base_row(item, "DaemonSet");
    let desired = item
        .status
        .as_ref()
        .map(|status| status.desired_number_scheduled)
        .unwrap_or(0);
    let ready = item
        .status
        .as_ref()
        .map(|status| status.number_ready)
        .unwrap_or(0);
    row.status = if ready == desired {
        "Ready"
    } else {
        "Progressing"
    }
    .into();
    row.ready = Some(format!("{ready}/{desired}"));
    row.details = json!({
        "available": item.status.as_ref().and_then(|status| status.number_available),
        "updated": item.status.as_ref().and_then(|status| status.updated_number_scheduled),
    });
    row
}

fn replica_set_row(item: &ReplicaSet) -> ResourceRow {
    let mut row = base_row(item, "ReplicaSet");
    let desired = item
        .spec
        .as_ref()
        .and_then(|spec| spec.replicas)
        .unwrap_or(1);
    let ready = item
        .status
        .as_ref()
        .and_then(|status| status.ready_replicas)
        .unwrap_or(0);
    row.status = if ready == desired {
        "Ready"
    } else {
        "Progressing"
    }
    .into();
    row.ready = Some(format!("{ready}/{desired}"));
    row.details = json!({ "desired": desired });
    row
}

fn job_row(item: &Job) -> ResourceRow {
    let mut row = base_row(item, "Job");
    let succeeded = item
        .status
        .as_ref()
        .and_then(|status| status.succeeded)
        .unwrap_or(0);
    let failed = item
        .status
        .as_ref()
        .and_then(|status| status.failed)
        .unwrap_or(0);
    let completions = item
        .spec
        .as_ref()
        .and_then(|spec| spec.completions)
        .unwrap_or(1);
    row.status = if failed > 0 {
        "Failed"
    } else if succeeded >= completions {
        "Complete"
    } else {
        "Running"
    }
    .into();
    row.ready = Some(format!("{succeeded}/{completions}"));
    row.details = json!({ "failed": failed, "active": item.status.as_ref().and_then(|status| status.active) });
    row
}

fn cron_job_row(item: &CronJob) -> ResourceRow {
    let mut row = base_row(item, "CronJob");
    let suspended = item
        .spec
        .as_ref()
        .and_then(|spec| spec.suspend)
        .unwrap_or(false);
    row.status = if suspended { "Suspended" } else { "Active" }.into();
    row.details = json!({
        "schedule": item.spec.as_ref().map(|spec| spec.schedule.clone()),
        "lastSchedule": item.status.as_ref().and_then(|status| status.last_schedule_time.as_ref()).map(|time| time.0.to_rfc3339()),
    });
    row
}

fn node_row(item: &Node) -> ResourceRow {
    let mut row = base_row(item, "Node");
    let ready = item
        .status
        .as_ref()
        .and_then(|status| status.conditions.as_ref())
        .and_then(|conditions| {
            conditions
                .iter()
                .find(|condition| condition.type_ == "Ready")
        })
        .map(|condition| condition.status == "True")
        .unwrap_or(false);
    row.status = if ready { "Ready" } else { "NotReady" }.into();
    let roles: Vec<String> = row
        .labels
        .keys()
        .filter_map(|key| {
            key.strip_prefix("node-role.kubernetes.io/")
                .map(str::to_string)
        })
        .collect();
    row.details = json!({
        "roles": roles,
        "capacity": item.status.as_ref().and_then(|status| status.capacity.clone()),
        "allocatable": item.status.as_ref().and_then(|status| status.allocatable.clone()),
        "kubeletVersion": item.status.as_ref().and_then(|status| status.node_info.as_ref()).map(|info| info.kubelet_version.clone()),
        "operatingSystem": item.status.as_ref().and_then(|status| status.node_info.as_ref()).map(|info| info.os_image.clone()),
    });
    row
}

fn namespace_row(item: &Namespace) -> ResourceRow {
    let mut row = base_row(item, "Namespace");
    row.status = item
        .status
        .as_ref()
        .and_then(|status| status.phase.clone())
        .unwrap_or_else(|| "Active".into());
    row
}

fn service_row(item: &Service) -> ResourceRow {
    let mut row = base_row(item, "Service");
    let spec = item.spec.as_ref();
    row.status = spec
        .and_then(|spec| spec.type_.clone())
        .unwrap_or_else(|| "ClusterIP".into());
    row.details = json!({
        "clusterIP": spec.and_then(|spec| spec.cluster_ip.clone()),
        "externalIPs": spec.and_then(|spec| spec.external_ips.clone()).unwrap_or_default(),
        "ports": spec.and_then(|spec| spec.ports.clone()).unwrap_or_default(),
    });
    row
}

fn ingress_row(item: &Ingress) -> ResourceRow {
    let mut row = base_row(item, "Ingress");
    let hosts: Vec<String> = item
        .spec
        .as_ref()
        .and_then(|spec| spec.rules.as_ref())
        .map(|rules| rules.iter().filter_map(|rule| rule.host.clone()).collect())
        .unwrap_or_default();
    row.status = if hosts.is_empty() { "Pending" } else { "Ready" }.into();
    row.details = json!({
        "hosts": hosts,
        "className": item.spec.as_ref().and_then(|spec| spec.ingress_class_name.clone()),
        "loadBalancer": item.status.as_ref().and_then(|status| status.load_balancer.as_ref()).and_then(|lb| lb.ingress.clone()).unwrap_or_default(),
    });
    row
}

fn config_map_row(item: &ConfigMap) -> ResourceRow {
    let mut row = base_row(item, "ConfigMap");
    let keys: Vec<String> = item
        .data
        .as_ref()
        .map(|data| data.keys().cloned().collect())
        .unwrap_or_default();
    row.status = "Active".into();
    row.details = json!({ "keys": keys, "count": keys.len() });
    row
}

fn secret_row(item: &Secret) -> ResourceRow {
    let mut row = base_row(item, "Secret");
    let keys: Vec<String> = item
        .data
        .as_ref()
        .map(|data| data.keys().cloned().collect())
        .unwrap_or_default();
    row.status = item.type_.clone().unwrap_or_else(|| "Opaque".into());
    row.details = json!({ "keys": keys, "count": keys.len() });
    row
}

fn pvc_row(item: &PersistentVolumeClaim) -> ResourceRow {
    let mut row = base_row(item, "PersistentVolumeClaim");
    row.status = item
        .status
        .as_ref()
        .and_then(|status| status.phase.clone())
        .unwrap_or_else(|| "Pending".into());
    row.details = json!({
        "volume": item.spec.as_ref().and_then(|spec| spec.volume_name.clone()),
        "storageClass": item.spec.as_ref().and_then(|spec| spec.storage_class_name.clone()),
        "capacity": item.status.as_ref().and_then(|status| status.capacity.clone()),
    });
    row
}

fn pv_row(item: &PersistentVolume) -> ResourceRow {
    let mut row = base_row(item, "PersistentVolume");
    row.status = item
        .status
        .as_ref()
        .and_then(|status| status.phase.clone())
        .unwrap_or_else(|| "Available".into());
    row.details = json!({
        "storageClass": item.spec.as_ref().and_then(|spec| spec.storage_class_name.clone()),
        "capacity": item.spec.as_ref().and_then(|spec| spec.capacity.clone()),
        "claim": item.spec.as_ref().and_then(|spec| spec.claim_ref.as_ref()).and_then(|claim| claim.name.clone()),
    });
    row
}

fn event_row(item: &Event) -> ResourceRow {
    let mut row = base_row(item, "Event");
    row.status = item.type_.clone().unwrap_or_else(|| "Normal".into());
    row.details = json!({
        "reason": item.reason,
        "message": item.message,
        "count": item.count,
        "objectKind": item.involved_object.kind,
        "objectName": item.involved_object.name,
        "source": item.source.as_ref().and_then(|source| source.host.clone()),
        "lastSeen": item.last_timestamp.as_ref().map(|time| time.0.to_rfc3339()),
    });
    row
}

fn generic_row<K>(item: &K, kind: &str, status: &str, details: Value) -> ResourceRow
where
    K: Resource<DynamicType = ()>,
{
    let mut row = base_row(item, kind);
    row.status = status.into();
    row.details = details;
    row
}

pub async fn list_resources(
    client: Client,
    kind: &str,
    namespace: Option<&str>,
    label_selector: Option<&str>,
) -> Result<ResourceListResponse, AppError> {
    let params = list_params(label_selector);
    let normalized = kind.to_ascii_lowercase().replace(['-', '_'], "");
    let (display_kind, mut items) = match normalized.as_str() {
        "pods" => ("Pod", list_namespaced::<Pod, _>(client, namespace, &params, pod_row).await?),
        "deployments" => ("Deployment", list_namespaced::<Deployment, _>(client, namespace, &params, deployment_row).await?),
        "statefulsets" => ("StatefulSet", list_namespaced::<StatefulSet, _>(client, namespace, &params, stateful_set_row).await?),
        "daemonsets" => ("DaemonSet", list_namespaced::<DaemonSet, _>(client, namespace, &params, daemon_set_row).await?),
        "replicasets" => ("ReplicaSet", list_namespaced::<ReplicaSet, _>(client, namespace, &params, replica_set_row).await?),
        "jobs" => ("Job", list_namespaced::<Job, _>(client, namespace, &params, job_row).await?),
        "cronjobs" => ("CronJob", list_namespaced::<CronJob, _>(client, namespace, &params, cron_job_row).await?),
        "nodes" => ("Node", list_cluster::<Node, _>(client, &params, node_row).await?),
        "namespaces" => ("Namespace", list_cluster::<Namespace, _>(client, &params, namespace_row).await?),
        "services" => ("Service", list_namespaced::<Service, _>(client, namespace, &params, service_row).await?),
        "ingresses" => ("Ingress", list_namespaced::<Ingress, _>(client, namespace, &params, ingress_row).await?),
        "configmaps" => ("ConfigMap", list_namespaced::<ConfigMap, _>(client, namespace, &params, config_map_row).await?),
        "secrets" => ("Secret", list_namespaced::<Secret, _>(client, namespace, &params, secret_row).await?),
        "persistentvolumeclaims" => ("PersistentVolumeClaim", list_namespaced::<PersistentVolumeClaim, _>(client, namespace, &params, pvc_row).await?),
        "persistentvolumes" => ("PersistentVolume", list_cluster::<PersistentVolume, _>(client, &params, pv_row).await?),
        "events" => ("Event", list_namespaced::<Event, _>(client, namespace, &params, event_row).await?),
        "endpoints" => ("Endpoints", list_namespaced::<Endpoints, _>(client, namespace, &params, |item| {
            let addresses = item.subsets.as_ref().map(|subsets| subsets.iter().map(|subset| subset.addresses.as_ref().map(Vec::len).unwrap_or(0)).sum::<usize>()).unwrap_or(0);
            generic_row(item, "Endpoints", "Active", json!({ "addresses": addresses }))
        }).await?),
        "endpointslices" => ("EndpointSlice", list_namespaced::<EndpointSlice, _>(client, namespace, &params, |item| {
            generic_row(item, "EndpointSlice", "Active", json!({ "addressType": item.address_type, "endpoints": item.endpoints.len() }))
        }).await?),
        "networkpolicies" => ("NetworkPolicy", list_namespaced::<NetworkPolicy, _>(client, namespace, &params, |item| {
            generic_row(item, "NetworkPolicy", "Active", json!({ "policyTypes": item.spec.as_ref().and_then(|spec| spec.policy_types.clone()).unwrap_or_default() }))
        }).await?),
        "serviceaccounts" => ("ServiceAccount", list_namespaced::<ServiceAccount, _>(client, namespace, &params, |item| {
            generic_row(item, "ServiceAccount", "Active", json!({ "automount": item.automount_service_account_token, "secrets": item.secrets.as_ref().map(Vec::len).unwrap_or(0) }))
        }).await?),
        "roles" => ("Role", list_namespaced::<Role, _>(client, namespace, &params, |item| {
            generic_row(item, "Role", "Active", json!({ "rules": item.rules.as_ref().map(Vec::len).unwrap_or(0) }))
        }).await?),
        "rolebindings" => ("RoleBinding", list_namespaced::<RoleBinding, _>(client, namespace, &params, |item| {
            generic_row(item, "RoleBinding", "Active", json!({ "role": item.role_ref.name, "subjects": item.subjects.as_ref().map(Vec::len).unwrap_or(0) }))
        }).await?),
        "clusterroles" => ("ClusterRole", list_cluster::<ClusterRole, _>(client, &params, |item| {
            generic_row(item, "ClusterRole", "Active", json!({ "rules": item.rules.as_ref().map(Vec::len).unwrap_or(0) }))
        }).await?),
        "clusterrolebindings" => ("ClusterRoleBinding", list_cluster::<ClusterRoleBinding, _>(client, &params, |item| {
            generic_row(item, "ClusterRoleBinding", "Active", json!({ "role": item.role_ref.name, "subjects": item.subjects.as_ref().map(Vec::len).unwrap_or(0) }))
        }).await?),
        "storageclasses" => ("StorageClass", list_cluster::<StorageClass, _>(client, &params, |item| {
            generic_row(item, "StorageClass", "Active", json!({ "provisioner": item.provisioner, "reclaimPolicy": item.reclaim_policy, "volumeBindingMode": item.volume_binding_mode }))
        }).await?),
        _ => return Err(AppError::bad_request(format!("resource kind '{kind}' is not supported"))),
    };
    items.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(ResourceListResponse {
        kind: display_kind.into(),
        items,
    })
}

pub async fn overview(client: Client) -> Result<OverviewResponse, AppError> {
    let pods = list_resources(client.clone(), "pods", None, None).await?;
    let nodes = list_resources(client.clone(), "nodes", None, None).await?;
    let mut workloads = Vec::new();
    for kind in [
        "deployments",
        "statefulsets",
        "daemonsets",
        "jobs",
        "cronjobs",
    ] {
        if let Ok(mut result) = list_resources(client.clone(), kind, None, None).await {
            workloads.append(&mut result.items);
        }
    }
    let mut events = list_resources(client, "events", None, None)
        .await
        .map(|result| result.items)
        .unwrap_or_default();
    events.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    events.truncate(40);

    Ok(OverviewResponse {
        cpu_percent: None,
        memory_percent: None,
        pods: StatusCount {
            healthy: pods
                .items
                .iter()
                .filter(|item| matches!(item.status.as_str(), "Running" | "Succeeded"))
                .count(),
            total: pods.items.len(),
        },
        nodes: StatusCount {
            healthy: nodes
                .items
                .iter()
                .filter(|item| item.status == "Ready")
                .count(),
            total: nodes.items.len(),
        },
        workloads,
        events,
    })
}

async fn delete_namespaced<K>(client: Client, namespace: &str, name: &str) -> Result<(), AppError>
where
    K: Clone
        + Debug
        + DeserializeOwned
        + Resource<DynamicType = (), Scope = NamespaceResourceScope>,
{
    Api::<K>::namespaced(client, namespace)
        .delete(name, &DeleteParams::default())
        .await?;
    Ok(())
}

async fn delete_cluster<K>(client: Client, name: &str) -> Result<(), AppError>
where
    K: Clone + Debug + DeserializeOwned + Resource<DynamicType = (), Scope = ClusterResourceScope>,
{
    Api::<K>::all(client)
        .delete(name, &DeleteParams::default())
        .await?;
    Ok(())
}

pub async fn delete_resource(
    client: Client,
    kind: &str,
    namespace: Option<&str>,
    name: &str,
) -> Result<(), AppError> {
    let normalized = kind.to_ascii_lowercase().replace(['-', '_'], "");
    let namespace = || {
        namespace
            .filter(|value| !value.is_empty() && *value != "all")
            .ok_or_else(|| AppError::bad_request("namespace is required for this resource"))
    };
    match normalized.as_str() {
        "pods" => delete_namespaced::<Pod>(client, namespace()?, name).await,
        "deployments" => delete_namespaced::<Deployment>(client, namespace()?, name).await,
        "statefulsets" => delete_namespaced::<StatefulSet>(client, namespace()?, name).await,
        "daemonsets" => delete_namespaced::<DaemonSet>(client, namespace()?, name).await,
        "replicasets" => delete_namespaced::<ReplicaSet>(client, namespace()?, name).await,
        "jobs" => delete_namespaced::<Job>(client, namespace()?, name).await,
        "cronjobs" => delete_namespaced::<CronJob>(client, namespace()?, name).await,
        "services" => delete_namespaced::<Service>(client, namespace()?, name).await,
        "ingresses" => delete_namespaced::<Ingress>(client, namespace()?, name).await,
        "configmaps" => delete_namespaced::<ConfigMap>(client, namespace()?, name).await,
        "secrets" => delete_namespaced::<Secret>(client, namespace()?, name).await,
        "persistentvolumeclaims" => {
            delete_namespaced::<PersistentVolumeClaim>(client, namespace()?, name).await
        }
        "networkpolicies" => delete_namespaced::<NetworkPolicy>(client, namespace()?, name).await,
        "serviceaccounts" => delete_namespaced::<ServiceAccount>(client, namespace()?, name).await,
        "roles" => delete_namespaced::<Role>(client, namespace()?, name).await,
        "rolebindings" => delete_namespaced::<RoleBinding>(client, namespace()?, name).await,
        "nodes" => delete_cluster::<Node>(client, name).await,
        "namespaces" => delete_cluster::<Namespace>(client, name).await,
        "persistentvolumes" => delete_cluster::<PersistentVolume>(client, name).await,
        "storageclasses" => delete_cluster::<StorageClass>(client, name).await,
        "clusterroles" => delete_cluster::<ClusterRole>(client, name).await,
        "clusterrolebindings" => delete_cluster::<ClusterRoleBinding>(client, name).await,
        _ => Err(AppError::bad_request(format!(
            "resource kind '{kind}' cannot be deleted"
        ))),
    }
}

pub async fn scale_deployment(
    client: Client,
    namespace: &str,
    name: &str,
    replicas: i32,
) -> Result<ResourceRow, AppError> {
    if !(0..=10_000).contains(&replicas) {
        return Err(AppError::bad_request(
            "replicas must be between 0 and 10000",
        ));
    }
    let api: Api<Deployment> = Api::namespaced(client, namespace);
    let deployment = api
        .patch(
            name,
            &PatchParams::default(),
            &Patch::Merge(json!({ "spec": { "replicas": replicas } })),
        )
        .await?;
    Ok(deployment_row(&deployment))
}

pub async fn pod_logs(
    client: Client,
    namespace: &str,
    name: &str,
    container: Option<String>,
    tail_lines: i64,
) -> Result<String, AppError> {
    if !(1..=10_000).contains(&tail_lines) {
        return Err(AppError::bad_request(
            "tailLines must be between 1 and 10000",
        ));
    }
    let api: Api<Pod> = Api::namespaced(client, namespace);
    Ok(api
        .logs(
            name,
            &LogParams {
                container,
                tail_lines: Some(tail_lines),
                timestamps: true,
                ..Default::default()
            },
        )
        .await?)
}

fn resource_gvk(kind: &str) -> Result<GroupVersionKind, AppError> {
    let normalized = kind.to_ascii_lowercase().replace(['-', '_'], "");
    let (group, version, api_kind) = match normalized.as_str() {
        "pods" => ("", "v1", "Pod"),
        "deployments" => ("apps", "v1", "Deployment"),
        "statefulsets" => ("apps", "v1", "StatefulSet"),
        "daemonsets" => ("apps", "v1", "DaemonSet"),
        "replicasets" => ("apps", "v1", "ReplicaSet"),
        "jobs" => ("batch", "v1", "Job"),
        "cronjobs" => ("batch", "v1", "CronJob"),
        "nodes" => ("", "v1", "Node"),
        "namespaces" => ("", "v1", "Namespace"),
        "events" => ("", "v1", "Event"),
        "services" => ("", "v1", "Service"),
        "endpoints" => ("", "v1", "Endpoints"),
        "endpointslices" => ("discovery.k8s.io", "v1", "EndpointSlice"),
        "ingresses" => ("networking.k8s.io", "v1", "Ingress"),
        "networkpolicies" => ("networking.k8s.io", "v1", "NetworkPolicy"),
        "configmaps" => ("", "v1", "ConfigMap"),
        "secrets" => ("", "v1", "Secret"),
        "persistentvolumeclaims" => ("", "v1", "PersistentVolumeClaim"),
        "persistentvolumes" => ("", "v1", "PersistentVolume"),
        "storageclasses" => ("storage.k8s.io", "v1", "StorageClass"),
        "serviceaccounts" => ("", "v1", "ServiceAccount"),
        "roles" => ("rbac.authorization.k8s.io", "v1", "Role"),
        "rolebindings" => ("rbac.authorization.k8s.io", "v1", "RoleBinding"),
        "clusterroles" => ("rbac.authorization.k8s.io", "v1", "ClusterRole"),
        "clusterrolebindings" => ("rbac.authorization.k8s.io", "v1", "ClusterRoleBinding"),
        _ => {
            return Err(AppError::bad_request(format!(
                "resource kind '{kind}' cannot be opened"
            )))
        }
    };
    Ok(GroupVersionKind::gvk(group, version, api_kind))
}

pub async fn resource_yaml(
    client: Client,
    kind: &str,
    namespace: Option<&str>,
    name: &str,
) -> Result<String, AppError> {
    let discovery = Discovery::new(client.clone()).run().await?;
    let gvk = resource_gvk(kind)?;
    let (resource, capabilities) = discovery
        .resolve_gvk(&gvk)
        .ok_or_else(|| AppError::bad_request(format!("the cluster does not expose {kind}")))?;
    let api: Api<DynamicObject> = if capabilities.scope == Scope::Cluster {
        Api::all_with(client, &resource)
    } else {
        let namespace = namespace
            .filter(|value| !value.is_empty() && *value != "_")
            .ok_or_else(|| AppError::bad_request("namespace is required for this resource"))?;
        Api::namespaced_with(client, namespace, &resource)
    };
    let mut object = api.get(name).await?;
    object.metadata.managed_fields = None;
    serde_yaml::to_string(&object)
        .map_err(|error| AppError::internal(format!("unable to encode resource YAML: {error}")))
}

pub async fn apply_yaml(
    client: Client,
    yaml: &str,
    fallback_namespace: Option<&str>,
) -> Result<ApplyResourceResponse, AppError> {
    let yaml_value: serde_yaml::Value = serde_yaml::from_str(yaml)
        .map_err(|error| AppError::bad_request(format!("YAML is invalid: {error}")))?;
    let json_value = serde_json::to_value(yaml_value)
        .map_err(|error| AppError::bad_request(format!("YAML cannot be converted: {error}")))?;
    let api_version = json_value
        .get("apiVersion")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::bad_request("apiVersion is required"))?
        .to_string();
    let kind = json_value
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::bad_request("kind is required"))?
        .to_string();
    let (group, version) = api_version
        .split_once('/')
        .unwrap_or(("", api_version.as_str()));
    let gvk = GroupVersionKind::gvk(group, version, &kind);
    let discovery = Discovery::new(client.clone()).run().await?;
    let (resource, capabilities) = discovery.resolve_gvk(&gvk).ok_or_else(|| {
        AppError::bad_request(format!("the cluster does not expose {api_version}/{kind}"))
    })?;
    let object: DynamicObject = serde_json::from_value(json_value)
        .map_err(|error| AppError::bad_request(format!("resource is invalid: {error}")))?;
    let name = object
        .metadata
        .name
        .clone()
        .ok_or_else(|| AppError::bad_request("metadata.name is required"))?;
    let namespace = object
        .metadata
        .namespace
        .clone()
        .or_else(|| fallback_namespace.map(str::to_string));
    let api: Api<DynamicObject> = if capabilities.scope == Scope::Cluster {
        Api::all_with(client, &resource)
    } else {
        Api::namespaced_with(client, namespace.as_deref().unwrap_or("default"), &resource)
    };
    let applied = api
        .patch(
            &name,
            &PatchParams::apply("kust.dev").force(),
            &Patch::Apply(&object),
        )
        .await?;
    Ok(ApplyResourceResponse {
        kind: applied
            .types
            .as_ref()
            .map(|types| types.kind.clone())
            .unwrap_or(kind),
        name: applied.name_any(),
        namespace: applied.namespace(),
    })
}

#[allow(dead_code)]
fn _ensure_btree_map_type(_: BTreeMap<String, String>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_kind_aliases_resolve_to_expected_gvks() {
        assert_eq!(
            resource_gvk("persistent-volume-claims").unwrap().kind,
            "PersistentVolumeClaim"
        );
        assert_eq!(resource_gvk("events").unwrap().group, "");
        assert_eq!(resource_gvk("events").unwrap().version, "v1");
        assert!(resource_gvk("widgets").is_err());
    }

    #[tokio::test]
    #[ignore = "requires a reachable Kubernetes cluster; set KUST_TEST_KUBECONFIG"]
    async fn live_cluster_resource_smoke_test() {
        let path = std::env::var("KUST_TEST_KUBECONFIG")
            .expect("KUST_TEST_KUBECONFIG must point to a kubeconfig");
        let yaml = tokio::fs::read_to_string(path).await.unwrap();
        let client = crate::state::client_from_kubeconfig(&yaml, None)
            .await
            .unwrap();
        let pods = list_resources(client.clone(), "pods", None, None)
            .await
            .unwrap();
        assert_eq!(pods.kind, "Pod");
        let services = list_resources(client.clone(), "services", None, None)
            .await
            .unwrap();
        assert_eq!(services.kind, "Service");
        let events = list_resources(client.clone(), "events", None, None)
            .await
            .unwrap();
        assert_eq!(events.kind, "Event");
        let nodes = list_resources(client.clone(), "nodes", None, None)
            .await
            .unwrap();
        assert_eq!(nodes.kind, "Node");
        let pod = pods
            .items
            .first()
            .expect("the smoke-test cluster should have a pod");
        let yaml = resource_yaml(client.clone(), "pods", pod.namespace.as_deref(), &pod.name)
            .await
            .unwrap();
        assert!(yaml.contains("kind: Pod"));
        let overview = overview(client).await.unwrap();
        assert_eq!(overview.pods.total, pods.items.len());
        assert_eq!(overview.nodes.total, nodes.items.len());
    }
}
