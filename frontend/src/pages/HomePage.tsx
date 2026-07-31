import { Boxes, CirclePlus, FolderKanban, MoreHorizontal, RefreshCw, Server, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../data-context';
import type { Cluster } from '../types';
import { AddClusterModal } from '../components/ClusterModals';
import { Button, EmptyState, IconButton, Modal, Spinner, StatusPill, useToast } from '../components/ui';

export function HomePage() {
  const { clusters, loadingClusters, clusterError, refreshClusters, deleteCluster } = useData();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [tab, setTab] = useState<'clusters' | 'projects'>('clusters');
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Cluster>();
  const [deleting, setDeleting] = useState(false);
  const recent = clusters.filter((cluster) => cluster.status === 'connected').slice(0, 3);

  const removeCluster = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteCluster(deleteTarget.id);
      pushToast(`集群 ${deleteTarget.name} 已移除`);
      setDeleteTarget(undefined);
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '移除集群失败', 'error');
    } finally { setDeleting(false); }
  };

  return (
    <div className="page home-page">
      <header className="page-header">
        <div><span className="eyebrow">Kubernetes 控制台</span><h2>首页</h2></div>
        <div className="page-actions"><IconButton label="刷新集群" onClick={() => void refreshClusters()}><RefreshCw size={18} /></IconButton><Button variant="primary" aria-label="添加集群" icon={<CirclePlus size={17} />} onClick={() => setAddOpen(true)}>添加集群</Button></div>
      </header>
      <div className="view-tabs" role="tablist">
        <button className={tab === 'clusters' ? 'is-active' : ''} onClick={() => setTab('clusters')}><Boxes size={17} />全部集群</button>
        <button className={tab === 'projects' ? 'is-active' : ''} onClick={() => setTab('projects')}><FolderKanban size={17} />项目</button>
      </div>

      {loadingClusters ? <Spinner label="正在加载集群" /> : clusterError ? (
        <EmptyState icon={<Server size={24} />} title="后端不可用" body={clusterError} action={<Button onClick={() => void refreshClusters()}>重试</Button>} />
      ) : tab === 'clusters' ? (
        <>
          {recent.length > 0 && <section className="home-section"><div className="section-heading"><div><span>最近使用</span><strong>{recent.length}</strong></div></div><div className="recent-clusters">{recent.map((cluster) => (
            <button className="recent-cluster glass-card" key={cluster.id} onClick={() => navigate(`/cluster/${cluster.id}`)}>
              <span className="cluster-glyph cluster-glyph--large" style={{ '--cluster-accent': cluster.accent || '#397b72' } as React.CSSProperties}>{cluster.name.slice(0, 1).toUpperCase()}</span>
              <span className="recent-cluster__text"><strong>{cluster.name}</strong><small>{cluster.kubernetesVersion || '版本未知'}</small></span>
              <StatusPill status={cluster.status === 'connected' ? '已连接' : '离线'} />
            </button>
          ))}<button className="recent-cluster recent-cluster--add" onClick={() => setAddOpen(true)}><CirclePlus size={25} /><span>添加集群</span></button></div></section>}

          <section className="home-section cluster-list-section">
            <div className="section-heading"><div><span>全部集群</span><strong>{clusters.length}</strong></div></div>
            {clusters.length === 0 ? <EmptyState icon={<Server size={24} />} title="还没有集群" action={<Button variant="primary" onClick={() => setAddOpen(true)}>添加集群</Button>} /> : (
              <div className="cluster-table-wrap"><table className="cluster-table"><thead><tr><th>名称</th><th>状态</th><th>警告</th><th>Kubernetes 版本</th><th>API Server</th><th aria-label="操作" /></tr></thead><tbody>{clusters.map((cluster) => (
                <tr key={cluster.id} onClick={() => navigate(`/cluster/${cluster.id}`)}>
                  <td><div className="cluster-cell"><span className="cluster-glyph" style={{ '--cluster-accent': cluster.accent || '#397b72' } as React.CSSProperties}>{cluster.name.slice(0, 1).toUpperCase()}</span><div><button>{cluster.name}</button><small>{cluster.description}</small></div></div></td>
                  <td><StatusPill status={cluster.status === 'connected' ? '已连接' : cluster.status === 'disconnected' ? '离线' : '未知'} /></td>
                  <td><span className={cluster.warnings ? 'warning-count' : 'muted-cell'}>{cluster.warnings ?? '-'}</span></td>
                  <td className="mono-cell">{cluster.kubernetesVersion || '-'}</td>
                  <td className="mono-cell server-cell">{cluster.server}</td>
                  <td onClick={(event) => event.stopPropagation()}><IconButton label={`移除 ${cluster.name}`} onClick={() => setDeleteTarget(cluster)}><MoreHorizontal size={18} /></IconButton></td>
                </tr>
              ))}</tbody></table></div>
            )}
          </section>
        </>
      ) : <ProjectsView clusters={clusters} onOpen={(cluster) => navigate(`/cluster/${cluster.id}`)} />}
      <AddClusterModal open={addOpen} onClose={() => setAddOpen(false)} />
      <Modal open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(undefined)} title={`移除 ${deleteTarget?.name || ''}`} width="440px" footer={<><Button variant="ghost" onClick={() => setDeleteTarget(undefined)}>取消</Button><Button variant="danger" icon={<Trash2 size={16} />} onClick={removeCluster} disabled={deleting}>{deleting ? '移除中' : '确认移除'}</Button></>}>
        <p className="confirm-copy">该操作只会从 Kust 中移除集群配置，不会删除 Kubernetes 集群。</p>
      </Modal>
    </div>
  );
}

function ProjectsView({ clusters, onOpen }: { clusters: Cluster[]; onOpen: (cluster: Cluster) => void }) {
  const projects = [
    { name: 'Commerce Production', env: '生产', members: clusters.slice(0, 1), color: '#2e7d69' },
    { name: 'Delivery Pipeline', env: '交付', members: clusters.slice(1, 2), color: '#3578c4' },
    { name: 'Edge Research', env: '实验', members: clusters.slice(2, 3), color: '#b46a42' },
  ].filter((project) => project.members.length);
  if (!projects.length) return <EmptyState icon={<FolderKanban size={24} />} title="没有项目" />;
  return <div className="project-grid">{projects.map((project) => <section className="project-card glass-card" key={project.name}><div className="project-card__mark" style={{ background: project.color }}><FolderKanban size={20} /></div><div className="project-card__head"><div><small>{project.env}</small><h3>{project.name}</h3></div><span>{project.members.length} 个集群</span></div><div className="project-card__clusters">{project.members.map((cluster) => <button key={cluster.id} onClick={() => onOpen(cluster)}><span className="cluster-glyph" style={{ '--cluster-accent': cluster.accent || project.color } as React.CSSProperties}>{cluster.name.slice(0, 1).toUpperCase()}</span><span>{cluster.name}</span><StatusPill status={cluster.status === 'connected' ? '已连接' : '离线'} /></button>)}</div></section>)}</div>;
}
