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
  memberCount?: number;
}

export interface AuditLog {
  id: string;
  actorUserId?: string;
  action: string;
  target?: string;
  clusterId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Notification {
  id: string;
  clusterId?: string;
  kind: string;
  resourceName?: string;
  severity: string;
  title: string;
  message: string;
  readAt?: string;
  createdAt: string;
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

export interface MetricsSummary {
  available: boolean;
  cpuMillicores: number;
  memoryBytes: number;
  nodes: number;
  pods: number;
  collectedAt: string;
  message?: string;
}

export interface DiscoveryResource {
  group: string;
  version: string;
  kind: string;
  resource: string;
  namespaced: boolean;
  verbs: string[];
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

export interface PodContainersResponse {
  containers: string[];
  initContainers: string[];
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

export type HostingBuildMode = 'dockerfile' | 'buildpack' | 'static' | 'custom';

export interface GitCredential {
  id: string;
  name: string;
  credentialType: 'token' | 'ssh_key';
  username?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationBuild {
  id: string;
  applicationId: string;
  gitCommit?: string;
  gitRef: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  jenkinsBuildUrl?: string;
  imageRef?: string;
  imageDigestRef?: string;
  message?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface HostedApplication {
  id: string;
  ownerUserId: string;
  name: string;
  slug: string;
  repositoryUrl: string;
  gitRef: string;
  credentialId?: string;
  buildMode: HostingBuildMode;
  sourceSubdirectory?: string;
  buildCommand?: string;
  outputDirectory?: string;
  containerPort: number;
  healthPath: string;
  clusterId: string;
  namespace: string;
  replicas: number;
  cpuRequest: string;
  memoryRequest: string;
  cpuLimit: string;
  memoryLimit: string;
  routeHost: string;
  routePath: string;
  gatewayName: string;
  gatewayNamespace: string;
  autoDeploy: boolean;
  webhookConfigured: boolean;
  createdAt: string;
  updatedAt: string;
  latestBuild?: ApplicationBuild;
}

export interface CreateGitCredentialPayload {
  name: string;
  credentialType: 'token' | 'ssh_key';
  username?: string;
  secret: string;
}

export interface CreateHostedApplicationPayload {
  name: string;
  repositoryUrl: string;
  gitRef: string;
  credentialId?: string;
  buildMode: HostingBuildMode;
  sourceSubdirectory?: string;
  buildCommand?: string;
  outputDirectory?: string;
  containerPort: number;
  healthPath: string;
  clusterId: string;
  namespace: string;
  replicas: number;
  cpuRequest: string;
  memoryRequest: string;
  cpuLimit: string;
  memoryLimit: string;
  routeHost?: string;
  routePath: string;
  gatewayName?: string;
  gatewayNamespace?: string;
  autoDeploy: boolean;
}

export interface ApplicationWebhook {
  url: string;
  secret: string;
}

export interface HostingCapabilities {
  hostingEnabled: boolean;
  jenkinsConfigured: boolean;
  allowedNamespaces: string[];
  defaultNamespace: string;
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
