import {
  CirclePlus,
  ChevronLeft,
  ChevronRight,
  ListChecks,
  RefreshCw,
  RotateCw,
  Scale,
  Search,
  ServerCrash,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth-context';
import { ResourceDrawer, type ResourceDrawerEntry } from '../components/ResourceDrawer';
import type { ResourceAction } from '../components/ResourceActionMenu';
import { ResourceTable } from '../components/ResourceTable';
import { Button, EmptyState, IconButton, Modal, SelectMenu, useToast } from '../components/ui';
import { useData } from '../data-context';
import { resourceDescriptors } from '../navigation';
import { useNamespaceSelection } from '../namespace-context';
import {
  downloadResourceYaml,
  editResourceWindow,
  newResourceEditorWindow,
} from '../resource-utils';
import type { ResourceRow } from '../types';
import { useWorkspaceWindows } from '../workspace-windows-context';
import { usePreferences } from '../preferences-context';

type ConfirmedAction = 'delete' | 'restart' | 'scale';

interface PendingAction {
  type: ConfirmedAction;
  row: ResourceRow;
}

function replicasFor(row: ResourceRow) {
  const desired = Number(row.details.desired);
  if (Number.isFinite(desired)) return desired;
  const ready = Number(row.ready?.split('/')[1]);
  return Number.isFinite(ready) ? ready : 1;
}

function firstContainer(row: ResourceRow) {
  if (row.kind !== 'Pod' || !Array.isArray(row.details.containers)) return undefined;
  return String(row.details.containers[0] || '') || undefined;
}

export function ResourcePage() {
  const { clusterId = '', kind = '' } = useParams();
  const [searchParams] = useSearchParams();
  const { getNamespace } = useNamespaceSelection();
  const namespace = searchParams.get('namespace') || getNamespace(clusterId);
  const focusUid = searchParams.get('focus');
  const descriptor = resourceDescriptors[kind];
  const {
    clusters,
    deleteResource,
    getResourceYaml,
    getResources,
    restartWorkload,
    scaleWorkload,
  } = useData();
  const cluster = clusters.find((item) => item.id === clusterId);
  const { pushToast } = useToast();
  const { user } = useAuth();
  const { openWindow, setWindowStatus, windows } = useWorkspaceWindows();
  const { settings: preferences } = usePreferences();
  const canWriteResources = Boolean(user?.roles.some((role) => role === 'admin' || role === 'operator'));
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [drawerStack, setDrawerStack] = useState<ResourceDrawerEntry[]>([]);
  const [pendingAction, setPendingAction] = useState<PendingAction>();
  const [replicas, setReplicas] = useState(1);
  const [savedReplicas, setSavedReplicas] = useState(1);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['resources', clusterId, kind, namespace],
    queryFn: () => getResources(clusterId, kind, descriptor?.namespaced ? namespace : undefined),
    enabled: Boolean(clusterId && descriptor),
    refetchInterval: preferences?.autoRefresh ? 60_000 : false,
  });

  useEffect(() => {
    setSelected(new Set());
    setSelectionMode(false);
    setDrawerStack([]);
  }, [kind, namespace]);
  const rows = useMemo(() => query.data?.items || [], [query.data?.items]);
  useEffect(() => {
    if (!focusUid || !rows.length || !descriptor) return;
    const target = rows.find((row) => row.uid === focusUid);
    if (!target) return;
    setDrawerStack((current) => current.length === 1 && current[0].row.uid === target.uid
      ? current
      : [{ descriptor, row: target }]);
  }, [descriptor, focusUid, rows]);
  const statuses = useMemo(() => [...new Set(rows.map((row) => row.status))].sort(), [rows]);
  const filtered = useMemo(() => rows.filter((row) => {
    const queryText = search.trim().toLowerCase();
    const matchesSearch = !queryText || `${row.name} ${row.namespace || ''} ${Object.entries(row.labels).flat().join(' ')}`.toLowerCase().includes(queryText);
    return matchesSearch && (status === 'all' || row.status === status);
  }), [rows, search, status]);
  const pageSize = preferences?.pageSize || 25;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visibleRows = filtered.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => setPage(1), [kind, namespace, search, status]);

  const invalidateResources = useCallback(() => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['resources', clusterId] }),
    queryClient.invalidateQueries({ queryKey: ['resource-relations', clusterId] }),
    queryClient.invalidateQueries({ queryKey: ['workloads', clusterId] }),
    queryClient.invalidateQueries({ queryKey: ['overview', clusterId] }),
  ]), [clusterId, queryClient]);

  const markPodWindowsMissing = useCallback((row: ResourceRow) => {
    if (row.kind !== 'Pod') return;
    windows
      .filter((item) => item.clusterId === clusterId && item.namespace === row.namespace && item.resourceName === row.name)
      .forEach((item) => setWindowStatus(item.id, 'missing', 'Pod 已被删除'));
  }, [clusterId, setWindowStatus, windows]);

  const openRootDrawer = useCallback((row: ResourceRow, initialTab: ResourceDrawerEntry['initialTab'] = 'overview') => {
    if (!descriptor) return;
    setDrawerStack([{ descriptor, row, initialTab }]);
  }, [descriptor]);

  const openRelated = useCallback((entry: ResourceDrawerEntry) => {
    setDrawerStack((current) => {
      const existingIndex = current.findIndex((candidate) => candidate.row.uid === entry.row.uid);
      if (existingIndex >= 0) return current.slice(0, existingIndex + 1);
      return [...current, entry];
    });
  }, []);

  const handleResourceAction = useCallback(async (action: ResourceAction, row: ResourceRow) => {
    if (!cluster || !descriptor) return;
    if (action === 'view-yaml') {
      openRootDrawer(row, 'yaml');
      return;
    }
    if (action === 'logs' || action === 'shell' || action === 'files') {
      if (!row.namespace) return;
      openWindow({
        type: action,
        clusterId,
        clusterName: cluster.name,
        namespace: row.namespace,
        resourceName: row.name,
        resourceUid: row.uid,
        container: firstContainer(row),
      });
      return;
    }
    if (action === 'restart' || action === 'delete') {
      setPendingAction({ type: action, row });
      return;
    }
    if (action === 'scale') {
      const currentReplicas = replicasFor(row);
      setReplicas(currentReplicas);
      setSavedReplicas(currentReplicas);
      setPendingAction({ type: action, row });
      return;
    }
    try {
      const yaml = await getResourceYaml(clusterId, descriptor.kind, row);
      if (action === 'edit') openWindow(editResourceWindow(cluster, descriptor, row, yaml));
      if (action === 'download') downloadResourceYaml(row, yaml);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '读取资源 YAML 失败', 'error');
    }
  }, [cluster, clusterId, descriptor, getResourceYaml, openRootDrawer, openWindow, pushToast]);

  const runPendingAction = async () => {
    if (!pendingAction) return false;
    const { row, type } = pendingAction;
    if ((type === 'restart' || type === 'scale') && !row.namespace) return false;
    setBusy(true);
    try {
      if (type === 'delete') {
        await deleteResource(clusterId, kind, row);
        markPodWindowsMissing(row);
        setDrawerStack((current) => current.filter((entry) => entry.row.uid !== row.uid));
        pushToast(`${row.kind}/${row.name} 已删除`);
      } else if (type === 'restart') {
        await restartWorkload(clusterId, kind, row.namespace!, row.name);
        pushToast(`${row.kind}/${row.name} 已触发滚动重启`);
      } else {
        await scaleWorkload(clusterId, kind, row.namespace!, row.name, replicas);
        setSavedReplicas(replicas);
        pushToast(`${row.name} 已扩缩容至 ${replicas}`);
      }
      await invalidateResources();
      setPendingAction(undefined);
      return true;
    } catch (error) {
      const fallback = type === 'delete' ? '删除资源失败' : type === 'restart' ? '滚动重启失败' : '扩缩容失败';
      pushToast(error instanceof Error ? error.message : fallback, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const bulkDelete = async () => {
    const targets = rows.filter((row) => selected.has(row.uid));
    setBusy(true);
    try {
      for (const row of targets) {
        await deleteResource(clusterId, kind, row);
        markPodWindowsMissing(row);
      }
      setSelected(new Set());
      setSelectionMode(false);
      setBulkDeleteOpen(false);
      await invalidateResources();
      pushToast(`已删除 ${targets.length} 个资源`);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '批量删除失败', 'error');
    } finally { setBusy(false); }
  };

  if (!descriptor) return <div className="page"><EmptyState icon={<ServerCrash size={24} />} title="不支持的资源类型" /></div>;
  if (!cluster) return <div className="page"><EmptyState icon={<ServerCrash size={24} />} title="集群不存在" /></div>;

  const pendingRow = pendingAction?.row;
  return (
    <div className="page resource-page">
      <header className="page-header compact-page-header">
        <div><span className="eyebrow">{descriptor.group}</span><h2>{descriptor.label}</h2></div>
        <div className="page-actions"><span className="resource-count">{rows.length} 项</span><IconButton label="刷新" onClick={() => void query.refetch()}><RefreshCw size={18} /></IconButton>{canWriteResources && <Button variant="primary" aria-label="创建资源" icon={<CirclePlus size={17} />} onClick={() => openWindow(newResourceEditorWindow(cluster, namespace, kind))}>创建资源</Button>}</div>
      </header>
      <section className="content-section glass-card resource-workspace">
        <div className="resource-toolbar">
          <div className="search-field"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称或标签" /></div>
          <div className="filter-select"><SlidersHorizontal size={15} /><SelectMenu aria-label="状态过滤" value={status} options={[{ value: 'all', label: '全部状态' }, ...statuses.map((item) => ({ value: item, label: item }))]} onChange={setStatus} /></div>
          {canWriteResources && <Button className="batch-mode-button" variant={selectionMode ? 'secondary' : 'ghost'} icon={<ListChecks size={16} />} aria-pressed={selectionMode} onClick={() => { setSelectionMode((current) => !current); setSelected(new Set()); }}>{selectionMode ? '退出批量' : '批量操作'}</Button>}
          {canWriteResources && selected.size > 0 && <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => setBulkDeleteOpen(true)}>删除 {selected.size} 项</Button>}
        </div>
        {query.error
          ? <EmptyState icon={<ServerCrash size={24} />} title="无法读取资源" body={query.error instanceof Error ? query.error.message : undefined} action={<Button onClick={() => void query.refetch()}>重试</Button>} />
          : <><ResourceTable rows={visibleRows} loading={query.isLoading} selectionMode={selectionMode} selected={selected} onSelected={setSelected} onOpen={(row) => openRootDrawer(row)} canWriteResources={canWriteResources} onAction={(action, row) => void handleResourceAction(action, row)} /><div className="resource-pagination"><span>显示 {(page - 1) * pageSize + (visibleRows.length ? 1 : 0)}-{Math.min(page * pageSize, filtered.length)} / {filtered.length}</span><div><IconButton label="上一页" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}><ChevronLeft size={16} /></IconButton><span>{page} / {pageCount}</span><IconButton label="下一页" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={page >= pageCount}><ChevronRight size={16} /></IconButton></div></div></>}
      </section>
      <ResourceDrawer
        clusterId={clusterId}
        stack={drawerStack}
        canWriteResources={canWriteResources}
        onCloseTop={() => setDrawerStack((current) => current.slice(0, -1))}
        onOpenRelated={openRelated}
        onPopTo={(index) => setDrawerStack((current) => current.slice(0, index + 1))}
      />
      <Modal open={pendingAction?.type === 'delete'} onClose={() => setPendingAction(undefined)} title={`删除 ${pendingRow?.name || '资源'}`} width="440px" closeDisabled={busy} footer={<><Button variant="ghost" onClick={() => setPendingAction(undefined)} disabled={busy}>取消</Button><Button variant="danger" icon={<Trash2 size={16} />} onClick={() => void runPendingAction()} disabled={busy}>{busy ? '删除中' : '确认删除'}</Button></>}>
        <p className="confirm-copy">资源 <strong>{pendingRow?.kind}/{pendingRow?.name}</strong> 将从集群中删除。</p>
      </Modal>
      <Modal open={pendingAction?.type === 'restart'} onClose={() => setPendingAction(undefined)} title={`重启 ${pendingRow?.name || '工作负载'}`} width="440px" closeDisabled={busy} footer={<><Button variant="ghost" onClick={() => setPendingAction(undefined)} disabled={busy}>取消</Button><Button variant="primary" icon={<RotateCw size={16} />} onClick={() => void runPendingAction()} disabled={busy}>{busy ? '触发中' : '滚动重启'}</Button></>}>
        <p className="confirm-copy">将更新 Pod 模板并触发 <strong>{pendingRow?.kind}/{pendingRow?.name}</strong> 的滚动重启。</p>
      </Modal>
      <Modal open={pendingAction?.type === 'scale'} onClose={() => setPendingAction(undefined)} title={`扩缩容 ${pendingRow?.kind || '工作负载'}`} width="420px" dirty={replicas !== savedReplicas} closeDisabled={busy} onSave={runPendingAction} onDiscard={() => setReplicas(savedReplicas)} footer={(requestClose) => <><Button variant="ghost" onClick={requestClose} disabled={busy}>取消</Button><Button variant="primary" icon={<Scale size={16} />} onClick={() => void runPendingAction()} disabled={busy}>{busy ? '更新中' : '更新副本数'}</Button></>}>
        <label className="field"><span>副本数</span><input type="number" min={0} max={10000} value={replicas} onChange={(event) => setReplicas(Number(event.target.value))} /></label>
      </Modal>
      <Modal open={bulkDeleteOpen} onClose={() => setBulkDeleteOpen(false)} title={`删除 ${selected.size} 个资源`} width="440px" closeDisabled={busy} footer={<><Button variant="ghost" onClick={() => setBulkDeleteOpen(false)} disabled={busy}>取消</Button><Button variant="danger" icon={<Trash2 size={16} />} onClick={() => void bulkDelete()} disabled={busy}>{busy ? '删除中' : '确认删除'}</Button></>}>
        <p className="confirm-copy">所选 {descriptor.label} 将从集群中删除。</p>
      </Modal>
    </div>
  );
}
