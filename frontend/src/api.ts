import type {
  Cluster,
  CreateClusterPayload,
  UpdateClusterPayload,
  Overview,
  ResourceListResponse,
  ResourceRow,
  FileTreeResponse,
  AuthCapabilities, AuthState, PlatformSettings, PlatformSettingsUpdate, RegistrationProfile, ResourceMapResponse,
  Role, SearchResult, User, UserSettings,
} from './types';
import { APP_BASE_PATH } from './runtime-config';

const API_ROOT = import.meta.env.VITE_API_URL || `${APP_BASE_PATH}/api`;
const WS_ROOT = API_ROOT.startsWith('http')
  ? API_ROOT.replace(/^http/, 'ws')
  : (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + API_ROOT;

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem('kust-session-token');
  const trusted = localStorage.getItem('kust-trusted-device');
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(trusted ? { 'X-Kust-Trusted-Device': trusted } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error || `请求失败 (${response.status})`, response.status);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<{ status: string; database: string }>('/health'),
  authCapabilities: () => request<AuthCapabilities>('/auth/capabilities'),
  registrationProfile: (username: string) => request<RegistrationProfile>('/auth/register/lookup', { method: 'POST', body: JSON.stringify({ username }) }),
  register: (username: string, password: string, passwordConfirmation: string) => request<AuthState>('/auth/register', { method: 'POST', body: JSON.stringify({ username, password, passwordConfirmation }) }),
  login: (username: string, password: string) => request<AuthState>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  me: () => request<AuthState>('/auth/me'),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  oaLogin: (username: string) => request<{ message: string; debugCode?: string }>('/auth/oa/request', { method: 'POST', body: JSON.stringify({ username }) }),
  codeLogin: (username: string, code: string) => request<AuthState>('/auth/code', { method: 'POST', body: JSON.stringify({ username, code }) }),
  requestPasswordReset: (username: string) => request<{ message: string; debugCode?: string }>('/auth/password/request', { method: 'POST', body: JSON.stringify({ username }) }),
  resetPassword: (username: string, code: string, newPassword: string) => request<void>('/auth/password/reset', { method: 'POST', body: JSON.stringify({ username, code, newPassword }) }),
  totpSetup: () => request<{ secret: string; uri: string }>('/auth/2fa/setup'),
  totpVerify: (code: string) => request<AuthState>('/auth/2fa/verify', { method: 'POST', body: JSON.stringify({ code }) }),
  settings: () => request<UserSettings>('/settings'),
  updateSettings: (settings: UserSettings) => request<UserSettings>('/settings', { method: 'PUT', body: JSON.stringify(settings) }),
  users: () => request<User[]>('/admin/users'),
  roles: () => request<Role[]>('/admin/roles'),
  platformSettings: () => request<PlatformSettings>('/admin/settings'),
  updatePlatformSettings: (settings: PlatformSettingsUpdate) => request<PlatformSettings>('/admin/settings', { method: 'PUT', body: JSON.stringify(settings) }),
  updateRoles: (id: string, roles: string[]) => request<User>(`/admin/users/${id}/roles`, { method: 'PATCH', body: JSON.stringify({ roles }) }),
  updateUserStatus: (id: string, disabled: boolean) => request<User>(`/admin/users/${id}/status`, { method: 'PATCH', body: JSON.stringify({ disabled }) }),
  adminResetCode: (id: string) => request<{ username: string; code: string; expiresInMinutes: number }>(`/admin/users/${id}/reset-code`, { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) => request<void>('/auth/password/change', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  search: (q: string, clusterId?: string) => { const params = new URLSearchParams({ q }); if (clusterId) params.set('clusterId', clusterId); return request<SearchResult[]>(`/search?${params}`); },
  resourceMap: (clusterId: string) => request<ResourceMapResponse>(`/clusters/${clusterId}/map`),
  clusters: () => request<Cluster[]>('/clusters'),
  createCluster: (payload: CreateClusterPayload) =>
    request<Cluster>('/clusters', { method: 'POST', body: JSON.stringify(payload) }),
  updateCluster: (clusterId: string, payload: UpdateClusterPayload) =>
    request<Cluster>(`/clusters/${clusterId}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteCluster: (clusterId: string) =>
    request<void>(`/clusters/${clusterId}`, { method: 'DELETE' }),
  overview: (clusterId: string) => request<Overview>(`/clusters/${clusterId}/overview`),
  resources: (clusterId: string, kind: string, namespace?: string) => {
    const query = namespace && namespace !== 'all' ? `?namespace=${encodeURIComponent(namespace)}` : '';
    return request<ResourceListResponse>(`/clusters/${clusterId}/resources/${kind}${query}`);
  },
  deleteResource: (clusterId: string, kind: string, row: ResourceRow) =>
    request<void>(
      `/clusters/${clusterId}/resources/${kind}/${encodeURIComponent(row.namespace || '_')}/${encodeURIComponent(row.name)}`,
      { method: 'DELETE' },
    ),
  resourceYaml: (clusterId: string, kind: string, row: ResourceRow) =>
    request<{ yaml: string }>(
      `/clusters/${clusterId}/resources/${kind}/${encodeURIComponent(row.namespace || '_')}/${encodeURIComponent(row.name)}`,
    ),
  scaleDeployment: (clusterId: string, namespace: string, name: string, replicas: number) =>
    request<ResourceRow>(
      `/clusters/${clusterId}/deployments/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/scale`,
      { method: 'PATCH', body: JSON.stringify({ replicas }) },
    ),
  scaleWorkload: (clusterId: string, kind: string, namespace: string, name: string, replicas: number) =>
    request<ResourceRow>(
      `/clusters/${clusterId}/workloads/${encodeURIComponent(kind)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/scale`,
      { method: 'PATCH', body: JSON.stringify({ replicas }) },
    ),
  restartWorkload: (clusterId: string, kind: string, namespace: string, name: string) =>
    request<ResourceRow>(
      `/clusters/${clusterId}/workloads/${encodeURIComponent(kind)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/restart`,
      { method: 'POST' },
    ),
  podLogs: (clusterId: string, namespace: string, name: string, container?: string, tailLines = 500) => {
    const params = new URLSearchParams({ tailLines: String(tailLines) });
    if (container) params.set('container', container);
    return request<{ logs: string }>(
      `/clusters/${clusterId}/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/logs?${params}`,
    );
  },
  podExists: (clusterId: string, namespace: string, name: string) =>
    request<{ yaml: string }>(
      `/clusters/${clusterId}/resources/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
    ).then(() => true),
  applyYaml: (clusterId: string, yaml: string, namespace?: string) =>
    request<{ kind: string; name: string; namespace?: string }>(`/clusters/${clusterId}/apply`, {
      method: 'POST',
      body: JSON.stringify({ yaml, namespace }),
    }),
  fileTree: (clusterId: string, namespace: string, pod: string, path = '/', container?: string) => {
    const query = new URLSearchParams({ path });
    if (container) query.set('container', container);
    return request<FileTreeResponse>(
      '/clusters/' + clusterId + '/pods/' + encodeURIComponent(namespace) + '/' + encodeURIComponent(pod) + '/files?' + query.toString(),
    );
  },
  readFile: (clusterId: string, namespace: string, pod: string, path: string, container?: string) => {
    const query = new URLSearchParams({ path });
    if (container) query.set('container', container);
    return request<{ path: string; content: string; truncated: boolean }>(
      '/clusters/' + clusterId + '/pods/' + encodeURIComponent(namespace) + '/' + encodeURIComponent(pod) + '/file?' + query.toString(),
    );
  },
  writeFile: (clusterId: string, namespace: string, pod: string, path: string, content: string, container?: string) =>
    request<{ path: string; bytes: number }>(
      '/clusters/' + clusterId + '/pods/' + encodeURIComponent(namespace) + '/' + encodeURIComponent(pod) + '/file',
      { method: 'PUT', body: JSON.stringify({ path, content, container }) },
    ),
  makeDirectory: (clusterId: string, namespace: string, pod: string, path: string, container?: string) =>
    request<void>(
      '/clusters/' + clusterId + '/pods/' + encodeURIComponent(namespace) + '/' + encodeURIComponent(pod) + '/directory',
      { method: 'POST', body: JSON.stringify({ path, container }) },
    ),
  deleteFile: (clusterId: string, namespace: string, pod: string, path: string, container?: string) => {
    const query = new URLSearchParams({ path });
    if (container) query.set('container', container);
    return request<void>(
      '/clusters/' + clusterId + '/pods/' + encodeURIComponent(namespace) + '/' + encodeURIComponent(pod) + '/file?' + query.toString(),
      { method: 'DELETE' },
    );
  },
  shellUrl: (clusterId: string, namespace: string, pod: string, container?: string) => {
    const params = new URLSearchParams({ accessToken: localStorage.getItem('kust-session-token') || '' });
    if (container) params.set('container', container);
    const query = `?${params}`;
    return WS_ROOT + '/clusters/' + clusterId + '/pods/' + encodeURIComponent(namespace) + '/' + encodeURIComponent(pod) + '/shell' + query;
  },
};
