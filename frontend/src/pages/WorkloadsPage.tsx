import { RefreshCw, ServerCrash } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { ResourceDrawer } from '../components/ResourceDrawer';
import { ResourceTable } from '../components/ResourceTable';
import { EmptyState, IconButton } from '../components/ui';
import { useData } from '../data-context';
import { resourceDescriptors } from '../navigation';
import type { ResourceRow } from '../types';

const kinds = ['pods', 'deployments', 'statefulsets', 'daemonsets', 'replicasets', 'jobs', 'cronjobs'];
const tones = ['#3978bd', '#2d8b73', '#8a63b8', '#c07a3d', '#4f8894', '#a95e68', '#677388'];

function healthy(row: ResourceRow) {
  return !/fail|error|crash|backoff|notready|pending/i.test(row.status);
}

export function WorkloadsPage() {
  const { clusterId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const namespace = searchParams.get('namespace') || 'all';
  const { getResources } = useData();
  const [openRow, setOpenRow] = useState<ResourceRow>();
  const query = useQuery({
    queryKey: ['workloads', clusterId, namespace],
    queryFn: async () => Promise.all(kinds.map((kind) => getResources(clusterId, kind, namespace))),
    enabled: Boolean(clusterId),
  });
  const groups = useMemo(() => query.data || [], [query.data]);
  const rows = useMemo(() => groups.slice(1).flatMap((group) => group.items), [groups]);
  const descriptor = openRow ? Object.values(resourceDescriptors).find((item) => item.singular === openRow.kind) : undefined;

  return (
    <div className="page workloads-page">
      <header className="page-header compact-page-header"><div><span className="eyebrow">workloads</span><h2>工作负载</h2></div><div className="page-actions"><span className="resource-count">{rows.length} 项</span><IconButton label="刷新" onClick={() => void query.refetch()}><RefreshCw size={18} /></IconButton></div></header>
      {query.error ? <EmptyState icon={<ServerCrash size={24} />} title="无法读取工作负载" body={query.error instanceof Error ? query.error.message : undefined} /> : (
        <>
          <section className="workload-stats">{kinds.map((kind, index) => {
            const descriptor = resourceDescriptors[kind];
            const items = groups[index]?.items || [];
            const healthyCount = items.filter(healthy).length;
            const percent = items.length ? healthyCount / items.length * 100 : 0;
            return <article className="workload-stat glass-card" key={kind}><div className="mini-ring" style={{ '--chart-value': `${percent}%`, '--chart-tone': tones[index] } as React.CSSProperties}><span>{items.length}</span></div><div><h3>{descriptor.label}</h3><p><i style={{ background: tones[index] }} />{healthyCount} 健康</p></div></article>;
          })}</section>
          <section className="content-section glass-card"><div className="section-toolbar"><div><h2>工作负载</h2><span>{rows.length}</span></div></div><ResourceTable rows={rows} loading={query.isLoading} showKind onOpen={setOpenRow} /></section>
        </>
      )}
      {openRow && descriptor && <ResourceDrawer clusterId={clusterId} descriptor={descriptor} row={openRow} onClose={() => setOpenRow(undefined)} />}
    </div>
  );
}
