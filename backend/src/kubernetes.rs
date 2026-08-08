use std::{collections::BTreeMap, fmt::Debug};

use axum::http::Request;
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
    api::{AttachParams, DeleteParams, ListParams, LogParams, Patch, PatchParams},
    core::{ClusterResourceScope, DynamicObject, GroupVersionKind, NamespaceResourceScope},
    discovery::{Discovery, Scope},
    Api, Client, Resource, ResourceExt,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    time::{sleep, Duration, Instant},
};

use crate::{
    error::AppError,
    models::{
        ApplyResourceResponse, HostedApplicationDocument, OverviewResponse, ResourceListResponse,
        ResourceReference, ResourceRow, StatusCount,
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
        annotations: metadata.annotations.clone().unwrap_or_default(),
        owner_references: metadata
            .owner_references
            .as_ref()
            .map(|references| {
                references
                    .iter()
                    .map(|reference| ResourceReference {
                        api_version: reference.api_version.clone(),
                        kind: reference.kind.clone(),
                        name: reference.name.clone(),
                        uid: reference.uid.clone(),
                        controller: reference.controller.unwrap_or(false),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        generation: metadata.generation,
        resource_version: metadata.resource_version.clone(),
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
        "podIPs": pod.status.as_ref().and_then(|status| status.pod_ips.clone()).unwrap_or_default(),
        "hostIP": pod.status.as_ref().and_then(|status| status.host_ip.clone()),
        "startTime": pod.status.as_ref().and_then(|status| status.start_time.as_ref()).map(|time| time.0.to_rfc3339()),
        "qosClass": pod.status.as_ref().and_then(|status| status.qos_class.clone()),
        "serviceAccount": pod.spec.as_ref().and_then(|spec| spec.service_account_name.clone()),
        "priorityClass": pod.spec.as_ref().and_then(|spec| spec.priority_class_name.clone()),
        "images": pod.spec.as_ref().map(|spec| spec.containers.iter().map(|container| container.image.clone().unwrap_or_default()).collect::<Vec<_>>()).unwrap_or_default(),
        "containers": pod.spec.as_ref().map(|spec| spec.containers.iter().map(|container| container.name.clone()).collect::<Vec<_>>()).unwrap_or_default(),
        "persistentVolumeClaims": pod.spec.as_ref().and_then(|spec| spec.volumes.as_ref()).map(|volumes| volumes.iter().filter_map(|volume| volume.persistent_volume_claim.as_ref().map(|claim| claim.claim_name.clone())).collect::<Vec<_>>()).unwrap_or_default(),
        "configMaps": pod.spec.as_ref().and_then(|spec| spec.volumes.as_ref()).map(|volumes| volumes.iter().filter_map(|volume| volume.config_map.as_ref().map(|config_map| config_map.name.clone())).collect::<Vec<_>>()).unwrap_or_default(),
        "secrets": pod.spec.as_ref().and_then(|spec| spec.volumes.as_ref()).map(|volumes| volumes.iter().filter_map(|volume| volume.secret.as_ref().and_then(|secret| secret.secret_name.clone())).collect::<Vec<_>>()).unwrap_or_default(),
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
        "ready": ready,
        "updated": item.status.as_ref().and_then(|status| status.updated_replicas).unwrap_or(0),
        "unavailable": item.status.as_ref().and_then(|status| status.unavailable_replicas).unwrap_or(0),
        "strategy": item.spec.as_ref().and_then(|spec| spec.strategy.clone()),
        "selector": item.spec.as_ref().map(|spec| spec.selector.match_labels.clone().unwrap_or_default()).unwrap_or_default(),
        "progressDeadlineSeconds": item.spec.as_ref().and_then(|spec| spec.progress_deadline_seconds),
        "revisionHistoryLimit": item.spec.as_ref().and_then(|spec| spec.revision_history_limit),
        "images": item.spec.as_ref().and_then(|spec| spec.template.spec.as_ref()).map(|spec| spec.containers.iter().map(|container| container.image.clone().unwrap_or_default()).collect::<Vec<_>>()).unwrap_or_default(),
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
        "selector": item.spec.as_ref().map(|spec| spec.selector.match_labels.clone().unwrap_or_default()).unwrap_or_default(),
        "images": item.spec.as_ref().and_then(|spec| spec.template.spec.as_ref()).map(|spec| spec.containers.iter().map(|container| container.image.clone().unwrap_or_default()).collect::<Vec<_>>()).unwrap_or_default(),
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
        "selector": item.spec.as_ref().map(|spec| spec.selector.match_labels.clone().unwrap_or_default()).unwrap_or_default(),
        "images": item.spec.as_ref().and_then(|spec| spec.template.spec.as_ref()).map(|spec| spec.containers.iter().map(|container| container.image.clone().unwrap_or_default()).collect::<Vec<_>>()).unwrap_or_default(),
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
    row.details = json!({
        "desired": desired,
        "ready": ready,
        "available": item.status.as_ref().and_then(|status| status.available_replicas).unwrap_or(0),
        "selector": item.spec.as_ref().map(|spec| spec.selector.match_labels.clone().unwrap_or_default()).unwrap_or_default(),
        "images": item.spec.as_ref().and_then(|spec| spec.template.as_ref()).and_then(|template| template.spec.as_ref()).map(|spec| spec.containers.iter().map(|container| container.image.clone().unwrap_or_default()).collect::<Vec<_>>()).unwrap_or_default(),
    });
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
        "selector": spec.and_then(|spec| spec.selector.clone()).unwrap_or_default(),
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
        "backends": item.spec.as_ref().and_then(|spec| spec.rules.as_ref()).map(|rules| rules.iter().flat_map(|rule| rule.http.as_ref().into_iter().flat_map(|http| http.paths.iter().map(|path| path.backend.service.as_ref().map(|service| service.name.clone()).unwrap_or_default()))).filter(|name| !name.is_empty()).collect::<Vec<_>>()).unwrap_or_default(),
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
        "claimNamespace": item.spec.as_ref().and_then(|spec| spec.claim_ref.as_ref()).and_then(|claim| claim.namespace.clone()),
        "reclaimPolicy": item.spec.as_ref().and_then(|spec| spec.persistent_volume_reclaim_policy.clone()),
        "accessModes": item.spec.as_ref().and_then(|spec| spec.access_modes.clone()).unwrap_or_default(),
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

fn dynamic_row(item: &DynamicObject, kind: &str) -> ResourceRow {
    let metadata = &item.metadata;
    let conditions = item
        .data
        .get("status")
        .and_then(|status| status.get("parents"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|parent| parent.get("conditions").and_then(Value::as_array))
        .flatten()
        .collect::<Vec<_>>();
    let accepted = conditions.iter().any(|condition| {
        condition.get("type").and_then(Value::as_str) == Some("Accepted")
            && condition.get("status").and_then(Value::as_str) == Some("True")
    });
    let hostnames = item
        .data
        .get("spec")
        .and_then(|spec| spec.get("hostnames"))
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let parents = item
        .data
        .get("spec")
        .and_then(|spec| spec.get("parentRefs"))
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let rules = item
        .data
        .get("spec")
        .and_then(|spec| spec.get("rules"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default();
    let backend_refs = item
        .data
        .get("spec")
        .and_then(|spec| spec.get("rules"))
        .and_then(Value::as_array)
        .map(|rules| {
            rules
                .iter()
                .flat_map(|rule| {
                    rule.get("backendRefs")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                })
                .filter_map(|backend| {
                    backend
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    ResourceRow {
        uid: metadata
            .uid
            .clone()
            .unwrap_or_else(|| format!("{kind}:{}", metadata.name.clone().unwrap_or_default())),
        name: metadata.name.clone().unwrap_or_default(),
        namespace: metadata.namespace.clone(),
        kind: kind.into(),
        status: if accepted { "Accepted" } else { "Pending" }.into(),
        ready: Some(format!("{rules} rule{}", if rules == 1 { "" } else { "s" })),
        restarts: None,
        created_at: metadata
            .creation_timestamp
            .as_ref()
            .map(|time| time.0.to_rfc3339()),
        node: None,
        labels: metadata.labels.clone().unwrap_or_default(),
        annotations: metadata.annotations.clone().unwrap_or_default(),
        owner_references: metadata
            .owner_references
            .as_ref()
            .map(|references| {
                references
                    .iter()
                    .map(|reference| ResourceReference {
                        api_version: reference.api_version.clone(),
                        kind: reference.kind.clone(),
                        name: reference.name.clone(),
                        uid: reference.uid.clone(),
                        controller: reference.controller.unwrap_or(false),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        generation: metadata.generation,
        resource_version: metadata.resource_version.clone(),
        details: json!({
            "hostnames": hostnames,
            "parentRefs": parents,
            "rules": rules,
            "conditions": conditions,
            "backendRefs": backend_refs,
        }),
    }
}

async fn list_dynamic(
    client: Client,
    gvk: &GroupVersionKind,
    namespace: Option<&str>,
    params: &ListParams,
    display_kind: &str,
) -> Result<Vec<ResourceRow>, AppError> {
    let discovery = Discovery::new(client.clone()).run().await?;
    let (resource, capabilities) = discovery.resolve_gvk(gvk).ok_or_else(|| {
        AppError::bad_request(format!("the cluster does not expose {display_kind}"))
    })?;
    let api: Api<DynamicObject> = if capabilities.scope == Scope::Cluster {
        Api::all_with(client, &resource)
    } else {
        match namespace.filter(|value| !value.is_empty() && *value != "all") {
            Some(namespace) => Api::namespaced_with(client, namespace, &resource),
            None => Api::all_with(client, &resource),
        }
    };
    Ok(api
        .list(params)
        .await?
        .iter()
        .map(|item| dynamic_row(item, display_kind))
        .collect())
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
        "httproutes" => (
            "HTTPRoute",
            list_dynamic(
                client,
                &GroupVersionKind::gvk("gateway.networking.k8s.io", "v1", "HTTPRoute"),
                namespace,
                &params,
                "HTTPRoute",
            )
            .await?,
        ),
        "gateways" => (
            "Gateway",
            list_dynamic(
                client,
                &GroupVersionKind::gvk("gateway.networking.k8s.io", "v1", "Gateway"),
                namespace,
                &params,
                "Gateway",
            )
            .await?,
        ),
        "gatewayclasses" => (
            "GatewayClass",
            list_dynamic(
                client,
                &GroupVersionKind::gvk("gateway.networking.k8s.io", "v1", "GatewayClass"),
                namespace,
                &params,
                "GatewayClass",
            )
            .await?,
        ),
        "referencegrants" => (
            "ReferenceGrant",
            list_dynamic(
                client,
                &GroupVersionKind::gvk("gateway.networking.k8s.io", "v1beta1", "ReferenceGrant"),
                namespace,
                &params,
                "ReferenceGrant",
            )
            .await?,
        ),
        "grpcroutes" => (
            "GRPCRoute",
            list_dynamic(
                client,
                &GroupVersionKind::gvk("gateway.networking.k8s.io", "v1", "GRPCRoute"),
                namespace,
                &params,
                "GRPCRoute",
            )
            .await?,
        ),
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

pub async fn discover_resources(
    client: Client,
) -> Result<Vec<crate::models::DiscoveryResourceResponse>, AppError> {
    let entries = Discovery::new(client).run().await?;
    let mut resources = Vec::new();
    for group in entries.groups() {
        for (resource, capabilities) in group.resources_by_stability() {
            resources.push(crate::models::DiscoveryResourceResponse {
                group: group.name().to_string(),
                version: resource.version.clone(),
                kind: resource.kind.clone(),
                resource: resource.plural.clone(),
                namespaced: capabilities.scope == Scope::Namespaced,
                verbs: capabilities.operations.clone(),
            });
        }
    }
    resources.sort_by(|a, b| a.group.cmp(&b.group).then(a.kind.cmp(&b.kind)));
    Ok(resources)
}

pub async fn metrics_summary(
    client: Client,
) -> Result<crate::models::MetricsSummaryResponse, AppError> {
    let collected_at = k8s_openapi::chrono::Utc::now().to_rfc3339();
    let node_request = Request::get("/apis/metrics.k8s.io/v1beta1/nodes")
        .body(Vec::new())
        .map_err(|error| AppError::internal(format!("metrics request failed: {error}")))?;
    let pod_request = Request::get("/apis/metrics.k8s.io/v1beta1/pods")
        .body(Vec::new())
        .map_err(|error| AppError::internal(format!("metrics request failed: {error}")))?;
    let nodes: Value = client
        .request(node_request)
        .await
        .map_err(|error| AppError::upstream(format!("Metrics API unavailable: {error}")))?;
    let pods: Value = client
        .request(pod_request)
        .await
        .map_err(|error| AppError::upstream(format!("Metrics API unavailable: {error}")))?;
    let mut cpu_millicores = 0_i64;
    let mut memory_bytes = 0_i64;
    for item in nodes
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .chain(
            pods.get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten(),
        )
    {
        if let Some(containers) = item.get("usage").and_then(Value::as_object) {
            cpu_millicores += parse_quantity(
                containers
                    .get("cpu")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                true,
            );
            memory_bytes += parse_quantity(
                containers
                    .get("memory")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                false,
            );
        }
        if let Some(container_items) = item.get("containers").and_then(Value::as_array) {
            for container in container_items {
                if let Some(usage) = container.get("usage").and_then(Value::as_object) {
                    cpu_millicores += parse_quantity(
                        usage.get("cpu").and_then(Value::as_str).unwrap_or_default(),
                        true,
                    );
                    memory_bytes += parse_quantity(
                        usage
                            .get("memory")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        false,
                    );
                }
            }
        }
    }
    Ok(crate::models::MetricsSummaryResponse {
        available: true,
        cpu_millicores,
        memory_bytes,
        nodes: nodes
            .get("items")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        pods: pods
            .get("items")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        collected_at,
        message: None,
    })
}

fn parse_quantity(value: &str, cpu: bool) -> i64 {
    let value = value.trim();
    if cpu {
        if let Some(raw) = value.strip_suffix('n') {
            return raw.parse::<f64>().unwrap_or(0.0) as i64 / 1_000_000;
        }
        if let Some(raw) = value.strip_suffix('m') {
            return raw.parse::<f64>().unwrap_or(0.0) as i64;
        }
        return value.parse::<f64>().unwrap_or(0.0) as i64 * 1000;
    }
    let (number, multiplier) = if let Some(raw) = value.strip_suffix("Ki") {
        (raw, 1024_f64)
    } else if let Some(raw) = value.strip_suffix("Mi") {
        (raw, 1024_f64.powi(2))
    } else if let Some(raw) = value.strip_suffix("Gi") {
        (raw, 1024_f64.powi(3))
    } else {
        (value, 1.0)
    };
    (number.parse::<f64>().unwrap_or(0.0) * multiplier) as i64
}

#[allow(dead_code)]
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

async fn delete_dynamic(
    client: Client,
    gvk: &GroupVersionKind,
    namespace: Option<&str>,
    name: &str,
) -> Result<(), AppError> {
    let discovery = Discovery::new(client.clone()).run().await?;
    let (resource, capabilities) = discovery.resolve_gvk(gvk).ok_or_else(|| {
        AppError::bad_request(format!("the cluster does not expose {}", gvk.kind))
    })?;
    let api: Api<DynamicObject> = if capabilities.scope == Scope::Cluster {
        Api::all_with(client, &resource)
    } else {
        let namespace = namespace
            .filter(|value| !value.is_empty() && *value != "all")
            .ok_or_else(|| AppError::bad_request("namespace is required for this resource"))?;
        Api::namespaced_with(client, namespace, &resource)
    };
    api.delete(name, &DeleteParams::default()).await?;
    Ok(())
}

pub async fn delete_resource(
    client: Client,
    kind: &str,
    namespace: Option<&str>,
    name: &str,
) -> Result<(), AppError> {
    let normalized = kind.to_ascii_lowercase().replace(['-', '_'], "");
    let required_namespace = || {
        namespace
            .filter(|value| !value.is_empty() && *value != "all")
            .ok_or_else(|| AppError::bad_request("namespace is required for this resource"))
    };
    match normalized.as_str() {
        "pods" => delete_namespaced::<Pod>(client, required_namespace()?, name).await,
        "deployments" => delete_namespaced::<Deployment>(client, required_namespace()?, name).await,
        "statefulsets" => {
            delete_namespaced::<StatefulSet>(client, required_namespace()?, name).await
        }
        "daemonsets" => delete_namespaced::<DaemonSet>(client, required_namespace()?, name).await,
        "replicasets" => delete_namespaced::<ReplicaSet>(client, required_namespace()?, name).await,
        "jobs" => delete_namespaced::<Job>(client, required_namespace()?, name).await,
        "cronjobs" => delete_namespaced::<CronJob>(client, required_namespace()?, name).await,
        "events" => delete_namespaced::<Event>(client, required_namespace()?, name).await,
        "services" => delete_namespaced::<Service>(client, required_namespace()?, name).await,
        "endpoints" => delete_namespaced::<Endpoints>(client, required_namespace()?, name).await,
        "endpointslices" => {
            delete_namespaced::<EndpointSlice>(client, required_namespace()?, name).await
        }
        "ingresses" => delete_namespaced::<Ingress>(client, required_namespace()?, name).await,
        "configmaps" => delete_namespaced::<ConfigMap>(client, required_namespace()?, name).await,
        "secrets" => delete_namespaced::<Secret>(client, required_namespace()?, name).await,
        "persistentvolumeclaims" => {
            delete_namespaced::<PersistentVolumeClaim>(client, required_namespace()?, name).await
        }
        "networkpolicies" => {
            delete_namespaced::<NetworkPolicy>(client, required_namespace()?, name).await
        }
        "serviceaccounts" => {
            delete_namespaced::<ServiceAccount>(client, required_namespace()?, name).await
        }
        "roles" => delete_namespaced::<Role>(client, required_namespace()?, name).await,
        "rolebindings" => {
            delete_namespaced::<RoleBinding>(client, required_namespace()?, name).await
        }
        "nodes" => delete_cluster::<Node>(client, name).await,
        "namespaces" => delete_cluster::<Namespace>(client, name).await,
        "persistentvolumes" => delete_cluster::<PersistentVolume>(client, name).await,
        "storageclasses" => delete_cluster::<StorageClass>(client, name).await,
        "clusterroles" => delete_cluster::<ClusterRole>(client, name).await,
        "clusterrolebindings" => delete_cluster::<ClusterRoleBinding>(client, name).await,
        "httproutes" => {
            delete_dynamic(
                client,
                &GroupVersionKind::gvk("gateway.networking.k8s.io", "v1", "HTTPRoute"),
                namespace,
                name,
            )
            .await
        }
        "gateways" => {
            delete_dynamic(
                client,
                &GroupVersionKind::gvk("gateway.networking.k8s.io", "v1", "Gateway"),
                namespace,
                name,
            )
            .await
        }
        "gatewayclasses" => {
            delete_dynamic(
                client,
                &GroupVersionKind::gvk("gateway.networking.k8s.io", "v1", "GatewayClass"),
                namespace,
                name,
            )
            .await
        }
        "referencegrants" => {
            delete_dynamic(
                client,
                &GroupVersionKind::gvk("gateway.networking.k8s.io", "v1beta1", "ReferenceGrant"),
                namespace,
                name,
            )
            .await
        }
        "grpcroutes" => {
            delete_dynamic(
                client,
                &GroupVersionKind::gvk("gateway.networking.k8s.io", "v1", "GRPCRoute"),
                namespace,
                name,
            )
            .await
        }
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
    scale_workload(client, "deployments", namespace, name, replicas).await
}

pub async fn scale_workload(
    client: Client,
    kind: &str,
    namespace: &str,
    name: &str,
    replicas: i32,
) -> Result<ResourceRow, AppError> {
    if !(0..=10_000).contains(&replicas) {
        return Err(AppError::bad_request(
            "replicas must be between 0 and 10000",
        ));
    }
    let patch = Patch::Merge(json!({ "spec": { "replicas": replicas } }));
    match kind.to_ascii_lowercase().replace(['-', '_'], "").as_str() {
        "deployments" | "deployment" => {
            let api: Api<Deployment> = Api::namespaced(client, namespace);
            Ok(deployment_row(
                &api.patch(name, &PatchParams::default(), &patch).await?,
            ))
        }
        "statefulsets" | "statefulset" => {
            let api: Api<StatefulSet> = Api::namespaced(client, namespace);
            Ok(stateful_set_row(
                &api.patch(name, &PatchParams::default(), &patch).await?,
            ))
        }
        "replicasets" | "replicaset" => {
            let api: Api<ReplicaSet> = Api::namespaced(client, namespace);
            Ok(replica_set_row(
                &api.patch(name, &PatchParams::default(), &patch).await?,
            ))
        }
        _ => Err(AppError::bad_request(format!(
            "resource kind '{kind}' cannot be scaled"
        ))),
    }
}

pub async fn restart_workload(
    client: Client,
    kind: &str,
    namespace: &str,
    name: &str,
) -> Result<ResourceRow, AppError> {
    let restarted_at = chrono::Utc::now().to_rfc3339();
    let patch = Patch::Merge(json!({
        "spec": { "template": { "metadata": { "annotations": { "kust.dev/restartedAt": restarted_at } } } }
    }));
    match kind.to_ascii_lowercase().replace(['-', '_'], "").as_str() {
        "deployments" | "deployment" => {
            let api: Api<Deployment> = Api::namespaced(client, namespace);
            Ok(deployment_row(
                &api.patch(name, &PatchParams::default(), &patch).await?,
            ))
        }
        "statefulsets" | "statefulset" => {
            let api: Api<StatefulSet> = Api::namespaced(client, namespace);
            Ok(stateful_set_row(
                &api.patch(name, &PatchParams::default(), &patch).await?,
            ))
        }
        "daemonsets" | "daemonset" => {
            let api: Api<DaemonSet> = Api::namespaced(client, namespace);
            Ok(daemon_set_row(
                &api.patch(name, &PatchParams::default(), &patch).await?,
            ))
        }
        _ => Err(AppError::bad_request(format!(
            "resource kind '{kind}' cannot be restarted"
        ))),
    }
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

pub async fn pod_containers(
    client: Client,
    namespace: &str,
    pod: &str,
) -> Result<crate::models::PodContainersResponse, AppError> {
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let pod = api.get(pod).await?;
    let spec = pod.spec.as_ref();
    Ok(crate::models::PodContainersResponse {
        containers: spec
            .map(|value| {
                value
                    .containers
                    .iter()
                    .map(|item| item.name.clone())
                    .collect()
            })
            .unwrap_or_default(),
        init_containers: spec
            .and_then(|value| value.init_containers.as_ref())
            .map(|items| items.iter().map(|item| item.name.clone()).collect())
            .unwrap_or_default(),
    })
}

fn container_params(container: Option<String>, tty: bool) -> AttachParams {
    let params = if tty {
        AttachParams::interactive_tty()
    } else {
        AttachParams::default()
            .stdin(true)
            .stdout(true)
            .stderr(true)
    };
    match container {
        Some(value) => params.container(value),
        None => params,
    }
}

async fn exec_capture(
    client: Client,
    namespace: &str,
    pod: &str,
    command: Vec<String>,
    container: Option<String>,
    input: Option<&[u8]>,
) -> Result<Vec<u8>, AppError> {
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let mut attached = api
        .exec(pod, command, &container_params(container, false))
        .await
        .map_err(AppError::from)?;
    let stdout = attached
        .stdout()
        .ok_or_else(|| AppError::internal("pod exec did not provide stdout"))?;
    let stderr = attached
        .stderr()
        .ok_or_else(|| AppError::internal("pod exec did not provide stderr"))?;
    if let Some(input) = input {
        let mut stdin = attached
            .stdin()
            .ok_or_else(|| AppError::internal("pod exec did not provide stdin"))?;
        stdin
            .write_all(input)
            .await
            .map_err(|error| AppError::upstream(format!("unable to write pod stdin: {error}")))?;
        stdin
            .shutdown()
            .await
            .map_err(|error| AppError::upstream(format!("unable to close pod stdin: {error}")))?;
    }
    let mut output = Vec::new();
    let mut errors = Vec::new();
    stdout
        .take(4_000_001)
        .read_to_end(&mut output)
        .await
        .map_err(|error| AppError::upstream(format!("unable to read pod stdout: {error}")))?;
    stderr
        .take(32_769)
        .read_to_end(&mut errors)
        .await
        .map_err(|error| AppError::upstream(format!("unable to read pod stderr: {error}")))?;
    attached
        .join()
        .await
        .map_err(|error| AppError::upstream(format!("pod exec failed: {error}")))?;
    if !errors.is_empty() {
        let message = String::from_utf8_lossy(&errors).trim().to_string();
        if !message.is_empty() {
            return Err(AppError::upstream(message));
        }
    }
    Ok(output)
}

fn normalized_file_path(path: &str) -> Result<String, AppError> {
    if path.contains('\0') {
        return Err(AppError::bad_request(
            "file path contains an invalid character",
        ));
    }
    let path = if path.trim().is_empty() {
        "/"
    } else {
        path.trim()
    };
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{}", path)
    };
    if path.split('/').any(|segment| segment == "..") {
        return Err(AppError::bad_request(
            "parent path segments are not allowed",
        ));
    }
    Ok(path)
}

pub async fn pod_file_tree(
    client: Client,
    namespace: &str,
    pod: &str,
    path: &str,
    container: Option<String>,
) -> Result<crate::models::FileTreeResponse, AppError> {
    let path = normalized_file_path(path)?;
    let script = r#"for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  name=$(basename "$entry")
  if [ -L "$entry" ]; then
    printf 'l\t%s\t0\n' "$name"
  elif [ -d "$entry" ]; then
    printf 'd\t%s\t0\n' "$name"
  else
    size=$(wc -c < "$entry" 2>/dev/null || printf '0')
    printf 'f\t%s\t%s\n' "$name" "$size"
  fi
done"#;
    let output = exec_capture(
        client,
        namespace,
        pod,
        vec![
            "sh".into(),
            "-c".into(),
            script.into(),
            "kust-file-list".into(),
            path.clone(),
        ],
        container,
        None,
    )
    .await?;
    let mut entries = String::from_utf8_lossy(&output)
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let kind = parts.next()?;
            let name = parts.next()?.to_string();
            let size = parts.next().and_then(|value| value.trim().parse().ok());
            let entry_path = if path == "/" {
                format!("/{name}")
            } else {
                format!("{}/{}", path.trim_end_matches('/'), name)
            };
            Some(crate::models::FileEntry {
                name,
                path: entry_path,
                kind: match kind {
                    "d" => "directory",
                    "l" => "symlink",
                    _ => "file",
                }
                .into(),
                size,
                mode: None,
                modified_at: None,
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| (entry.kind != "directory", entry.name.to_ascii_lowercase()));
    Ok(crate::models::FileTreeResponse { path, entries })
}

pub async fn pod_read_file(
    client: Client,
    namespace: &str,
    pod: &str,
    path: &str,
    container: Option<String>,
) -> Result<crate::models::FileContentResponse, AppError> {
    let path = normalized_file_path(path)?;
    let output = exec_capture(
        client,
        namespace,
        pod,
        vec![
            "sh".into(),
            "-c".into(),
            "cat -- \"$1\"".into(),
            "kust-file-read".into(),
            path.clone(),
        ],
        container,
        None,
    )
    .await?;
    let truncated = output.len() >= 4_000_001;
    Ok(crate::models::FileContentResponse {
        path,
        content: String::from_utf8_lossy(&output[..output.len().min(4_000_000)]).into(),
        truncated,
    })
}

pub async fn pod_write_file(
    client: Client,
    namespace: &str,
    pod: &str,
    path: &str,
    content: &str,
    container: Option<String>,
) -> Result<u64, AppError> {
    let path = normalized_file_path(path)?;
    if content.len() > 4_000_000 {
        return Err(AppError::bad_request("file content is too large"));
    }
    exec_capture(
        client,
        namespace,
        pod,
        vec![
            "sh".into(),
            "-c".into(),
            "mkdir -p \"$(dirname -- \"$1\")\" && cat > \"$1\"".into(),
            "kust-file-write".into(),
            path,
        ],
        container,
        Some(content.as_bytes()),
    )
    .await?;
    Ok(content.len() as u64)
}

pub async fn pod_make_directory(
    client: Client,
    namespace: &str,
    pod: &str,
    path: &str,
    container: Option<String>,
) -> Result<(), AppError> {
    let path = normalized_file_path(path)?;
    exec_capture(
        client,
        namespace,
        pod,
        vec![
            "sh".into(),
            "-c".into(),
            "mkdir -p -- \"$1\"".into(),
            "kust-file-mkdir".into(),
            path,
        ],
        container,
        None,
    )
    .await?;
    Ok(())
}

pub async fn pod_delete_file(
    client: Client,
    namespace: &str,
    pod: &str,
    path: &str,
    container: Option<String>,
) -> Result<(), AppError> {
    let path = normalized_file_path(path)?;
    if path == "/" {
        return Err(AppError::bad_request(
            "the root directory cannot be deleted",
        ));
    }
    exec_capture(
        client,
        namespace,
        pod,
        vec![
            "sh".into(),
            "-c".into(),
            "rm -rf -- \"$1\"".into(),
            "kust-file-delete".into(),
            path,
        ],
        container,
        None,
    )
    .await?;
    Ok(())
}

pub async fn pod_shell(
    client: Client,
    namespace: &str,
    pod: &str,
    container: Option<String>,
) -> Result<kube::api::AttachedProcess, AppError> {
    let api: Api<Pod> = Api::namespaced(client, namespace);
    api.exec(
        pod,
        vec!["/bin/sh".to_string()],
        &container_params(container, true),
    )
    .await
    .map_err(AppError::from)
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
        "replicationcontrollers" => ("", "v1", "ReplicationController"),
        "controllerrevisions" => ("apps", "v1", "ControllerRevision"),
        "horizontalpodautoscalers" => ("autoscaling", "v2", "HorizontalPodAutoscaler"),
        "poddisruptionbudgets" => ("policy", "v1", "PodDisruptionBudget"),
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
        "volumeattachments" => ("storage.k8s.io", "v1", "VolumeAttachment"),
        "serviceaccounts" => ("", "v1", "ServiceAccount"),
        "roles" => ("rbac.authorization.k8s.io", "v1", "Role"),
        "rolebindings" => ("rbac.authorization.k8s.io", "v1", "RoleBinding"),
        "clusterroles" => ("rbac.authorization.k8s.io", "v1", "ClusterRole"),
        "clusterrolebindings" => ("rbac.authorization.k8s.io", "v1", "ClusterRoleBinding"),
        "priorityclasses" => ("scheduling.k8s.io", "v1", "PriorityClass"),
        "runtimeclasses" => ("node.k8s.io", "v1", "RuntimeClass"),
        "leases" => ("coordination.k8s.io", "v1", "Lease"),
        "resourcequotas" => ("", "v1", "ResourceQuota"),
        "limitranges" => ("", "v1", "LimitRange"),
        "customresourcedefinitions" => ("apiextensions.k8s.io", "v1", "CustomResourceDefinition"),
        "httproutes" => ("gateway.networking.k8s.io", "v1", "HTTPRoute"),
        "gateways" => ("gateway.networking.k8s.io", "v1", "Gateway"),
        "gatewayclasses" => ("gateway.networking.k8s.io", "v1", "GatewayClass"),
        "referencegrants" => ("gateway.networking.k8s.io", "v1beta1", "ReferenceGrant"),
        "grpcroutes" => ("gateway.networking.k8s.io", "v1", "GRPCRoute"),
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

pub async fn apply_hosted_application(
    client: Client,
    application: &HostedApplicationDocument,
    image_digest_ref: &str,
    proxy_image: &str,
    image_pull_secret: Option<&str>,
) -> Result<(), AppError> {
    for kind in ["deployments", "services", "httproutes"] {
        ensure_hosted_resource_ownership(client.clone(), application, kind).await?;
    }
    let labels = json!({
        "app.kubernetes.io/name": application.slug,
        "app.kubernetes.io/managed-by": "kust",
        "kust.dev/application-id": application.id.to_hex(),
        "kust.dev/application-slug": application.slug,
    });
    // Traefik's Gateway provider selects HTTPS upstream transport from a Service
    // port whose name starts with "https". Keep the Pod, Service, and probes
    // on the same named port so an HTTPS backend is routed consistently.
    let port_name = if application.service_scheme == "HTTPS" {
        "https"
    } else {
        "http"
    };
    let proxy_port_name = "proxy";
    let probe = json!({
        "httpGet": {"path": application.health_path, "port": port_name, "scheme": application.health_scheme}
    });
    let security_context = if application.runtime_profile == "root_compatible" {
        // Some supported upstream images, including LinuxServer images, use an
        // init process that manages users and groups before starting the app.
        // This profile is an explicit opt-in for that compatibility contract.
        serde_json::Value::Null
    } else {
        json!({"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": false, "capabilities": {"drop": ["ALL"]}})
    };
    let mut container = json!({
        "name": "app", "image": image_digest_ref,
        "ports": [{"containerPort": application.container_port, "name": port_name}],
        "env": application.runtime_environment.iter().map(|(name, value)| json!({"name": name, "value": value})).collect::<Vec<_>>(),
        "readinessProbe": {"httpGet": probe["httpGet"], "periodSeconds": 8},
        "livenessProbe": {"httpGet": probe["httpGet"], "periodSeconds": 16},
        "startupProbe": {"httpGet": probe["httpGet"], "periodSeconds": 5, "failureThreshold": 120}
    });
    if !security_context.is_null() {
        container["securityContext"] = security_context;
    }
    let proxy_container = json!({
        "name": "kust-proxy",
        "image": proxy_image,
        "ports": [{"containerPort": 8080, "name": proxy_port_name}],
        "env": [
            {"name": "NGINX_ENVSUBST_FILTER", "value": "^KUST_APP_"},
            {"name": "KUST_APP_ROUTE_PATH", "value": application.route_path},
            {"name": "KUST_APP_UPSTREAM_PORT", "value": application.container_port.to_string()},
            {"name": "KUST_APP_UPSTREAM_SCHEME", "value": application.service_scheme.to_lowercase()}
        ],
        "readinessProbe": {"httpGet": {"path": "/_kust_proxy/healthz", "port": proxy_port_name}, "periodSeconds": 5},
        "livenessProbe": {"httpGet": {"path": "/_kust_proxy/healthz", "port": proxy_port_name}, "periodSeconds": 10},
        "volumeMounts": [{"name": "proxy-tmp", "mountPath": "/tmp"}],
        "securityContext": {"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": false, "capabilities": {"drop": ["ALL"]}}
    });
    let mut pod_spec = json!({
        "securityContext": {"runAsNonRoot": application.runtime_profile != "root_compatible"},
        "containers": [container, proxy_container],
        "volumes": [{"name": "proxy-tmp", "emptyDir": {}}]
    });
    if application.runtime_profile == "root_compatible" {
        pod_spec
            .as_object_mut()
            .expect("hosted application pod spec must be an object")
            .remove("securityContext");
    }
    if let Some(name) = image_pull_secret {
        pod_spec["imagePullSecrets"] = json!([{"name": name}]);
    }
    let deployment = json!({
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": {"name": application.slug, "namespace": application.namespace, "labels": labels},
        "spec": {
            "replicas": application.replicas,
            "selector": {"matchLabels": {"app.kubernetes.io/name": application.slug}},
            "template": {
                "metadata": {"labels": labels},
                "spec": pod_spec
            }
        }
    });
    let service = json!({
        "apiVersion": "v1", "kind": "Service",
        "metadata": {"name": application.slug, "namespace": application.namespace, "labels": labels},
        "spec": {"selector": {"app.kubernetes.io/name": application.slug}, "ports": [{"name": proxy_port_name, "port": 8080, "targetPort": proxy_port_name, "appProtocol": "http"}]}
    });
    let route = json!({
        "apiVersion": "gateway.networking.k8s.io/v1", "kind": "HTTPRoute",
        "metadata": {"name": application.slug, "namespace": application.namespace, "labels": labels},
        "spec": {
            "parentRefs": [{"name": application.gateway_name, "namespace": application.gateway_namespace}],
            "hostnames": [application.route_host],
            "rules": [{
                "matches": [{"path": {"type": "PathPrefix", "value": application.route_path}}],
                "backendRefs": [{"name": application.slug, "port": 8080}]
            }]
        }
    });
    for manifest in [deployment, service, route] {
        let yaml = serde_yaml::to_string(&manifest).map_err(|error| {
            AppError::internal(format!(
                "unable to render hosted application manifest: {error}"
            ))
        })?;
        apply_yaml(client.clone(), &yaml, Some(&application.namespace)).await?;
    }
    Ok(())
}

async fn ensure_hosted_resource_ownership(
    client: Client,
    application: &HostedApplicationDocument,
    kind: &str,
) -> Result<(), AppError> {
    match resource_yaml(
        client,
        kind,
        Some(&application.namespace),
        &application.slug,
    )
    .await
    {
        Ok(yaml) => {
            let value: Value = serde_yaml::from_str(&yaml).map_err(|error| {
                AppError::internal(format!(
                    "unable to inspect existing hosted application resource: {error}"
                ))
            })?;
            let owner = value
                .get("metadata")
                .and_then(|metadata| metadata.get("labels"))
                .and_then(|labels| labels.get("kust.dev/application-id"))
                .and_then(Value::as_str);
            if owner != Some(application.id.to_hex().as_str()) {
                return Err(AppError::conflict(format!(
                    "{kind}/{} already exists and is not managed by this hosted application",
                    application.slug
                )));
            }
            Ok(())
        }
        Err(error)
            if error.to_string().contains("404") || error.to_string().contains("not found") =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

pub async fn wait_for_hosted_application_ready(
    client: Client,
    application: &HostedApplicationDocument,
    timeout: Duration,
) -> Result<(), AppError> {
    let deadline = Instant::now() + timeout;
    let deployment_api: Api<Deployment> = Api::namespaced(client.clone(), &application.namespace);

    loop {
        let deployment = deployment_api.get(&application.slug).await?;
        let desired = deployment
            .spec
            .as_ref()
            .and_then(|spec| spec.replicas)
            .unwrap_or(1);
        let status = deployment.status.as_ref();
        let ready = status.and_then(|status| status.ready_replicas).unwrap_or(0);
        let updated = status
            .and_then(|status| status.updated_replicas)
            .unwrap_or(0);
        let observed = status
            .and_then(|status| status.observed_generation)
            .unwrap_or_default();
        let generation = deployment.metadata.generation.unwrap_or_default();
        if observed >= generation
            && ready >= desired
            && updated >= desired
            && hosted_route_accepted(client.clone(), application).await?
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(AppError::upstream(format!(
                "hosted application did not become ready within {} seconds",
                timeout.as_secs()
            )));
        }
        sleep(Duration::from_secs(3)).await;
    }
}

async fn hosted_route_accepted(
    client: Client,
    application: &HostedApplicationDocument,
) -> Result<bool, AppError> {
    let discovery = Discovery::new(client.clone()).run().await?;
    let gvk = GroupVersionKind::gvk("gateway.networking.k8s.io", "v1", "HTTPRoute");
    let (resource, _) = discovery
        .resolve_gvk(&gvk)
        .ok_or_else(|| AppError::bad_request("the cluster does not expose HTTPRoute"))?;
    let route: DynamicObject = Api::namespaced_with(client, &application.namespace, &resource)
        .get(&application.slug)
        .await?;
    let parents = route
        .data
        .get("status")
        .and_then(|status| status.get("parents"))
        .and_then(Value::as_array);
    Ok(parents.is_some_and(|parents| {
        parents.iter().any(|parent| {
            parent
                .get("conditions")
                .and_then(Value::as_array)
                .is_some_and(|conditions| {
                    ["Accepted", "ResolvedRefs"].iter().all(|expected| {
                        conditions.iter().any(|condition| {
                            condition.get("type").and_then(Value::as_str) == Some(*expected)
                                && condition.get("status").and_then(Value::as_str) == Some("True")
                        })
                    })
                })
        })
    }))
}

pub async fn delete_hosted_application(
    client: Client,
    application: &HostedApplicationDocument,
) -> Result<(), AppError> {
    for kind in ["httproutes", "services", "deployments"] {
        ensure_hosted_resource_ownership(client.clone(), application, kind).await?;
        match delete_resource(
            client.clone(),
            kind,
            Some(&application.namespace),
            &application.slug,
        )
        .await
        {
            Ok(()) => {}
            Err(error)
                if error.to_string().contains("404") || error.to_string().contains("not found") => {
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
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

    #[test]
    fn file_paths_are_absolute_without_parent_segments() {
        assert_eq!(
            normalized_file_path("etc/app/config.yaml").unwrap(),
            "/etc/app/config.yaml"
        );
        assert_eq!(normalized_file_path("/").unwrap(), "/");
        assert!(normalized_file_path("/etc/../passwd").is_err());
        assert!(normalized_file_path("/tmp/\0file").is_err());
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
