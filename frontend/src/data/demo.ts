import type { Cluster, Overview, ResourceRow } from '../types';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const resource = (
  kind: string,
  name: string,
  namespace: string | undefined,
  status: string,
  options: Partial<ResourceRow> = {},
): ResourceRow => ({
  uid: `${kind.toLowerCase()}-${namespace || 'cluster'}-${name}`,
  name,
  namespace,
  kind,
  status,
  createdAt: ago(60 * 24 * 18),
  labels: { app: name.split('-')[0], 'app.kubernetes.io/managed-by': 'kust' },
  details: {},
  ...options,
});

export const demoClusters: Cluster[] = [
  {
    id: 'demo-prod',
    name: 'prod-shanghai',
    description: '生产集群 · 华东区域',
    context: 'prod-shanghai-admin',
    server: 'https://10.24.0.12:6443',
    kubernetesVersion: 'v1.31.4',
    status: 'connected',
    createdAt: ago(60 * 24 * 180),
    lastConnectedAt: ago(1),
    warnings: 3,
    accent: '#2e7d69',
  },
  {
    id: 'demo-staging',
    name: 'staging-hangzhou',
    description: '预发布与集成测试',
    context: 'staging',
    server: 'https://10.42.8.10:6443',
    kubernetesVersion: 'v1.30.8',
    status: 'connected',
    createdAt: ago(60 * 24 * 94),
    lastConnectedAt: ago(8),
    warnings: 0,
    accent: '#3578c4',
  },
  {
    id: 'demo-edge',
    name: 'edge-lab',
    description: '边缘节点实验环境',
    context: 'edge-lab',
    server: 'https://172.20.0.5:6443',
    kubernetesVersion: 'v1.29.7',
    status: 'disconnected',
    createdAt: ago(60 * 24 * 42),
    lastConnectedAt: ago(60 * 19),
    warnings: 1,
    accent: '#b46a42',
  },
];

const pods: ResourceRow[] = [
  resource('Pod', 'api-gateway-7d6c8b56d9-9hz8q', 'commerce', 'Running', {
    ready: '2/2', restarts: 0, node: 'worker-cn-01', createdAt: ago(42),
    details: { podIP: '10.244.2.41', qosClass: 'Burstable', images: ['registry.local/api-gateway:2.8.1', 'envoyproxy/envoy:v1.31'], containers: ['gateway', 'envoy'] },
  }),
  resource('Pod', 'checkout-6b9f79d8bf-jz2km', 'commerce', 'Running', {
    ready: '1/1', restarts: 1, node: 'worker-cn-02', createdAt: ago(185),
    details: { podIP: '10.244.3.18', qosClass: 'Burstable', images: ['registry.local/checkout:1.14.0'], containers: ['checkout'] },
  }),
  resource('Pod', 'catalog-66d78cc95f-v7x4m', 'commerce', 'Running', {
    ready: '1/1', restarts: 0, node: 'worker-cn-03', createdAt: ago(288),
    details: { podIP: '10.244.4.77', qosClass: 'Guaranteed', images: ['registry.local/catalog:4.2.3'], containers: ['catalog'] },
  }),
  resource('Pod', 'payment-worker-854fb57d74-k9qsl', 'payments', 'CrashLoopBackOff', {
    ready: '0/1', restarts: 14, node: 'worker-cn-02', createdAt: ago(38),
    details: { podIP: '10.244.3.29', qosClass: 'Burstable', images: ['registry.local/payment-worker:3.6.2'], containers: ['worker'] },
  }),
  resource('Pod', 'ledger-0', 'payments', 'Running', {
    ready: '2/2', restarts: 0, node: 'worker-cn-01', createdAt: ago(60 * 24 * 12),
    details: { podIP: '10.244.2.9', qosClass: 'Guaranteed', images: ['registry.local/ledger:6.1.0', 'istio/proxyv2:1.23'], containers: ['ledger', 'istio-proxy'] },
  }),
  resource('Pod', 'prometheus-k8s-0', 'observability', 'Running', {
    ready: '2/2', restarts: 0, node: 'worker-cn-03', createdAt: ago(60 * 24 * 8),
    details: { podIP: '10.244.4.12', qosClass: 'Burstable', images: ['quay.io/prometheus/prometheus:v2.55.1'], containers: ['prometheus', 'config-reloader'] },
  }),
  resource('Pod', 'nightly-settlement-29183400-n7bqp', 'payments', 'Succeeded', {
    ready: '0/1', restarts: 0, node: 'worker-cn-02', createdAt: ago(460),
    details: { podIP: '10.244.3.54', qosClass: 'BestEffort', images: ['registry.local/settlement:2.3.0'], containers: ['settlement'] },
  }),
  resource('Pod', 'coredns-7c65d6cfc9-v8bw7', 'kube-system', 'Running', {
    ready: '1/1', restarts: 0, node: 'control-plane-01', createdAt: ago(60 * 24 * 31),
    details: { podIP: '10.244.0.3', qosClass: 'Burstable', images: ['registry.k8s.io/coredns/coredns:v1.11.3'], containers: ['coredns'] },
  }),
];

const deployments: ResourceRow[] = [
  resource('Deployment', 'api-gateway', 'commerce', 'Ready', { ready: '3/3', createdAt: ago(60 * 24 * 28), details: { available: 3, desired: 3, strategy: 'RollingUpdate' } }),
  resource('Deployment', 'checkout', 'commerce', 'Ready', { ready: '4/4', createdAt: ago(60 * 24 * 18), details: { available: 4, desired: 4, strategy: 'RollingUpdate' } }),
  resource('Deployment', 'catalog', 'commerce', 'Ready', { ready: '2/2', createdAt: ago(60 * 24 * 22), details: { available: 2, desired: 2, strategy: 'RollingUpdate' } }),
  resource('Deployment', 'payment-worker', 'payments', 'Progressing', { ready: '2/3', createdAt: ago(60 * 24 * 12), details: { available: 2, desired: 3, strategy: 'RollingUpdate' } }),
  resource('Deployment', 'grafana', 'observability', 'Ready', { ready: '1/1', createdAt: ago(60 * 24 * 30), details: { available: 1, desired: 1, strategy: 'Recreate' } }),
];

const events: ResourceRow[] = [
  resource('Event', 'payment-worker-backoff', 'payments', 'Warning', { createdAt: ago(2), details: { reason: 'BackOff', message: 'Back-off restarting failed container worker', count: 14, objectKind: 'Pod', objectName: 'payment-worker-854fb57d74-k9qsl', source: 'worker-cn-02', lastSeen: ago(2) } }),
  resource('Event', 'payment-worker-unhealthy', 'payments', 'Warning', { createdAt: ago(6), details: { reason: 'Unhealthy', message: 'Readiness probe failed: connection refused', count: 8, objectKind: 'Pod', objectName: 'payment-worker-854fb57d74-k9qsl', source: 'worker-cn-02', lastSeen: ago(6) } }),
  resource('Event', 'checkout-scaled', 'commerce', 'Normal', { createdAt: ago(18), details: { reason: 'ScalingReplicaSet', message: 'Scaled up replica set checkout-6b9f79d8bf from 3 to 4', count: 1, objectKind: 'Deployment', objectName: 'checkout', lastSeen: ago(18) } }),
  resource('Event', 'catalog-pulled', 'commerce', 'Normal', { createdAt: ago(31), details: { reason: 'Pulled', message: 'Container image already present on machine', count: 1, objectKind: 'Pod', objectName: 'catalog-66d78cc95f-v7x4m', lastSeen: ago(31) } }),
  resource('Event', 'node-disk-pressure', undefined, 'Warning', { createdAt: ago(64), details: { reason: 'NodeHasDiskPressure', message: 'Node worker-cn-03 is reporting disk pressure', count: 2, objectKind: 'Node', objectName: 'worker-cn-03', source: 'worker-cn-03', lastSeen: ago(64) } }),
];

export const demoResources: Record<string, ResourceRow[]> = {
  pods,
  deployments,
  statefulsets: [
    resource('StatefulSet', 'ledger', 'payments', 'Ready', { ready: '3/3', details: { serviceName: 'ledger-headless', currentRevision: 'ledger-84f967d84', updateRevision: 'ledger-84f967d84' } }),
    resource('StatefulSet', 'prometheus-k8s', 'observability', 'Ready', { ready: '2/2', details: { serviceName: 'prometheus-operated', currentRevision: 'prometheus-k8s-f56d', updateRevision: 'prometheus-k8s-f56d' } }),
  ],
  daemonsets: [
    resource('DaemonSet', 'node-exporter', 'observability', 'Ready', { ready: '4/4', details: { available: 4, updated: 4 } }),
    resource('DaemonSet', 'cilium', 'kube-system', 'Ready', { ready: '4/4', details: { available: 4, updated: 4 } }),
  ],
  replicasets: deployments.map((item, index) => resource('ReplicaSet', `${item.name}-${['7d6c8b56d9', '6b9f79d8bf', '66d78cc95f', '854fb57d74', '749c8d965'][index]}`, item.namespace, item.status, { ready: item.ready, details: item.details })),
  jobs: [
    resource('Job', 'database-migrate-284', 'commerce', 'Complete', { ready: '1/1', createdAt: ago(720), details: { failed: 0, active: 0 } }),
    resource('Job', 'reindex-catalog-91', 'commerce', 'Running', { ready: '0/1', createdAt: ago(12), details: { failed: 0, active: 1 } }),
  ],
  cronjobs: [
    resource('CronJob', 'nightly-settlement', 'payments', 'Active', { details: { schedule: '0 2 * * *', lastSchedule: ago(460) } }),
    resource('CronJob', 'catalog-snapshot', 'commerce', 'Active', { details: { schedule: '*/30 * * * *', lastSchedule: ago(18) } }),
  ],
  nodes: [
    resource('Node', 'control-plane-01', undefined, 'Ready', { createdAt: ago(60 * 24 * 186), labels: { 'node-role.kubernetes.io/control-plane': '', 'kubernetes.io/arch': 'amd64' }, details: { roles: ['control-plane'], capacity: { cpu: '8', memory: '32740864Ki', pods: '110' }, kubeletVersion: 'v1.31.4', operatingSystem: 'Ubuntu 24.04.1 LTS' } }),
    resource('Node', 'worker-cn-01', undefined, 'Ready', { createdAt: ago(60 * 24 * 171), labels: { 'node-role.kubernetes.io/worker': '', zone: 'cn-east-1a' }, details: { roles: ['worker'], capacity: { cpu: '16', memory: '65528832Ki', pods: '110' }, kubeletVersion: 'v1.31.4', operatingSystem: 'Ubuntu 24.04.1 LTS' } }),
    resource('Node', 'worker-cn-02', undefined, 'Ready', { createdAt: ago(60 * 24 * 171), labels: { 'node-role.kubernetes.io/worker': '', zone: 'cn-east-1b' }, details: { roles: ['worker'], capacity: { cpu: '16', memory: '65528832Ki', pods: '110' }, kubeletVersion: 'v1.31.4', operatingSystem: 'Ubuntu 24.04.1 LTS' } }),
    resource('Node', 'worker-cn-03', undefined, 'Ready', { createdAt: ago(60 * 24 * 96), labels: { 'node-role.kubernetes.io/worker': '', zone: 'cn-east-1c' }, details: { roles: ['worker'], capacity: { cpu: '32', memory: '131057664Ki', pods: '110' }, kubeletVersion: 'v1.31.4', operatingSystem: 'Ubuntu 24.04.1 LTS' } }),
  ],
  namespaces: ['commerce', 'payments', 'observability', 'kube-system', 'kube-public', 'default'].map((name) => resource('Namespace', name, undefined, 'Active', { labels: name === 'payments' ? { compliance: 'pci-dss', owner: 'fintech' } : { owner: 'platform' } })),
  services: [
    resource('Service', 'api-gateway', 'commerce', 'LoadBalancer', { details: { clusterIP: '10.96.45.23', externalIPs: ['203.0.113.42'], ports: [{ name: 'https', port: 443, targetPort: 8080 }] } }),
    resource('Service', 'checkout', 'commerce', 'ClusterIP', { details: { clusterIP: '10.96.88.14', externalIPs: [], ports: [{ name: 'http', port: 80, targetPort: 8080 }] } }),
    resource('Service', 'catalog', 'commerce', 'ClusterIP', { details: { clusterIP: '10.96.70.91', externalIPs: [], ports: [{ name: 'grpc', port: 9090, targetPort: 9090 }] } }),
    resource('Service', 'ledger-headless', 'payments', 'ClusterIP', { details: { clusterIP: 'None', externalIPs: [], ports: [{ name: 'grpc', port: 9090, targetPort: 9090 }] } }),
    resource('Service', 'grafana', 'observability', 'ClusterIP', { details: { clusterIP: '10.96.122.31', externalIPs: [], ports: [{ name: 'http', port: 3000, targetPort: 3000 }] } }),
  ],
  ingresses: [
    resource('Ingress', 'commerce-public', 'commerce', 'Ready', { details: { hosts: ['shop.example.cn', 'api.example.cn'], className: 'nginx', loadBalancer: [{ ip: '203.0.113.42' }] } }),
    resource('Ingress', 'grafana', 'observability', 'Ready', { details: { hosts: ['grafana.ops.example.cn'], className: 'nginx', loadBalancer: [{ ip: '203.0.113.42' }] } }),
  ],
  endpoints: [
    resource('Endpoints', 'api-gateway', 'commerce', 'Active', { details: { addresses: 3 } }),
    resource('Endpoints', 'checkout', 'commerce', 'Active', { details: { addresses: 4 } }),
    resource('Endpoints', 'catalog', 'commerce', 'Active', { details: { addresses: 2 } }),
  ],
  endpointslices: [
    resource('EndpointSlice', 'api-gateway-7h5mv', 'commerce', 'Active', { details: { addressType: 'IPv4', endpoints: 3 } }),
    resource('EndpointSlice', 'checkout-2m7px', 'commerce', 'Active', { details: { addressType: 'IPv4', endpoints: 4 } }),
  ],
  networkpolicies: [
    resource('NetworkPolicy', 'commerce-default-deny', 'commerce', 'Active', { details: { policyTypes: ['Ingress', 'Egress'] } }),
    resource('NetworkPolicy', 'allow-gateway-checkout', 'commerce', 'Active', { details: { policyTypes: ['Ingress'] } }),
  ],
  persistentvolumeclaims: [
    resource('PersistentVolumeClaim', 'ledger-data-ledger-0', 'payments', 'Bound', { details: { volume: 'pvc-4dc9ae12', storageClass: 'fast-ssd', capacity: { storage: '100Gi' } } }),
    resource('PersistentVolumeClaim', 'prometheus-data-prometheus-k8s-0', 'observability', 'Bound', { details: { volume: 'pvc-2ab1491a', storageClass: 'standard', capacity: { storage: '200Gi' } } }),
  ],
  persistentvolumes: [
    resource('PersistentVolume', 'pvc-4dc9ae12', undefined, 'Bound', { details: { storageClass: 'fast-ssd', capacity: { storage: '100Gi' }, claim: 'ledger-data-ledger-0' } }),
    resource('PersistentVolume', 'pvc-2ab1491a', undefined, 'Bound', { details: { storageClass: 'standard', capacity: { storage: '200Gi' }, claim: 'prometheus-data-prometheus-k8s-0' } }),
  ],
  storageclasses: [
    resource('StorageClass', 'fast-ssd', undefined, 'Active', { details: { provisioner: 'disk.csi.cloud.example', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer' } }),
    resource('StorageClass', 'standard', undefined, 'Active', { details: { provisioner: 'disk.csi.cloud.example', reclaimPolicy: 'Delete', volumeBindingMode: 'Immediate' } }),
  ],
  configmaps: [
    resource('ConfigMap', 'api-gateway-config', 'commerce', 'Active', { details: { keys: ['envoy.yaml', 'routes.json'], count: 2 } }),
    resource('ConfigMap', 'checkout-feature-flags', 'commerce', 'Active', { details: { keys: ['flags.yaml'], count: 1 } }),
    resource('ConfigMap', 'grafana-datasources', 'observability', 'Active', { details: { keys: ['datasources.yaml'], count: 1 } }),
  ],
  secrets: [
    resource('Secret', 'api-gateway-tls', 'commerce', 'kubernetes.io/tls', { details: { keys: ['tls.crt', 'tls.key'], count: 2 } }),
    resource('Secret', 'payment-db', 'payments', 'Opaque', { details: { keys: ['username', 'password', 'host'], count: 3 } }),
    resource('Secret', 'registry-credentials', 'commerce', 'kubernetes.io/dockerconfigjson', { details: { keys: ['.dockerconfigjson'], count: 1 } }),
  ],
  serviceaccounts: [
    resource('ServiceAccount', 'api-gateway', 'commerce', 'Active', { details: { automount: false, secrets: 0 } }),
    resource('ServiceAccount', 'payment-worker', 'payments', 'Active', { details: { automount: true, secrets: 0 } }),
    resource('ServiceAccount', 'prometheus-k8s', 'observability', 'Active', { details: { automount: true, secrets: 0 } }),
  ],
  roles: [resource('Role', 'pod-reader', 'commerce', 'Active', { details: { rules: 2 } })],
  rolebindings: [resource('RoleBinding', 'developers-pod-reader', 'commerce', 'Active', { details: { role: 'pod-reader', subjects: 1 } })],
  clusterroles: [resource('ClusterRole', 'platform-observer', undefined, 'Active', { details: { rules: 8 } })],
  clusterrolebindings: [resource('ClusterRoleBinding', 'platform-observers', undefined, 'Active', { details: { role: 'platform-observer', subjects: 1 } })],
  httproutes: [
    resource('HTTPRoute', 'checkout-public', 'commerce', 'Accepted', {
      ready: '2 rules',
      details: { hostnames: ['shop.example.cn'], parentRefs: [{ name: 'public-gateway' }], rules: 2, conditions: [{ type: 'Accepted', status: 'True' }] },
    }),
    resource('HTTPRoute', 'grafana-internal', 'observability', 'Accepted', {
      ready: '1 rule',
      details: { hostnames: ['grafana.ops.example.cn'], parentRefs: [{ name: 'internal-gateway' }], rules: 1, conditions: [{ type: 'Accepted', status: 'True' }] },
    }),
  ],
  gateways: [
    resource('Gateway', 'public-gateway', 'commerce', 'Accepted', { details: { gatewayClassName: 'traefik', listeners: 2 } }),
    resource('Gateway', 'internal-gateway', 'observability', 'Accepted', { details: { gatewayClassName: 'traefik', listeners: 1 } }),
  ],
  gatewayclasses: [resource('GatewayClass', 'traefik', undefined, 'Accepted', { details: { controllerName: 'traefik.io/gateway-controller' } })],
  referencegrants: [resource('ReferenceGrant', 'commerce-to-payments', 'commerce', 'Active', { details: { from: 1, to: 1 } })],
  grpcroutes: [resource('GRPCRoute', 'checkout-grpc', 'commerce', 'Accepted', { ready: '1 rule', details: { hostnames: ['checkout.grpc.example.cn'], rules: 1 } })],
  events,
};

export const demoOverview: Overview = {
  cpuPercent: 42,
  memoryPercent: 67,
  pods: { healthy: pods.filter((pod) => ['Running', 'Succeeded'].includes(pod.status)).length, total: pods.length },
  nodes: { healthy: 4, total: 4 },
  workloads: [...deployments, ...demoResources.statefulsets, ...demoResources.daemonsets, ...demoResources.jobs],
  events,
};

export const demoLogs = `2026-07-31T07:42:11.240Z INFO  boot        configuration loaded\n2026-07-31T07:42:11.483Z INFO  database    connection pool ready size=20\n2026-07-31T07:42:11.612Z INFO  server      listening address=0.0.0.0:8080\n2026-07-31T07:43:02.102Z INFO  request     GET /health status=200 latency=2ms\n2026-07-31T07:43:08.871Z INFO  request     POST /v1/checkout status=201 latency=34ms\n2026-07-31T07:43:11.024Z WARN  upstream    inventory service retry attempt=1\n2026-07-31T07:43:11.186Z INFO  upstream    inventory service recovered latency=118ms`;
