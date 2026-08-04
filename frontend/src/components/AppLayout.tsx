import { LoaderCircle, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useData } from '../data-context';
import { navigationGroups } from '../navigation';
import { AddClusterModal } from './ClusterModals';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { YamlApplyModal } from './YamlApplyModal';
import { EmptyState, Modal } from './ui';
import { api } from '../api';
import type { SearchResult } from '../types';
import { useAuth } from '../auth-context';
import { WorkspaceWindowsProvider, useWorkspaceWindows } from '../workspace-windows-context';
import { WorkspaceDesktop } from './WorkspaceDesktop';

export function AppLayout() {
  return <WorkspaceWindowsProvider><AppLayoutContent /></WorkspaceWindowsProvider>;
}

function AppLayoutContent() {
  const { user } = useAuth();
  const { windows } = useWorkspaceWindows();
  const isAdmin = Boolean(user?.roles.includes('admin'));
  const canManageClusters = isAdmin;
  const canWriteResources = Boolean(user?.roles.some((role) => role === 'admin' || role === 'operator'));
  const { clusters } = useData();
  const location = useLocation();
  const navigate = useNavigate();
  const routeClusterId = location.pathname.match(/^\/cluster\/([^/]+)/)?.[1];
  const [lastClusterId, setLastClusterId] = useState(() => localStorage.getItem('kust-selected-cluster') || undefined);
  const keepsClusterContext = location.pathname === '/notifications' || location.pathname === '/settings' || location.pathname === '/system-settings';
  const clusterId = routeClusterId || (keepsClusterContext ? lastClusterId : undefined);
  const cluster = clusters.find((item) => item.id === clusterId);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('kust-sidebar-collapsed') === 'true');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [addClusterOpen, setAddClusterOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [resourceResults, setResourceResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!routeClusterId) return;
    setLastClusterId(routeClusterId);
    localStorage.setItem('kust-selected-cluster', routeClusterId);
  }, [routeClusterId]);

  useEffect(() => {
    document.querySelector<HTMLElement>('.app-main')?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [location.pathname]);

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

  useEffect(() => {
    const query = search.trim();
    if (query.length < 2) { setResourceResults([]); setSearching(false); return; }
    setSearching(true);
    const timer = window.setTimeout(() => {
      api.search(query).then(setResourceResults).catch(() => setResourceResults([])).finally(() => setSearching(false));
    }, 220);
    return () => window.clearTimeout(timer);
  }, [search]);

  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('kust-sidebar-collapsed', String(next));
  };

  const navigationItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    const navItems = cluster ? navigationGroups.flatMap((group) => [
      { label: group.label, meta: '页面', path: `/cluster/${cluster.id}/${group.path || ''}`.replace(/\/$/, '') },
      ...(group.items || []).map((item) => ({ label: item.label, meta: item.singular, path: `/cluster/${cluster.id}/resources/${item.kind}` })),
    ]) : [];
    const clusterItems = clusters.map((item) => ({ label: item.name, meta: '集群', path: `/cluster/${item.id}` }));
    return [...clusterItems, ...navItems].filter((item) => !query || `${item.label} ${item.meta}`.toLowerCase().includes(query)).slice(0, query ? 5 : 12);
  }, [cluster, clusters, search]);
  const searchItems: Array<{ label: string; meta: string; path: string; status?: string }> = search.trim().length >= 2
    ? [...resourceResults.map((item) => ({ label: item.title, meta: item.subtitle, path: item.path, status: item.status })), ...navigationItems]
    : navigationItems;

  return (
    <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''} ${windows.length ? 'has-workspace-windows' : ''}`}>
      <Sidebar
        cluster={cluster}
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onToggle={toggleSidebar}
        onCloseMobile={() => setMobileOpen(false)}
        onAddCluster={() => setAddClusterOpen(true)}
        onApply={() => setApplyOpen(true)}
        canManageClusters={canManageClusters}
        canWriteResources={canWriteResources}
        isAdmin={isAdmin}
      />
      <TopBar cluster={cluster} onMenu={() => setMobileOpen(true)} onSearch={() => setSearchOpen(true)} />
      <main className="app-main"><Outlet context={{ cluster }} /></main>
      <WorkspaceDesktop />
      <AddClusterModal open={canManageClusters && addClusterOpen} onClose={() => setAddClusterOpen(false)} />
      {cluster && canWriteResources && <YamlApplyModal cluster={cluster} open={applyOpen} onClose={() => setApplyOpen(false)} />}
      <Modal open={searchOpen} onClose={() => setSearchOpen(false)} title="全局搜索" width="620px">
        <div className="command-search"><Search size={18} /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="集群、资源或页面" /></div>
        <div className="command-results">
          {searching && <div className="command-searching"><LoaderCircle className="spin" size={17} />正在搜索 MongoDB 资源索引</div>}
          {searchItems.map((item) => <button key={`${item.meta}:${item.label}:${item.path}`} onClick={() => { navigate(item.path); setSearchOpen(false); setSearch(''); }}><span>{item.label}{item.status && <i>{item.status}</i>}</span><small>{item.meta}</small></button>)}
          {!searching && searchItems.length === 0 && <EmptyState icon={<Search size={22} />} title="没有匹配项" />}
        </div>
      </Modal>
    </div>
  );
}
