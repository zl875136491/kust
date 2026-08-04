use std::collections::{HashMap, HashSet};

use futures::TryStreamExt;
use mongodb::bson::{doc, oid::ObjectId, DateTime};

use crate::{
    error::AppError,
    kubernetes,
    models::{
        ClusterDocument, OverviewResponse, ResourceListResponse, ResourceMapEdge, ResourceMapNode,
        ResourceMapResponse, ResourceRow, ResourceSnapshotDocument, SearchResult, StatusCount,
    },
    state::SharedState,
};

pub const RESOURCE_KINDS: &[&str] = &[
    "namespaces",
    "nodes",
    "events",
    "pods",
    "deployments",
    "statefulsets",
    "daemonsets",
    "replicasets",
    "jobs",
    "cronjobs",
    "persistentvolumeclaims",
    "persistentvolumes",
    "storageclasses",
    "services",
    "endpoints",
    "endpointslices",
    "ingresses",
    "networkpolicies",
    "httproutes",
    "gateways",
    "gatewayclasses",
    "referencegrants",
    "grpcroutes",
    "serviceaccounts",
    "roles",
    "rolebindings",
    "clusterroles",
    "clusterrolebindings",
    "configmaps",
    "secrets",
];

pub fn normalize_kind(kind: &str) -> String {
    let normalized = kind.to_ascii_lowercase().replace(['-', '_'], "");
    match normalized.as_str() {
        "pod" => "pods",
        "deployment" => "deployments",
        "statefulset" => "statefulsets",
        "daemonset" => "daemonsets",
        "replicaset" => "replicasets",
        "job" => "jobs",
        "cronjob" => "cronjobs",
        "node" => "nodes",
        "namespace" => "namespaces",
        "service" => "services",
        "ingress" => "ingresses",
        "configmap" => "configmaps",
        "secret" => "secrets",
        "persistentvolumeclaim" => "persistentvolumeclaims",
        "persistentvolume" => "persistentvolumes",
        "event" => "events",
        "httproute" => "httproutes",
        "gateway" => "gateways",
        "gatewayclass" => "gatewayclasses",
        "referencegrant" => "referencegrants",
        "grpcroute" => "grpcroutes",
        "endpoint" => "endpoints",
        "endpointslice" => "endpointslices",
        "networkpolicy" => "networkpolicies",
        "serviceaccount" => "serviceaccounts",
        "role" => "roles",
        "rolebinding" => "rolebindings",
        "clusterrole" => "clusterroles",
        "clusterrolebinding" => "clusterrolebindings",
        "storageclass" => "storageclasses",
        _ => normalized.as_str(),
    }
    .to_string()
}

pub async fn sync_kind(
    state: &SharedState,
    cluster_id: &str,
    kind: &str,
) -> Result<ResourceListResponse, AppError> {
    let normalized = normalize_kind(kind);
    if !RESOURCE_KINDS.contains(&normalized.as_str()) {
        return Err(AppError::bad_request(format!(
            "resource kind '{kind}' is not supported"
        )));
    }
    let object_id = ObjectId::parse_str(cluster_id)
        .map_err(|_| AppError::bad_request("cluster id is invalid"))?;
    let client = state.kube_client(cluster_id).await?;
    let response = kubernetes::list_resources(client, &normalized, None, None).await?;
    let snapshot = ResourceSnapshotDocument {
        id: None,
        cluster_id: object_id,
        kind: normalized.clone(),
        response: response.clone(),
        synced_at: DateTime::now(),
    };
    state
        .resource_snapshots
        .replace_one(
            doc! { "cluster_id": object_id, "kind": &normalized },
            &snapshot,
        )
        .upsert(true)
        .await?;
    Ok(response)
}

async fn snapshot(
    state: &SharedState,
    cluster_id: &str,
    kind: &str,
) -> Result<ResourceSnapshotDocument, AppError> {
    let object_id = ObjectId::parse_str(cluster_id)
        .map_err(|_| AppError::bad_request("cluster id is invalid"))?;
    let normalized = normalize_kind(kind);
    let mut stored = state
        .resource_snapshots
        .find_one(doc! { "cluster_id": object_id, "kind": &normalized })
        .await?;
    if stored.is_none() {
        sync_kind(state, cluster_id, &normalized).await?;
        stored = state
            .resource_snapshots
            .find_one(doc! { "cluster_id": object_id, "kind": &normalized })
            .await?;
    }
    let stored = stored.ok_or_else(|| AppError::internal("resource cache was not written"))?;
    let age_ms = DateTime::now()
        .timestamp_millis()
        .saturating_sub(stored.synced_at.timestamp_millis());
    if age_ms > (state.config.cache_ttl_seconds as i64 * 1_000) {
        let state = state.clone();
        let cluster_id = cluster_id.to_string();
        let kind = normalized;
        tokio::spawn(async move {
            if let Err(error) = sync_kind(&state, &cluster_id, &kind).await {
                tracing::warn!(%error, %cluster_id, %kind, "background resource refresh failed");
            }
        });
    }
    Ok(stored)
}

pub async fn list_resources(
    state: &SharedState,
    cluster_id: &str,
    kind: &str,
    namespace: Option<&str>,
    label_selector: Option<&str>,
) -> Result<ResourceListResponse, AppError> {
    let mut response = snapshot(state, cluster_id, kind).await?.response;
    response.items.retain(|item| {
        let namespace_matches = namespace
            .filter(|value| !value.is_empty() && *value != "all")
            .is_none_or(|value| item.namespace.as_deref() == Some(value));
        namespace_matches && labels_match(&item.labels, label_selector)
    });
    Ok(response)
}

fn labels_match(
    labels: &std::collections::BTreeMap<String, String>,
    selector: Option<&str>,
) -> bool {
    selector
        .filter(|value| !value.trim().is_empty())
        .is_none_or(|selector| {
            selector.split(',').all(|part| {
                let part = part.trim();
                match part.split_once('=') {
                    Some((key, value)) => labels
                        .get(key.trim())
                        .is_some_and(|item| item == value.trim()),
                    None => labels.contains_key(part),
                }
            })
        })
}

pub async fn overview(state: &SharedState, cluster_id: &str) -> Result<OverviewResponse, AppError> {
    let pods = snapshot(state, cluster_id, "pods").await?.response.items;
    let nodes = snapshot(state, cluster_id, "nodes").await?.response.items;
    let mut workloads = Vec::new();
    for kind in [
        "deployments",
        "statefulsets",
        "daemonsets",
        "jobs",
        "cronjobs",
    ] {
        if let Ok(value) = snapshot(state, cluster_id, kind).await {
            workloads.extend(value.response.items);
        }
    }
    let mut events = snapshot(state, cluster_id, "events")
        .await
        .map(|value| value.response.items)
        .unwrap_or_default();
    events.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    events.truncate(40);
    Ok(OverviewResponse {
        cpu_percent: None,
        memory_percent: None,
        pods: StatusCount {
            healthy: pods
                .iter()
                .filter(|item| matches!(item.status.as_str(), "Running" | "Succeeded"))
                .count(),
            total: pods.len(),
        },
        nodes: StatusCount {
            healthy: nodes.iter().filter(|item| item.status == "Ready").count(),
            total: nodes.len(),
        },
        workloads,
        events,
    })
}

pub async fn search(
    state: &SharedState,
    query: &str,
    cluster_id: Option<&str>,
    limit: usize,
) -> Result<Vec<SearchResult>, AppError> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let cluster_filter = match cluster_id {
        Some(value) => Some(
            ObjectId::parse_str(value)
                .map_err(|_| AppError::bad_request("cluster id is invalid"))?,
        ),
        None => None,
    };
    let clusters: Vec<ClusterDocument> = state.clusters.find(doc! {}).await?.try_collect().await?;
    let cluster_names: HashMap<ObjectId, String> = clusters
        .iter()
        .map(|cluster| (cluster.id, cluster.name.clone()))
        .collect();
    let mut ranked = Vec::new();
    for cluster in clusters {
        if cluster_filter.is_some_and(|id| id != cluster.id) {
            continue;
        }
        if format!(
            "{} {} {}",
            cluster.name, cluster.description, cluster.server
        )
        .to_lowercase()
        .contains(&needle)
        {
            let cluster_name = cluster.name.to_lowercase();
            let score = if cluster_name == needle {
                120
            } else if cluster_name.starts_with(&needle) {
                105
            } else {
                85
            };
            ranked.push((
                score,
                SearchResult {
                    id: format!("cluster:{}", cluster.id),
                    title: cluster.name,
                    subtitle: cluster.description,
                    category: "集群".into(),
                    cluster_id: Some(cluster.id.to_hex()),
                    path: format!("/cluster/{}", cluster.id),
                    status: None,
                },
            ));
        }
    }
    let filter = cluster_filter
        .map(|id| doc! { "cluster_id": id })
        .unwrap_or_default();
    let snapshots: Vec<ResourceSnapshotDocument> = state
        .resource_snapshots
        .find(filter)
        .await?
        .try_collect()
        .await?;
    for snapshot in snapshots {
        for row in snapshot.response.items {
            let labels = row
                .labels
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
                .join(" ");
            let name = row.name.to_lowercase();
            let kind = row.kind.to_lowercase();
            let namespace = row.namespace.as_deref().unwrap_or_default().to_lowercase();
            let status = row.status.to_lowercase();
            let labels = labels.to_lowercase();
            let details = row.details.to_string().to_lowercase();
            let score = if name == needle {
                120
            } else if kind == needle || normalize_kind(&kind) == normalize_kind(&needle) {
                110
            } else if name.starts_with(&needle) {
                100
            } else if name.contains(&needle) {
                90
            } else if kind.contains(&needle) {
                72
            } else if namespace.contains(&needle) {
                55
            } else if labels.contains(&needle) {
                40
            } else if status.contains(&needle) {
                30
            } else if details.contains(&needle) {
                15
            } else {
                0
            };
            if score == 0 {
                continue;
            }
            let cluster_name = cluster_names
                .get(&snapshot.cluster_id)
                .cloned()
                .unwrap_or_else(|| "集群".into());
            let focus =
                url::form_urlencoded::byte_serialize(row.uid.as_bytes()).collect::<String>();
            ranked.push((
                score,
                SearchResult {
                    id: format!("{}:{}", snapshot.cluster_id, row.uid),
                    title: row.name,
                    subtitle: format!(
                        "{} · {} · {}",
                        cluster_name,
                        row.kind,
                        row.namespace.as_deref().unwrap_or("cluster")
                    ),
                    category: row.kind,
                    cluster_id: Some(snapshot.cluster_id.to_hex()),
                    path: format!(
                        "/cluster/{}/resources/{}?focus={}",
                        snapshot.cluster_id, snapshot.kind, focus
                    ),
                    status: Some(row.status),
                },
            ));
        }
    }
    ranked.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.title.cmp(&right.1.title))
    });
    Ok(ranked
        .into_iter()
        .take(limit)
        .map(|(_, result)| result)
        .collect())
}

pub async fn resource_map(
    state: &SharedState,
    cluster_id: &str,
) -> Result<ResourceMapResponse, AppError> {
    let map_kinds = [
        "nodes",
        "pods",
        "deployments",
        "statefulsets",
        "daemonsets",
        "services",
        "ingresses",
        "gateways",
        "httproutes",
        "persistentvolumeclaims",
    ];
    let mut snapshots = Vec::new();
    for kind in map_kinds {
        if let Ok(value) = snapshot(state, cluster_id, kind).await {
            snapshots.push((kind.to_string(), value));
        }
    }
    let mut rows_by_kind: HashMap<String, Vec<ResourceRow>> = HashMap::new();
    let mut latest: Option<DateTime> = None;
    for (kind, value) in snapshots {
        if latest.is_none_or(|current| value.synced_at > current) {
            latest = Some(value.synced_at);
        }
        rows_by_kind.insert(kind, value.response.items);
    }

    let mut nodes = Vec::new();
    let limits: HashMap<&str, usize> = HashMap::from([
        ("pods", 90),
        ("nodes", 30),
        ("services", 50),
        ("deployments", 50),
        ("statefulsets", 30),
        ("daemonsets", 30),
        ("ingresses", 30),
        ("gateways", 30),
        ("httproutes", 50),
        ("persistentvolumeclaims", 30),
    ]);
    for (kind, rows) in &rows_by_kind {
        for row in rows.iter().take(*limits.get(kind.as_str()).unwrap_or(&30)) {
            nodes.push(ResourceMapNode {
                id: map_node_id(kind, row.namespace.as_deref(), &row.name),
                label: row.name.clone(),
                kind: row.kind.clone(),
                namespace: row.namespace.clone(),
                status: row.status.clone(),
                group: map_group(kind).into(),
                resource_kind: kind.clone(),
            });
        }
    }
    let node_ids: HashSet<String> = nodes.iter().map(|node| node.id.clone()).collect();
    let mut edges = Vec::new();
    let mut edge_ids = HashSet::new();
    let pods = rows_by_kind.get("pods").cloned().unwrap_or_default();

    for pod in &pods {
        if let Some(node) = pod.node.as_deref() {
            add_edge(
                &mut edges,
                &mut edge_ids,
                &node_ids,
                map_node_id("pods", pod.namespace.as_deref(), &pod.name),
                map_node_id("nodes", None, node),
                "运行于",
            );
        }
    }
    for kind in ["deployments", "statefulsets", "daemonsets"] {
        for workload in rows_by_kind.get(kind).into_iter().flatten() {
            for pod in &pods {
                if workload.namespace == pod.namespace
                    && (pod.name.starts_with(&format!("{}-", workload.name))
                        || selector_matches(workload, pod))
                {
                    add_edge(
                        &mut edges,
                        &mut edge_ids,
                        &node_ids,
                        map_node_id(kind, workload.namespace.as_deref(), &workload.name),
                        map_node_id("pods", pod.namespace.as_deref(), &pod.name),
                        "管理",
                    );
                }
            }
        }
    }
    for service in rows_by_kind.get("services").into_iter().flatten() {
        for pod in &pods {
            if service.namespace == pod.namespace && selector_matches(service, pod) {
                add_edge(
                    &mut edges,
                    &mut edge_ids,
                    &node_ids,
                    map_node_id("services", service.namespace.as_deref(), &service.name),
                    map_node_id("pods", pod.namespace.as_deref(), &pod.name),
                    "路由至",
                );
            }
        }
    }
    for ingress in rows_by_kind.get("ingresses").into_iter().flatten() {
        for backend in detail_names(ingress, "backends") {
            add_edge(
                &mut edges,
                &mut edge_ids,
                &node_ids,
                map_node_id("ingresses", ingress.namespace.as_deref(), &ingress.name),
                map_node_id("services", ingress.namespace.as_deref(), &backend),
                "转发至",
            );
        }
    }
    for route in rows_by_kind.get("httproutes").into_iter().flatten() {
        for backend in detail_names(route, "backendRefs") {
            add_edge(
                &mut edges,
                &mut edge_ids,
                &node_ids,
                map_node_id("httproutes", route.namespace.as_deref(), &route.name),
                map_node_id("services", route.namespace.as_deref(), &backend),
                "转发至",
            );
        }
        for gateway in detail_names(route, "parentRefs") {
            add_edge(
                &mut edges,
                &mut edge_ids,
                &node_ids,
                map_node_id("gateways", route.namespace.as_deref(), &gateway),
                map_node_id("httproutes", route.namespace.as_deref(), &route.name),
                "承载",
            );
        }
    }

    Ok(ResourceMapResponse {
        nodes,
        edges,
        synced_at: latest.and_then(|value| value.try_to_rfc3339_string().ok()),
    })
}

fn selector_matches(owner: &ResourceRow, target: &ResourceRow) -> bool {
    owner
        .details
        .get("selector")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|selector| {
            !selector.is_empty()
                && selector.iter().all(|(key, value)| {
                    value.as_str().is_some_and(|value| {
                        target.labels.get(key).is_some_and(|label| label == value)
                    })
                })
        })
}

fn detail_names(row: &ResourceRow, key: &str) -> Vec<String> {
    row.details
        .get(key)
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.as_str().map(str::to_string).or_else(|| {
                        item.get("name")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string)
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn map_node_id(kind: &str, namespace: Option<&str>, name: &str) -> String {
    format!("{kind}:{}:{name}", namespace.unwrap_or("_"))
}

fn map_group(kind: &str) -> &'static str {
    match kind {
        "ingresses" | "gateways" | "httproutes" => "entry",
        "services" => "network",
        "deployments" | "statefulsets" | "daemonsets" => "workload",
        "pods" => "pod",
        "nodes" => "node",
        "persistentvolumeclaims" => "storage",
        _ => "other",
    }
}

fn add_edge(
    edges: &mut Vec<ResourceMapEdge>,
    ids: &mut HashSet<String>,
    node_ids: &HashSet<String>,
    source: String,
    target: String,
    relation: &str,
) {
    if !node_ids.contains(&source) || !node_ids.contains(&target) {
        return;
    }
    let id = format!("{source}>{target}");
    if ids.insert(id.clone()) {
        edges.push(ResourceMapEdge {
            id,
            source,
            target,
            relation: relation.into(),
        });
    }
}

pub async fn remove_cluster(state: &SharedState, cluster_id: ObjectId) -> Result<(), AppError> {
    state
        .resource_snapshots
        .delete_many(doc! { "cluster_id": cluster_id })
        .await?;
    Ok(())
}

pub fn start_background_sync(state: SharedState) {
    tokio::spawn(async move {
        loop {
            if let Err(error) = sync_all(&state).await {
                tracing::warn!(%error, "resource cache synchronization failed");
            }
            tokio::time::sleep(std::time::Duration::from_secs(
                state.config.cache_sync_seconds.max(15),
            ))
            .await;
        }
    });
}

async fn sync_all(state: &SharedState) -> Result<(), AppError> {
    let clusters: Vec<ClusterDocument> = state.clusters.find(doc! {}).await?.try_collect().await?;
    for cluster in clusters {
        let cluster_id = cluster.id.to_hex();
        for kind in RESOURCE_KINDS {
            if let Err(error) = sync_kind(state, &cluster_id, kind).await {
                tracing::debug!(%error, cluster = %cluster.name, %kind, "resource kind sync skipped");
            }
        }
    }
    Ok(())
}
