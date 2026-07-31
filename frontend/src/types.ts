export type ThemeMode = 'system' | 'light' | 'dark';
export type DataMode = 'demo' | 'live';

export interface Cluster {
  id: string;
  name: string;
  description: string;
  context: string;
  server: string;
  kubernetesVersion?: string;
  status: 'connected' | 'disconnected' | 'unknown';
  createdAt: string;
  lastConnectedAt?: string;
  warnings?: number;
  accent?: string;
}

export interface CreateClusterPayload {
  name: string;
  description: string;
  context?: string;
  kubeconfig: string;
}

export interface ResourceRow {
  uid: string;
  name: string;
  namespace?: string;
  kind: string;
  status: string;
  ready?: string;
  restarts?: number;
  createdAt?: string;
  node?: string;
  labels: Record<string, string>;
  details: Record<string, unknown>;
}

export interface ResourceListResponse {
  kind: string;
  items: ResourceRow[];
}

export interface StatusCount {
  healthy: number;
  total: number;
}

export interface Overview {
  cpuPercent?: number;
  memoryPercent?: number;
  pods: StatusCount;
  nodes: StatusCount;
  workloads: ResourceRow[];
  events: ResourceRow[];
}

export interface ResourceDescriptor {
  kind: string;
  label: string;
  singular: string;
  namespaced: boolean;
  group: string;
}
