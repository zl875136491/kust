import Editor from '@monaco-editor/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Braces,
  Copy,
  Download,
  FilePenLine,
  FileText,
  FolderOpen,
  Layers3,
  Logs,
  RotateCw,
  Scale,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parse, stringify } from 'yaml';
import { copyText } from '../browser-compat';
import { useData } from '../data-context';
import { motionDuration, useEscapeLayer } from '../hooks/useEscapeLayer';
import { loadResourceRelations } from '../resource-relations';
import { descriptorForRow, downloadResourceYaml, editResourceWindow, resourceKindKey } from '../resource-utils';
import { useThemeMode } from '../theme-context';
import type { ResourceDescriptor, ResourceRow } from '../types';
import { useWorkspaceWindows } from '../workspace-windows-context';
import { Button, IconButton, Modal, Spinner, StatusPill, useToast } from './ui';

export interface ResourceDrawerEntry {
  descriptor: ResourceDescriptor;
  row: ResourceRow;
  initialTab?: 'overview' | 'yaml';
}

function fallbackYaml(row: ResourceRow) {
  return stringify({
    apiVersion: ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'].includes(row.kind) ? 'apps/v1' : 'v1',
    kind: row.kind,
    metadata: {
      name: row.name,
      ...(row.namespace ? { namespace: row.namespace } : {}),
      labels: row.labels,
      annotations: row.annotations,
    },
  });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asObject).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

function podSpec(resource: Record<string, unknown> | undefined) {
  const spec = asObject(resource?.spec);
  if (Array.isArray(spec?.containers)) return spec;
  const templateSpec = asObject(asObject(spec?.template)?.spec);
  if (Array.isArray(templateSpec?.containers)) return templateSpec;
  const jobTemplateSpec = asObject(asObject(asObject(asObject(spec?.jobTemplate)?.spec)?.template)?.spec);
  return Array.isArray(jobTemplateSpec?.containers) ? jobTemplateSpec : undefined;
}

function formatTimestamp(value: unknown) {
  if (typeof value !== 'string' || !value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value) && value.every((item) => ['string', 'number'].includes(typeof item))) {
    return value.length ? <div className="detail-value-list">{value.map((item, index) => <span key={`${item}:${index}`}>{String(item)}</span>)}</div> : '-';
  }
  if (typeof value === 'object') return <pre>{JSON.stringify(value, null, 2)}</pre>;
  return String(value);
}

function resourceReplicas(row: ResourceRow) {
  const desired = Number(row.details.desired);
  if (Number.isFinite(desired)) return desired;
  return Number(row.ready?.split('/')[1] || 1);
}

function DrawerPanel({
  clusterId,
  entry,
  depth,
  canWriteResources,
  closing,
  onRequestClose,
  onOpenRelated,
}: {
  clusterId: string;
  entry: ResourceDrawerEntry;
  depth: number;
  canWriteResources: boolean;
  closing: boolean;
  onRequestClose: () => void;
  onOpenRelated: (entry: ResourceDrawerEntry) => void;
}) {
  const { resolved } = useThemeMode();
  const { clusters, deleteResource, getResourceYaml, getResources, scaleWorkload, restartWorkload } = useData();
  const { windows, openWindow, setWindowStatus } = useWorkspaceWindows();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [tab, setTab] = useState<'overview' | 'yaml'>(entry.initialTab || 'overview');
  const [yaml, setYaml] = useState(() => fallbackYaml(entry.row));
  const [yamlLoading, setYamlLoading] = useState(true);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [scaleOpen, setScaleOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const [replicas, setReplicas] = useState(() => resourceReplicas(entry.row));
  const [savedReplicas, setSavedReplicas] = useState(() => resourceReplicas(entry.row));
  const [busy, setBusy] = useState(false);
  const [localRow, setLocalRow] = useState(entry.row);
  const row = localRow;
  const descriptor = entry.descriptor;
  const kind = resourceKindKey(descriptor.kind || row.kind);
  const restartable = ['deployments', 'statefulsets', 'daemonsets'].includes(kind);
  const scalable = ['deployments', 'statefulsets', 'replicasets'].includes(kind);
  const cluster = clusters.find((item) => item.id === clusterId);
  const podContainer = row.kind === 'Pod' && Array.isArray(row.details.containers)
    ? String(row.details.containers[0] || '') || undefined
    : undefined;

  useEffect(() => {
    let active = true;
    setYamlLoading(true);
    void getResourceYaml(clusterId, descriptor.kind, row).then((resourceYaml) => {
      if (active) setYaml(resourceYaml);
    }).catch(() => undefined).finally(() => {
      if (active) setYamlLoading(false);
    });
    return () => { active = false; };
  }, [clusterId, descriptor.kind, getResourceYaml, row]);

  const relations = useQuery({
    queryKey: ['resource-relations', clusterId, row.uid],
    queryFn: () => loadResourceRelations(row, (relatedKind, namespace) => getResources(clusterId, relatedKind, namespace)),
  });
  const resource = useMemo(() => {
    try { return asObject(parse(yaml)); } catch { return undefined; }
  }, [yaml]);
  const conditions = useMemo(() => asObjects(asObject(resource?.status)?.conditions), [resource]);
  const containers = useMemo(() => asObjects(podSpec(resource)?.containers), [resource]);
  const initContainers = useMemo(() => asObjects(podSpec(resource)?.initContainers), [resource]);
  const volumes = useMemo(() => asObjects(podSpec(resource)?.volumes), [resource]);
  const details = useMemo(() => Object.entries(row.details || {}), [row.details]);
  const containerSpecs = useMemo<Array<Record<string, unknown>>>(() => [
    ...initContainers.map((item) => ({ ...item, __type: 'Init' } as Record<string, unknown>)),
    ...containers.map((item) => ({ ...item, __type: 'Container' } as Record<string, unknown>)),
  ], [containers, initContainers]);

  const invalidate = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['resources', clusterId] }),
    queryClient.invalidateQueries({ queryKey: ['resource-relations', clusterId] }),
    queryClient.invalidateQueries({ queryKey: ['workloads', clusterId] }),
    queryClient.invalidateQueries({ queryKey: ['overview', clusterId] }),
  ]);
  const remove = async () => {
    setBusy(true);
    try {
      await deleteResource(clusterId, descriptor.kind, row);
      await invalidate();
      if (row.kind === 'Pod') {
        windows
          .filter((item) => item.clusterId === clusterId && item.namespace === row.namespace && item.resourceName === row.name)
          .forEach((item) => setWindowStatus(item.id, 'missing', 'Pod 已被删除'));
      }
      pushToast(`${row.kind}/${row.name} 已删除`);
      setDeleteOpen(false);
      onRequestClose();
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '删除资源失败', 'error');
    } finally { setBusy(false); }
  };
  const scaleResource = async () => {
    if (!row.namespace) return false;
    setBusy(true);
    try {
      const updated = await scaleWorkload(clusterId, descriptor.kind, row.namespace, row.name, replicas);
      setLocalRow(updated);
      setSavedReplicas(replicas);
      await invalidate();
      pushToast(`${row.name} 已扩缩容至 ${replicas}`);
      return true;
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '扩缩容失败', 'error');
      return false;
    } finally { setBusy(false); }
  };
  const restartResource = async () => {
    if (!row.namespace) return;
    setBusy(true);
    try {
      const updated = await restartWorkload(clusterId, descriptor.kind, row.namespace, row.name);
      setLocalRow(updated);
      await invalidate();
      setRestartOpen(false);
      pushToast(`${row.kind}/${row.name} 已触发滚动重启`);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '滚动重启失败', 'error');
    } finally { setBusy(false); }
  };
  const editYaml = () => {
    if (!cluster) return;
    openWindow(editResourceWindow(cluster, descriptor, row, yaml));
  };
  const copyYaml = async () => {
    try {
      await copyText(yaml);
      pushToast('YAML 已复制');
    } catch {
      pushToast('浏览器未允许复制，请手动选中 YAML', 'error');
    }
  };

  const drawerStyle = {
    '--drawer-offset': `${Math.min(depth, 5) * 22}px`,
    zIndex: 88,
  } as CSSProperties;
  return <>
    <aside className={`resource-drawer glass-panel ${closing ? 'is-closing' : ''}`} style={drawerStyle} aria-label={`${row.name} 详情`}>
      <header className="drawer__header">
        <div className="resource-identity"><span className="resource-kind-icon"><Layers3 size={20} /></span><div><small>{row.kind}</small><h2>{row.name}</h2></div></div>
        <IconButton label="关闭当前详情" onClick={onRequestClose} disabled={busy}><X size={18} /></IconButton>
      </header>
      <div className="drawer__status"><StatusPill status={row.status} />{row.namespace && <span>{row.namespace}</span>}{row.ready && <span>{row.ready} 就绪</span>}<span>第 {depth + 1} 层</span></div>
      <div className="drawer__actions">
        {row.kind === 'Pod' && row.namespace && <Button variant="secondary" icon={<Logs size={16} />} onClick={() => openWindow({ type: 'logs', clusterId, clusterName: cluster?.name, namespace: row.namespace!, resourceName: row.name, resourceUid: row.uid, container: podContainer })}>日志</Button>}
        {canWriteResources && row.kind === 'Pod' && row.namespace && <Button variant="secondary" icon={<TerminalSquare size={16} />} onClick={() => openWindow({ type: 'shell', clusterId, clusterName: cluster?.name, namespace: row.namespace!, resourceName: row.name, resourceUid: row.uid, container: podContainer })}>终端</Button>}
        {canWriteResources && row.kind === 'Pod' && row.namespace && <Button variant="secondary" icon={<FolderOpen size={16} />} onClick={() => openWindow({ type: 'files', clusterId, clusterName: cluster?.name, namespace: row.namespace!, resourceName: row.name, resourceUid: row.uid, container: podContainer })}>文件</Button>}
        {canWriteResources && restartable && <Button variant="secondary" icon={<RotateCw size={16} />} onClick={() => setRestartOpen(true)}>重启</Button>}
        {canWriteResources && scalable && <Button variant="secondary" icon={<Scale size={16} />} onClick={() => { setReplicas(savedReplicas); setScaleOpen(true); }}>扩缩容</Button>}
        {canWriteResources && <Button variant="secondary" icon={<FilePenLine size={16} />} onClick={editYaml} disabled={yamlLoading}>编辑</Button>}
        <Button variant="secondary" icon={<Download size={16} />} onClick={() => downloadResourceYaml(row, yaml)} disabled={yamlLoading}>下载</Button>
        <Button variant="secondary" icon={<Copy size={16} />} onClick={() => void copyYaml()} disabled={yamlLoading}>复制</Button>
        {canWriteResources && <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => setDeleteOpen(true)}>删除</Button>}
      </div>
      <div className="drawer-tabs" role="tablist">
        <button className={tab === 'overview' ? 'is-active' : ''} onClick={() => setTab('overview')}><FileText size={15} />详情</button>
        <button className={tab === 'yaml' ? 'is-active' : ''} onClick={() => setTab('yaml')}><Braces size={15} />YAML</button>
      </div>
      <div className={`drawer__body ${tab === 'yaml' ? 'drawer__body--yaml' : ''}`}>
        {tab === 'overview' && <>
          <section className="detail-section"><h3>元数据</h3><dl className="detail-grid detail-grid--metadata">
            <div><dt>名称</dt><dd>{row.name}</dd></div><div><dt>命名空间</dt><dd>{row.namespace || '集群级'}</dd></div>
            <div><dt>UID</dt><dd className="mono-cell wrap-anywhere">{row.uid}</dd></div><div><dt>创建时间</dt><dd>{formatTimestamp(row.createdAt)}</dd></div>
            <div><dt>Generation</dt><dd>{row.generation ?? '-'}</dd></div><div><dt>Resource Version</dt><dd className="mono-cell">{row.resourceVersion || '-'}</dd></div>
          </dl></section>
          <section className="detail-section"><h3>标签</h3><div className="labels">{Object.entries(row.labels || {}).map(([key, value]) => <span key={key}>{key}{value ? `=${value}` : ''}</span>)}{Object.keys(row.labels || {}).length === 0 && <em>无</em>}</div></section>
          <section className="detail-section"><h3>Annotations</h3><div className="labels labels--annotations">{Object.entries(row.annotations || {}).map(([key, value]) => <span key={key}>{key}={value}</span>)}{Object.keys(row.annotations || {}).length === 0 && <em>无</em>}</div></section>
          {(row.ownerReferences || []).length > 0 && <section className="detail-section"><h3>所有者</h3><div className="owner-reference-list">{row.ownerReferences.map((owner) => <div key={owner.uid}><strong>{owner.kind}/{owner.name}</strong><span>{owner.controller ? '控制器' : '引用'} · {owner.apiVersion}</span></div>)}</div></section>}
          {details.length > 0 && <section className="detail-section"><h3>状态与规格</h3><dl className="detail-grid detail-grid--resources">{details.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{displayValue(value)}</dd></div>)}</dl></section>}
          {conditions.length > 0 && <section className="detail-section"><h3>Conditions</h3><div className="detail-table-wrap"><table className="detail-table"><thead><tr><th>条件</th><th>状态</th><th>原因</th><th>最后更新</th><th>消息</th></tr></thead><tbody>{conditions.map((condition, index) => <tr key={`${condition.type}:${index}`}><td><strong>{String(condition.type || '-')}</strong></td><td><StatusPill status={String(condition.status || 'Unknown')} /></td><td>{String(condition.reason || '-')}</td><td>{formatTimestamp(condition.lastTransitionTime || condition.lastUpdateTime)}</td><td className="detail-message-cell">{String(condition.message || '-')}</td></tr>)}</tbody></table></div></section>}
          {containerSpecs.length > 0 && <section className="detail-section"><h3>容器规格</h3><div className="container-spec-list">{containerSpecs.map((container, index) => <article key={`${container.name}:${index}`}><header><strong>{String(container.name || `container-${index + 1}`)}</strong><span>{String(container.__type)}</span></header><dl><div><dt>镜像</dt><dd className="mono-cell wrap-anywhere">{String(container.image || '-')}</dd></div><div><dt>拉取策略</dt><dd>{String(container.imagePullPolicy || '-')}</dd></div><div><dt>端口</dt><dd>{displayValue(container.ports)}</dd></div><div><dt>资源</dt><dd>{displayValue(container.resources)}</dd></div><div><dt>挂载</dt><dd>{displayValue(container.volumeMounts)}</dd></div><div><dt>探针</dt><dd>{[container.livenessProbe && 'Liveness', container.readinessProbe && 'Readiness', container.startupProbe && 'Startup'].filter(Boolean).join(' / ') || '-'}</dd></div></dl></article>)}</div></section>}
          {volumes.length > 0 && <section className="detail-section"><h3>卷</h3><div className="detail-table-wrap"><table className="detail-table"><thead><tr><th>名称</th><th>类型</th><th>来源</th></tr></thead><tbody>{volumes.map((volume, index) => { const source = Object.keys(volume).find((key) => key !== 'name'); return <tr key={`${volume.name}:${index}`}><td><strong>{String(volume.name || '-')}</strong></td><td>{source || '-'}</td><td>{displayValue(source ? volume[source] : undefined)}</td></tr>; })}</tbody></table></div></section>}
          <section className="detail-section"><div className="detail-section__heading"><h3>关联资源</h3>{relations.data && <span>{relations.data.groups.reduce((total, group) => total + group.rows.length, 0)} 项</span>}</div>
            {relations.isLoading ? <Spinner label="分析资源关系" /> : relations.data?.groups.length ? <div className="resource-relations">{relations.data.groups.map((group) => <section key={group.id} className="resource-relation-group"><header><div><strong>{group.label}</strong><span>{group.relation}</span></div><em>{group.rows.length}</em></header><div>{group.rows.map((related) => <button key={related.uid} onClick={() => onOpenRelated({ descriptor: descriptorForRow(related), row: related })}><span><strong>{related.name}</strong><small>{related.kind}{related.namespace ? ` · ${related.namespace}` : ''}</small></span><StatusPill status={related.status} /><Layers3 size={15} /></button>)}</div></section>)}</div> : <p className="detail-empty-copy">未发现可关联的资源。</p>}
          </section>
          {relations.data?.events.length ? <section className="detail-section"><div className="detail-section__heading"><h3>事件</h3><span>{relations.data.events.length} 条</span></div><div className="detail-table-wrap"><table className="detail-table"><thead><tr><th>类型</th><th>原因</th><th>来源</th><th>消息</th><th>时间</th></tr></thead><tbody>{relations.data.events.map((event) => <tr key={event.uid} className="is-clickable" onClick={() => onOpenRelated({ descriptor: descriptorForRow(event), row: event })}><td><StatusPill status={event.status} /></td><td>{String(event.details.reason || '-')}</td><td>{String(event.details.source || '-')}</td><td className="detail-message-cell">{String(event.details.message || '-')}</td><td>{formatTimestamp(event.details.lastSeen || event.createdAt)}</td></tr>)}</tbody></table></div></section> : null}
        </>}
        {tab === 'yaml' && <div className="drawer-yaml-view">{yamlLoading ? <Spinner label="读取资源 YAML" /> : <Editor height="100%" theme={resolved === 'dark' ? 'vs-dark' : 'vs'} language="yaml" value={yaml} options={{ readOnly: true, automaticLayout: true, minimap: { enabled: false }, fontSize: 13, lineHeight: 21, padding: { top: 14 }, wordWrap: 'on', scrollBeyondLastLine: false }} />}</div>}
      </div>
    </aside>

    <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title={`删除 ${row.name}`} width="440px" footer={<><Button variant="ghost" onClick={() => setDeleteOpen(false)}>取消</Button><Button variant="danger" onClick={() => void remove()} disabled={busy} icon={<Trash2 size={16} />}>{busy ? '删除中' : '确认删除'}</Button></>}><p className="confirm-copy">资源 <strong>{row.kind}/{row.name}</strong> 将从集群中删除。</p></Modal>
    <Modal open={restartOpen} onClose={() => setRestartOpen(false)} title={`重启 ${row.name}`} width="440px" footer={<><Button variant="ghost" onClick={() => setRestartOpen(false)}>取消</Button><Button variant="primary" onClick={() => void restartResource()} disabled={busy} icon={<RotateCw size={16} />}>{busy ? '触发中' : '滚动重启'}</Button></>}><p className="confirm-copy">将更新 Pod 模板并触发 <strong>{row.kind}/{row.name}</strong> 的滚动重启。</p></Modal>
    <Modal open={scaleOpen} onClose={() => setScaleOpen(false)} title={`扩缩容 ${row.kind}`} width="420px" dirty={replicas !== savedReplicas} closeDisabled={busy} onSave={scaleResource} onDiscard={() => setReplicas(savedReplicas)} footer={(requestClose) => <><Button variant="ghost" onClick={requestClose}>取消</Button><Button variant="primary" onClick={async () => { if (await scaleResource()) setScaleOpen(false); }} disabled={busy} icon={<Scale size={16} />}>{busy ? '更新中' : '更新副本数'}</Button></>}><label className="field"><span>副本数</span><input type="number" min={0} max={10000} value={replicas} onChange={(event) => setReplicas(Number(event.target.value))} /></label></Modal>
  </>;
}

export function ResourceDrawer({
  clusterId,
  stack,
  canWriteResources,
  onCloseTop,
  onOpenRelated,
  onPopTo,
}: {
  clusterId: string;
  stack: ResourceDrawerEntry[];
  canWriteResources: boolean;
  onCloseTop: () => void;
  onOpenRelated: (entry: ResourceDrawerEntry) => void;
  onPopTo: (index: number) => void;
}) {
  const top = stack.at(-1);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const beginClose = useCallback(() => {
    if (!top || closing) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      onCloseTop();
      setClosing(false);
    }, motionDuration(230));
  }, [closing, onCloseTop, top]);
  useEscapeLayer(Boolean(top) && !closing, beginClose, 60 + stack.length);
  useEffect(() => () => {
    if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current);
  }, []);
  if (!top) return null;
  return <>
    <button className={`drawer-scrim ${closing && stack.length === 1 ? 'is-closing' : ''}`} aria-label="关闭当前详情" onClick={beginClose} />
    {stack.slice(0, -1).map((entry, index) => <button
      key={`${entry.row.uid}:${index}`}
      type="button"
      className="drawer-layer-spine glass-panel"
      style={{ '--drawer-offset': `${Math.min(index, 5) * 22}px`, zIndex: 81 + Math.min(index, 6) } as CSSProperties}
      aria-label={`返回 ${entry.row.kind} ${entry.row.name}`}
      onClick={() => onPopTo(index)}
    ><span>{entry.row.kind}</span><strong>{entry.row.name}</strong></button>)}
    <DrawerPanel
      key={`${top.row.uid}:${top.initialTab || 'overview'}:${stack.length}`}
      clusterId={clusterId}
      entry={top}
      depth={stack.length - 1}
      canWriteResources={canWriteResources}
      closing={closing}
      onRequestClose={beginClose}
      onOpenRelated={onOpenRelated}
    />
  </>;
}
