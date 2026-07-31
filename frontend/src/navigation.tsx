import {
  Boxes,
  Database,
  Hexagon,
  Map as MapIcon,
  Network,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ResourceDescriptor } from './types';

export interface NavigationGroup {
  id: string;
  label: string;
  icon: LucideIcon;
  path?: string;
  items?: ResourceDescriptor[];
}

export const navigationGroups: NavigationGroup[] = [
  {
    id: 'cluster', label: '集群', icon: Hexagon, path: '',
    items: [
      { kind: 'namespaces', label: '命名空间', singular: 'Namespace', namespaced: false, group: 'cluster' },
      { kind: 'nodes', label: '节点', singular: 'Node', namespaced: false, group: 'cluster' },
      { kind: 'events', label: '事件', singular: 'Event', namespaced: true, group: 'cluster' },
    ],
  },
  { id: 'map', label: '资源地图', icon: MapIcon, path: 'map' },
  {
    id: 'workloads', label: '工作负载', icon: Boxes, path: 'workloads',
    items: [
      { kind: 'pods', label: 'Pods', singular: 'Pod', namespaced: true, group: 'workloads' },
      { kind: 'deployments', label: 'Deployments', singular: 'Deployment', namespaced: true, group: 'workloads' },
      { kind: 'statefulsets', label: 'StatefulSets', singular: 'StatefulSet', namespaced: true, group: 'workloads' },
      { kind: 'daemonsets', label: 'DaemonSets', singular: 'DaemonSet', namespaced: true, group: 'workloads' },
      { kind: 'replicasets', label: 'ReplicaSets', singular: 'ReplicaSet', namespaced: true, group: 'workloads' },
      { kind: 'jobs', label: 'Jobs', singular: 'Job', namespaced: true, group: 'workloads' },
      { kind: 'cronjobs', label: 'CronJobs', singular: 'CronJob', namespaced: true, group: 'workloads' },
    ],
  },
  {
    id: 'storage', label: '存储', icon: Database,
    items: [
      { kind: 'persistentvolumeclaims', label: 'Persistent Volume Claims', singular: 'PersistentVolumeClaim', namespaced: true, group: 'storage' },
      { kind: 'persistentvolumes', label: 'Persistent Volumes', singular: 'PersistentVolume', namespaced: false, group: 'storage' },
      { kind: 'storageclasses', label: 'Storage Classes', singular: 'StorageClass', namespaced: false, group: 'storage' },
    ],
  },
  {
    id: 'network', label: '网络', icon: Network,
    items: [
      { kind: 'services', label: 'Services', singular: 'Service', namespaced: true, group: 'network' },
      { kind: 'endpoints', label: 'Endpoints', singular: 'Endpoints', namespaced: true, group: 'network' },
      { kind: 'endpointslices', label: 'Endpoint Slices', singular: 'EndpointSlice', namespaced: true, group: 'network' },
      { kind: 'ingresses', label: 'Ingresses', singular: 'Ingress', namespaced: true, group: 'network' },
      { kind: 'networkpolicies', label: 'Network Policies', singular: 'NetworkPolicy', namespaced: true, group: 'network' },
    ],
  },
  {
    id: 'security', label: '安全', icon: ShieldCheck,
    items: [
      { kind: 'serviceaccounts', label: 'Service Accounts', singular: 'ServiceAccount', namespaced: true, group: 'security' },
      { kind: 'roles', label: 'Roles', singular: 'Role', namespaced: true, group: 'security' },
      { kind: 'rolebindings', label: 'Role Bindings', singular: 'RoleBinding', namespaced: true, group: 'security' },
      { kind: 'clusterroles', label: 'Cluster Roles', singular: 'ClusterRole', namespaced: false, group: 'security' },
      { kind: 'clusterrolebindings', label: 'Cluster Role Bindings', singular: 'ClusterRoleBinding', namespaced: false, group: 'security' },
    ],
  },
  {
    id: 'config', label: '配置', icon: Settings2,
    items: [
      { kind: 'configmaps', label: 'Config Maps', singular: 'ConfigMap', namespaced: true, group: 'config' },
      { kind: 'secrets', label: 'Secrets', singular: 'Secret', namespaced: true, group: 'config' },
    ],
  },
];

export const resourceDescriptors = Object.fromEntries(
  navigationGroups.flatMap((group) => group.items || []).map((item) => [item.kind, item]),
) as Record<string, ResourceDescriptor>;
