import { CirclePlus, RefreshCw, Search, ServerCrash, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { ResourceDrawer } from '../components/ResourceDrawer';
import { ResourceTable } from '../components/ResourceTable';
import { YamlApplyModal } from '../components/YamlApplyModal';
import { Button, EmptyState, IconButton, Modal, useToast } from '../components/ui';
import { useData } from '../data-context';
import { resourceDescriptors } from '../navigation';
import type { ResourceRow } from '../types';

export function ResourcePage() {
  const { clusterId = '', kind = '' } = useParams();
  const [searchParams] = useSearchParams();
  const namespace = searchParams.get('namespace') || 'all';
  const descriptor = resourceDescriptors[kind];
  const { clusters, mode, getResources, deleteResource } = useData();
  const cluster = clusters.find((item) => item.id === clusterId);
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openRow, setOpenRow] = useState<ResourceRow>();
  const [applyOpen, setApplyOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const query = useQuery({
    queryKey: ['resources', clusterId, kind, namespace, mode],
    queryFn: () => getResources(clusterId, kind, descriptor?.namespaced ? namespace : undefined),
    enabled: Boolean(clusterId && descriptor),
  });

  useEffect(() => { setSelected(new Set()); setOpenRow(undefined); }, [kind, namespace]);
  const rows = useMemo(() => query.data?.items || [], [query.data?.items]);
  const statuses = useMemo(() => [...new Set(rows.map((row) => row.status))].sort(), [rows]);
  const filtered = useMemo(() => rows.filter((row) => {
    const queryText = search.trim().toLowerCase();
    const matchesSearch = !queryText || `${row.name} ${row.namespace || ''} ${Object.entries(row.labels).flat().join(' ')}`.toLowerCase().includes(queryText);
    return matchesSearch && (status === 'all' || row.status === status);
  }), [rows, search, status]);

  if (!descriptor) return <div className="page"><EmptyState icon={<ServerCrash size={24} />} title="不支持的资源类型" /></div>;
  if (!cluster) return <div className="page"><EmptyState icon={<ServerCrash size={24} />} title="集群不存在" /></div>;

  const bulkDelete = async () => {
    const targets = rows.filter((row) => selected.has(row.uid));
    setBusy(true);
    try {
      for (const row of targets) await deleteResource(clusterId, kind, row);
      setSelected(new Set());
      setBulkDeleteOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['resources', clusterId] });
      pushToast(`已删除 ${targets.length} 个资源`);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '批量删除失败', 'error');
    } finally { setBusy(false); }
  };

  return (
    <div className="page resource-page">
      <header className="page-header compact-page-header">
        <div><span className="eyebrow">{descriptor.group}</span><h2>{descriptor.label}</h2></div>
        <div className="page-actions"><span className="resource-count">{rows.length} 项</span><IconButton label="刷新" onClick={() => void query.refetch()}><RefreshCw size={18} /></IconButton><Button variant="primary" aria-label="创建资源" icon={<CirclePlus size={17} />} onClick={() => setApplyOpen(true)}>创建资源</Button></div>
      </header>
      <section className="content-section glass-card resource-workspace">
        <div className="resource-toolbar">
          <div className="search-field"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称或标签" /></div>
          <label className="filter-select"><SlidersHorizontal size={15} /><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option>{statuses.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          {selected.size > 0 && <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => setBulkDeleteOpen(true)}>删除 {selected.size} 项</Button>}
        </div>
        {query.error ? <EmptyState icon={<ServerCrash size={24} />} title="无法读取资源" body={query.error instanceof Error ? query.error.message : undefined} action={<Button onClick={() => void query.refetch()}>重试</Button>} /> : <ResourceTable rows={filtered} loading={query.isLoading} selected={selected} onSelected={setSelected} onOpen={setOpenRow} />}
      </section>
      <YamlApplyModal cluster={cluster} open={applyOpen} onClose={() => setApplyOpen(false)} />
      <ResourceDrawer clusterId={clusterId} descriptor={descriptor} row={openRow} onClose={() => setOpenRow(undefined)} />
      <Modal open={bulkDeleteOpen} onClose={() => setBulkDeleteOpen(false)} title={`删除 ${selected.size} 个资源`} width="440px" footer={<><Button variant="ghost" onClick={() => setBulkDeleteOpen(false)}>取消</Button><Button variant="danger" icon={<Trash2 size={16} />} onClick={bulkDelete} disabled={busy}>{busy ? '删除中' : '确认删除'}</Button></>}>
        <p className="confirm-copy">所选 {descriptor.label} 将从集群中删除。</p>
      </Modal>
    </div>
  );
}
