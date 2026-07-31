import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useData } from '../data-context';
import { navigationGroups } from '../navigation';
import { AddClusterModal } from './ClusterModals';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { YamlApplyModal } from './YamlApplyModal';
import { EmptyState, Modal } from './ui';

export function AppLayout() {
  const { clusters } = useData();
  const location = useLocation();
  const navigate = useNavigate();
  const routeClusterId = location.pathname.match(/^\/cluster\/([^/]+)/)?.[1];
  const [lastClusterId, setLastClusterId] = useState(() => localStorage.getItem('kust-selected-cluster') || undefined);
  const keepsClusterContext = location.pathname === '/notifications' || location.pathname === '/settings';
  const clusterId = routeClusterId || (keepsClusterContext ? lastClusterId : undefined);
  const cluster = clusters.find((item) => item.id === clusterId);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('kust-sidebar-collapsed') === 'true');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [addClusterOpen, setAddClusterOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!routeClusterId) return;
    setLastClusterId(routeClusterId);
    localStorage.setItem('kust-selected-cluster', routeClusterId);
  }, [routeClusterId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('kust-sidebar-collapsed', String(next));
  };

  const searchItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    const navItems = cluster ? navigationGroups.flatMap((group) => [
      { label: group.label, meta: '页面', path: `/cluster/${cluster.id}/${group.path || ''}`.replace(/\/$/, '') },
      ...(group.items || []).map((item) => ({ label: item.label, meta: item.singular, path: `/cluster/${cluster.id}/resources/${item.kind}` })),
    ]) : [];
    const clusterItems = clusters.map((item) => ({ label: item.name, meta: '集群', path: `/cluster/${item.id}` }));
    return [...clusterItems, ...navItems].filter((item) => !query || `${item.label} ${item.meta}`.toLowerCase().includes(query)).slice(0, 12);
  }, [cluster, clusters, search]);

  return (
    <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar
        cluster={cluster}
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onToggle={toggleSidebar}
        onCloseMobile={() => setMobileOpen(false)}
        onAddCluster={() => setAddClusterOpen(true)}
        onApply={() => setApplyOpen(true)}
      />
      <TopBar cluster={cluster} onMenu={() => setMobileOpen(true)} onSearch={() => setSearchOpen(true)} />
      <main className="app-main"><Outlet context={{ cluster }} /></main>
      <AddClusterModal open={addClusterOpen} onClose={() => setAddClusterOpen(false)} />
      {cluster && <YamlApplyModal cluster={cluster} open={applyOpen} onClose={() => setApplyOpen(false)} />}
      <Modal open={searchOpen} onClose={() => setSearchOpen(false)} title="全局搜索" width="620px">
        <div className="command-search"><Search size={18} /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="集群、资源或页面" /></div>
        <div className="command-results">
          {searchItems.map((item) => <button key={`${item.meta}:${item.label}:${item.path}`} onClick={() => { navigate(item.path); setSearchOpen(false); setSearch(''); }}><span>{item.label}</span><small>{item.meta}</small></button>)}
          {searchItems.length === 0 && <EmptyState icon={<Search size={22} />} title="没有匹配项" />}
        </div>
      </Modal>
    </div>
  );
}
