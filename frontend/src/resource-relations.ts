import { resourceKindKey } from './resource-utils';
import type { ResourceListResponse, ResourceRow } from './types';

export interface ResourceRelationGroup {
  id: string;
  label: string;
  relation: string;
  rows: ResourceRow[];
}

export interface ResourceRelations {
  groups: ResourceRelationGroup[];
  events: ResourceRow[];
}

type ResourceLoader = (kind: string, namespace?: string) => Promise<ResourceListResponse>;

function detailStrings(row: ResourceRow, key: string) {
  const value = row.details[key];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (item && typeof item === 'object' && 'name' in item && typeof item.name === 'string') return [item.name];
    return [];
  });
}

function selectorMatches(owner: ResourceRow, target: ResourceRow) {
  const selector = owner.details.selector;
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) return false;
  const entries = Object.entries(selector as Record<string, unknown>);
  return entries.length > 0 && entries.every(([key, value]) => typeof value === 'string' && target.labels[key] === value);
}

function namesMatch(rows: ResourceRow[], names: string[]) {
  const wanted = new Set(names.filter(Boolean));
  return rows.filter((item) => wanted.has(item.name));
}

export async function loadResourceRelations(row: ResourceRow, load: ResourceLoader): Promise<ResourceRelations> {
  const namespace = row.namespace;
  const requests = new Map<string, Promise<ResourceRow[]>>();
  const list = (kind: string, targetNamespace: string | null | undefined = namespace) => {
    const key = `${kind}:${targetNamespace || '_'}`;
    const existing = requests.get(key);
    if (existing) return existing;
    const request = load(kind, targetNamespace || undefined).then((response) => response.items).catch(() => []);
    requests.set(key, request);
    return request;
  };
  const groups: ResourceRelationGroup[] = [];
  const add = (id: string, label: string, relation: string, rows: ResourceRow[]) => {
    const unique = rows.filter((item, index) => rows.findIndex((candidate) => candidate.uid === item.uid) === index).slice(0, 40);
    if (unique.length) groups.push({ id, label, relation, rows: unique });
  };
  const kind = resourceKindKey(row.kind);

  const owners = row.ownerReferences || [];
  for (const ownerKind of [...new Set(owners.map((owner) => resourceKindKey(owner.kind)))]) {
    const candidates = await list(ownerKind);
    const matching = candidates.filter((candidate) => owners.some((owner) => owner.uid === candidate.uid || (resourceKindKey(owner.kind) === ownerKind && owner.name === candidate.name)));
    add(`owner-${ownerKind}`, '所有者', '由以下资源管理', matching);
  }

  if (['deployments', 'statefulsets', 'daemonsets', 'replicasets', 'jobs'].includes(kind)) {
    const pods = await list('pods');
    add('pods', 'Pods', '工作负载实例', pods.filter((pod) => selectorMatches(row, pod) || pod.ownerReferences?.some((owner) => owner.uid === row.uid)));
  }
  if (kind === 'deployments') {
    const replicaSets = await list('replicasets');
    add('replicasets', 'ReplicaSets', '修订与副本控制器', replicaSets.filter((item) => item.ownerReferences?.some((owner) => owner.uid === row.uid)));
  }
  if (kind === 'cronjobs') {
    const jobs = await list('jobs');
    add('jobs', 'Jobs', '计划任务执行记录', jobs.filter((item) => item.ownerReferences?.some((owner) => owner.uid === row.uid)));
  }
  if (kind === 'pods') {
    if (row.node) add('node', 'Node', '运行节点', namesMatch(await list('nodes', null), [row.node]));
    const claimNames = detailStrings(row, 'persistentVolumeClaims');
    if (claimNames.length) add('claims', 'PersistentVolumeClaims', '挂载的存储声明', namesMatch(await list('persistentvolumeclaims'), claimNames));
    const configMaps = detailStrings(row, 'configMaps');
    if (configMaps.length) add('configmaps', 'ConfigMaps', '挂载的配置', namesMatch(await list('configmaps'), configMaps));
    const secrets = detailStrings(row, 'secrets');
    if (secrets.length) add('secrets', 'Secrets', '挂载的密钥', namesMatch(await list('secrets'), secrets));
    const services = await list('services');
    add('services', 'Services', '选择该 Pod 的服务', services.filter((service) => selectorMatches(service, row)));
  }
  if (kind === 'persistentvolumeclaims') {
    const volume = typeof row.details.volume === 'string' ? row.details.volume : '';
    if (volume) add('volume', 'PersistentVolume', '绑定的持久卷', namesMatch(await list('persistentvolumes', null), [volume]));
    const storageClass = typeof row.details.storageClass === 'string' ? row.details.storageClass : '';
    if (storageClass) add('storageclass', 'StorageClass', '存储配置', namesMatch(await list('storageclasses', null), [storageClass]));
    const pods = await list('pods');
    add('pods', 'Pods', '使用该声明的 Pods', pods.filter((pod) => detailStrings(pod, 'persistentVolumeClaims').includes(row.name)));
  }
  if (kind === 'persistentvolumes') {
    const claim = typeof row.details.claim === 'string' ? row.details.claim : '';
    const claimNamespace = typeof row.details.claimNamespace === 'string' ? row.details.claimNamespace : namespace;
    if (claim) add('claim', 'PersistentVolumeClaim', '绑定的存储声明', namesMatch(await list('persistentvolumeclaims', claimNamespace), [claim]));
    const storageClass = typeof row.details.storageClass === 'string' ? row.details.storageClass : '';
    if (storageClass) add('storageclass', 'StorageClass', '存储配置', namesMatch(await list('storageclasses', null), [storageClass]));
  }
  if (kind === 'services') {
    const pods = await list('pods');
    add('pods', 'Pods', '服务后端', pods.filter((pod) => selectorMatches(row, pod)));
    add('endpoints', 'Endpoints', '端点集合', namesMatch(await list('endpoints'), [row.name]));
    const slices = await list('endpointslices');
    add('endpointslices', 'EndpointSlices', '端点分片', slices.filter((item) => item.labels['kubernetes.io/service-name'] === row.name));
    const ingresses = await list('ingresses');
    add('ingresses', 'Ingresses', '入口引用', ingresses.filter((item) => detailStrings(item, 'backends').includes(row.name)));
  }
  if (kind === 'ingresses') {
    add('services', 'Services', '转发后端', namesMatch(await list('services'), detailStrings(row, 'backends')));
  }
  if (kind === 'httproutes' || kind === 'grpcroutes') {
    add('services', 'Services', '路由后端', namesMatch(await list('services'), detailStrings(row, 'backendRefs')));
    add('gateways', 'Gateways', '父级网关', namesMatch(await list('gateways'), detailStrings(row, 'parentRefs')));
  }
  if (kind === 'gateways') {
    const routes = await list('httproutes');
    add('routes', 'HTTPRoutes', '挂载的路由', routes.filter((item) => detailStrings(item, 'parentRefs').includes(row.name)));
  }
  if (kind === 'nodes') {
    const pods = await list('pods', null);
    add('pods', 'Pods', '运行中的 Pods', pods.filter((pod) => pod.node === row.name));
  }
  if (kind === 'configmaps' || kind === 'secrets') {
    const detailKey = kind === 'configmaps' ? 'configMaps' : 'secrets';
    const pods = await list('pods');
    add('pods', 'Pods', '引用该配置的 Pods', pods.filter((pod) => detailStrings(pod, detailKey).includes(row.name)));
  }

  const events = (await list('events', namespace || null))
    .filter((event) => event.details.objectName === row.name && (!event.details.objectKind || event.details.objectKind === row.kind))
    .sort((left, right) => String(right.details.lastSeen || right.createdAt || '').localeCompare(String(left.details.lastSeen || left.createdAt || '')))
    .slice(0, 30);
  return { groups, events };
}
