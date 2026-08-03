import type {
  Cluster,
  CreateClusterPayload,
  Overview,
  ResourceListResponse,
  ResourceRow,
  FileTreeResponse,
} from './types';

const API_ROOT = import.meta.env.VITE_API_URL || '/api';
const WS_ROOT = API_ROOT.startsWith('http')
  ? API_ROOT.replace(/^http/, 'ws')
  : (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + API_ROOT;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `请求失败 (${response.status})`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<{ status: string; database: string }>('/health'),
  clusters: () => request<Cluster[]>('/clusters'),
  createCluster: (payload: CreateClusterPayload) =>
    request<Cluster>('/clusters', { method: 'POST', body: JSON.stringify(payload) }),
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
  podLogs: (clusterId: string, namespace: string, name: string, container?: string) => {
    const query = container ? `?container=${encodeURIComponent(container)}` : '';
    return request<{ logs: string }>(
      `/clusters/${clusterId}/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/logs${query}`,
    );
  },
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
    const query = container ? '?container=' + encodeURIComponent(container) : '';
    return WS_ROOT + '/clusters/' + clusterId + '/pods/' + encodeURIComponent(namespace) + '/' + encodeURIComponent(pod) + '/shell' + query;
  },
};
