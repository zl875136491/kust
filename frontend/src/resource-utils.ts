import type { OpenWorkspaceWindow } from './workspace-windows-context';
import { resourceDescriptors } from './navigation';
import type { Cluster, ResourceDescriptor, ResourceRow } from './types';

const kindAliases: Record<string, string> = {
  pod: 'pods', deployment: 'deployments', statefulset: 'statefulsets', daemonset: 'daemonsets', replicaset: 'replicasets',
  job: 'jobs', cronjob: 'cronjobs', node: 'nodes', namespace: 'namespaces', service: 'services', endpoints: 'endpoints',
  endpointslice: 'endpointslices', ingress: 'ingresses', networkpolicy: 'networkpolicies', configmap: 'configmaps', secret: 'secrets',
  persistentvolumeclaim: 'persistentvolumeclaims', persistentvolume: 'persistentvolumes', storageclass: 'storageclasses', event: 'events',
  serviceaccount: 'serviceaccounts', role: 'roles', rolebinding: 'rolebindings', clusterrole: 'clusterroles', clusterrolebinding: 'clusterrolebindings',
  httproute: 'httproutes', gateway: 'gateways', gatewayclass: 'gatewayclasses', referencegrant: 'referencegrants', grpcroute: 'grpcroutes',
};

export function resourceKindKey(kind: string) {
  const normalized = kind.toLowerCase().replaceAll('-', '').replaceAll('_', '');
  return resourceDescriptors[normalized] ? normalized : kindAliases[normalized] || normalized;
}

export function descriptorForRow(row: ResourceRow): ResourceDescriptor {
  const key = resourceKindKey(row.kind);
  return resourceDescriptors[key] || {
    kind: key,
    label: `${row.kind}s`,
    singular: row.kind,
    namespaced: Boolean(row.namespace),
    group: 'related',
  };
}

export function starterYaml(kind = 'deployments', namespace = 'default') {
  const targetNamespace = namespace && namespace !== 'all' && namespace !== '_' ? namespace : 'default';
  switch (resourceKindKey(kind)) {
    case 'pods': return `apiVersion: v1
kind: Pod
metadata:
  name: example-pod
  namespace: ${targetNamespace}
spec:
  containers:
    - name: web
      image: nginx:1.27
      ports:
        - containerPort: 80
`;
    case 'services': return `apiVersion: v1
kind: Service
metadata:
  name: example-service
  namespace: ${targetNamespace}
spec:
  selector:
    app: example
  ports:
    - name: http
      port: 80
      targetPort: 80
`;
    case 'configmaps': return `apiVersion: v1
kind: ConfigMap
metadata:
  name: example-config
  namespace: ${targetNamespace}
data:
  example.conf: |
    enabled=true
`;
    case 'secrets': return `apiVersion: v1
kind: Secret
metadata:
  name: example-secret
  namespace: ${targetNamespace}
type: Opaque
stringData:
  username: example
`;
    case 'persistentvolumeclaims': return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: example-claim
  namespace: ${targetNamespace}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
`;
    case 'httproutes': return `apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: example-route
  namespace: ${targetNamespace}
spec:
  parentRefs:
    - name: example-gateway
  rules:
    - backendRefs:
        - name: example-service
          port: 80
`;
    default: return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
  namespace: ${targetNamespace}
  labels:
    app: example
spec:
  replicas: 1
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: web
          image: nginx:1.27
          ports:
            - containerPort: 80
`;
  }
}

export function newResourceEditorWindow(cluster: Cluster, namespace: string, kind = 'deployments'): OpenWorkspaceWindow {
  const descriptor = resourceDescriptors[resourceKindKey(kind)];
  const content = starterYaml(kind, namespace);
  const now = new Date();
  const timestamp = `${now.toLocaleTimeString('zh-CN', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
  return {
    type: 'editor',
    clusterId: cluster.id,
    clusterName: cluster.name,
    namespace: namespace && namespace !== 'all' ? namespace : 'default',
    resourceName: `新建 ${descriptor?.singular || '资源'} ${timestamp}`,
    editorMode: 'create',
    editorKind: resourceKindKey(kind),
    editorContent: content,
    editorSavedContent: content,
  };
}

export function editResourceWindow(cluster: Cluster, descriptor: ResourceDescriptor, row: ResourceRow, yaml: string): OpenWorkspaceWindow {
  return {
    type: 'editor',
    clusterId: cluster.id,
    clusterName: cluster.name,
    namespace: row.namespace || '_',
    resourceName: row.name,
    resourceUid: row.uid,
    editorMode: 'edit',
    editorKind: descriptor.kind,
    editorContent: yaml,
    editorSavedContent: yaml,
  };
}

export function downloadResourceYaml(row: ResourceRow, yaml: string) {
  const url = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${row.kind.toLowerCase()}-${row.name}.yaml`;
  anchor.click();
  URL.revokeObjectURL(url);
}
