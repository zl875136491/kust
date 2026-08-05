export type ThemeMode = 'system' | 'light' | 'dark';
export type ShellTheme = 'system' | 'light' | 'dark' | 'one-dark' | 'dracula' | 'solarized-dark' | 'nord' | 'gruvbox-dark' | 'tokyo-night';

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
  preset?: boolean;
  readOnly: boolean;
  source: 'preset' | 'user' | string;
}

export interface CreateClusterPayload {
  name: string;
  description: string;
  context?: string;
  kubeconfig: string;
}

export interface UpdateClusterPayload {
  name?: string;
  description?: string;
  context?: string;
  kubeconfig?: string;
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
  annotations: Record<string, string>;
  ownerReferences: Array<{
    apiVersion: string;
    kind: string;
    name: string;
    uid: string;
    controller: boolean;
  }>;
  generation?: number;
  resourceVersion?: string;
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

export interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory' | 'symlink';
  size?: number;
  mode?: string;
  modifiedAt?: string;
}

export interface FileTreeResponse {
  path: string;
  entries: FileEntry[];
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  realName: string;
  email?: string;
  itcode?: string;
  source: 'local' | 'oa' | string;
  roles: string[];
  disabled: boolean;
  passwordUnset: boolean;
  twoFactorEnabled: boolean;
  twoFactorRequired: boolean;
  twoFactorRememberDays: number;
}

export interface Role {
  id: string;
  name: string;
  label: string;
  permissions: string[];
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformSettings {
  registrationEnabled: boolean;
  oaLoginEnabled: boolean;
  defaultRole: string;
  cacheTtlSeconds: number;
  cacheSyncSeconds: number;
  sessionTimeoutHours: number;
  oaUserSourceConfigured: boolean;
  presetClustersReadOnly: boolean;
  updatedAt: string;
}

export type PlatformSettingsUpdate = Pick<
  PlatformSettings,
  | 'registrationEnabled'
  | 'oaLoginEnabled'
  | 'defaultRole'
  | 'cacheTtlSeconds'
  | 'cacheSyncSeconds'
  | 'sessionTimeoutHours'
>;

export interface RegistrationProfile {
  username: string;
  displayName: string;
  realName: string;
  email?: string;
  itcode: string;
  source: 'oa' | string;
}

export type AuthNext = 'authenticated' | 'enroll' | 'two_factor';

export interface AuthState {
  user: User;
  next: AuthNext;
  token?: string;
  trustedDeviceToken?: string;
}

export interface AuthCapabilities {
  registrationEnabled: boolean;
  oaLoginEnabled: boolean;
}

export interface UserSettings {
  theme: ThemeMode;
  shellTheme: ShellTheme;
  pointerHighlight: boolean;
  refraction: boolean;
  backdropBlur: boolean;
  hoverMotion: boolean;
  autoRefresh: boolean;
  pageSize: number;
  windowCloseConfirmation: boolean;
  twoFactorEnabled: boolean;
  twoFactorRequired: boolean;
  twoFactorRememberDays: number;
}

export interface SearchResult {
  id: string;
  title: string;
  subtitle: string;
  category: string;
  clusterId?: string;
  path: string;
  status?: string;
}

export interface ResourceMapNode {
  id: string;
  label: string;
  kind: string;
  namespace?: string;
  status: string;
  group: 'entry' | 'network' | 'workload' | 'pod' | 'node' | 'storage' | string;
  resourceKind: string;
}

export interface ResourceMapEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
}

export interface ResourceMapResponse {
  nodes: ResourceMapNode[];
  edges: ResourceMapEdge[];
  syncedAt?: string;
}
