import { Activity, Box, Cpu, MemoryStick, RefreshCw, ServerCrash, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useData } from '../data-context';
import { resourceDescriptors } from '../navigation';
import type { ResourceRow } from '../types';
import { ResourceDrawer } from '../components/ResourceDrawer';
import { ResourceTable } from '../components/ResourceTable';
import { Button, EmptyState, IconButton, Spinner, StatusPill } from '../components/ui';

function CircularStat({
  label,
  value,
  display,
  detail,
  tone,
  icon,
}: {
  label: string;
  value?: number;
  display: string;
  detail: string;
  tone: string;
  icon: React.ReactNode;
}) {
  return (
    <article className="circular-stat glass-card">
      <div className="circular-stat__copy">
        <span>{label}</span>
        <strong>{display}</strong>
        <p>{detail}</p>
      </div>
      <span className="stat-icon" style={{ color: tone }}>{icon}</span>
      <div className="metric-progress" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%`, background: tone }} /></div>
    </article>
  );
}

export function OverviewPage() {
  const { clusterId = '' } = useParams();
  const { clusters, getOverview } = useData();
  const cluster = clusters.find((item) => item.id === clusterId);
  const [warningsOnly, setWarningsOnly] = useState(true);
  const [selectedRow, setSelectedRow] = useState<ResourceRow>();
  const query = useQuery({
    queryKey: ['overview', clusterId],
    queryFn: () => getOverview(clusterId),
    enabled: Boolean(clusterId),
    refetchInterval: 60_000,
  });

  if (!cluster) return <div className="page"><EmptyState icon={<ServerCrash size={24} />} title="集群不存在" /></div>;
  if (query.isLoading) return <div className="page"><Spinner label="正在读取集群概览" /></div>;
  if (query.error || !query.data) return <div className="page"><EmptyState icon={<ServerCrash size={24} />} title="无法读取集群" body={query.error instanceof Error ? query.error.message : undefined} action={<Button onClick={() => void query.refetch()}>重试</Button>} /></div>;
  const overview = query.data;
  const warningEvents = warningsOnly ? overview.events.filter((event) => event.status === 'Warning') : overview.events;
  const descriptor = selectedRow ? Object.values(resourceDescriptors).find((item) => item.singular === selectedRow.kind) : undefined;

  return (
    <div className="page overview-page">
      <header className="page-header compact-page-header">
        <div><span className="eyebrow">{cluster.kubernetesVersion || 'Kubernetes'}</span><h2>集群概览</h2></div>
        <div className="page-actions"><span className="last-updated"><i />{cluster.status === 'connected' ? 'API 正常' : '连接异常'}</span><IconButton label="刷新概览" onClick={() => void query.refetch()}><RefreshCw size={18} /></IconButton></div>
      </header>
      <section className="overview-stats" aria-label="集群指标">
        <CircularStat label="CPU" value={overview.cpuPercent} display={overview.cpuPercent === undefined ? '--' : `${Math.round(overview.cpuPercent)}%`} detail={overview.cpuPercent === undefined ? 'Metrics API 未启用' : '集群请求负载'} tone="#3578c4" icon={<Cpu size={18} />} />
        <CircularStat label="内存" value={overview.memoryPercent} display={overview.memoryPercent === undefined ? '--' : `${Math.round(overview.memoryPercent)}%`} detail={overview.memoryPercent === undefined ? 'Metrics API 未启用' : '工作集使用率'} tone="#8a63b8" icon={<MemoryStick size={18} />} />
        <CircularStat label="Pods" value={overview.pods.total ? overview.pods.healthy / overview.pods.total * 100 : 0} display={`${overview.pods.healthy}/${overview.pods.total}`} detail={`${overview.pods.total - overview.pods.healthy} 个异常`} tone="#2e8b72" icon={<Box size={18} />} />
        <CircularStat label="节点" value={overview.nodes.total ? overview.nodes.healthy / overview.nodes.total * 100 : 0} display={`${overview.nodes.healthy}/${overview.nodes.total}`} detail={`${overview.nodes.healthy} 个 Ready`} tone="#c07a3d" icon={<Activity size={18} />} />
      </section>

      <section className="content-section glass-card">
        <div className="section-toolbar"><div><h2>工作负载</h2><span>{overview.workloads.length}</span></div></div>
        <ResourceTable rows={overview.workloads.slice(0, 8)} showKind onOpen={setSelectedRow} />
      </section>

      <section className="content-section glass-card">
        <div className="section-toolbar"><div><h2>事件</h2><span>{overview.events.length}</span></div><label className="switch-control"><input type="checkbox" checked={warningsOnly} onChange={(event) => setWarningsOnly(event.target.checked)} /><i /><span>仅警告 ({overview.events.filter((event) => event.status === 'Warning').length})</span></label></div>
        {warningEvents.length === 0 ? <EmptyState icon={<TriangleAlert size={23} />} title="没有警告事件" /> : <div className="resource-table-wrap"><table className="resource-table events-table"><thead><tr><th>类型</th><th>对象</th><th>命名空间</th><th>原因</th><th>消息</th><th>最后出现</th></tr></thead><tbody>{warningEvents.map((event) => <tr key={event.uid}><td><StatusPill status={event.status} /></td><td>{String(event.details.objectKind || '')}: <strong>{String(event.details.objectName || event.name)}</strong></td><td>{event.namespace || '-'}</td><td>{String(event.details.reason || '-')}</td><td className="event-message">{String(event.details.message || '-')}</td><td className="muted-cell">{event.details.lastSeen ? new Date(String(event.details.lastSeen)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '-'}</td></tr>)}</tbody></table></div>}
      </section>
      {selectedRow && descriptor && <ResourceDrawer clusterId={clusterId} descriptor={descriptor} row={selectedRow} onClose={() => setSelectedRow(undefined)} />}
    </div>
  );
}
