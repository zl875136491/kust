import { Bell, Command, Laptop, Menu, Moon, Search, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useData } from '../data-context';
import { resourceDescriptors } from '../navigation';
import { useThemeMode } from '../theme-context';
import type { Cluster, ResourceRow, ThemeMode } from '../types';
import { IconButton } from './ui';

function getPageTitle(pathname: string, cluster?: Cluster) {
  if (pathname === '/') return '首页';
  if (pathname === '/notifications') return '通知';
  if (pathname === '/settings') return '设置';
  const resourceKind = pathname.match(/\/resources\/([^/]+)/)?.[1];
  if (resourceKind) return resourceDescriptors[resourceKind]?.label || resourceKind;
  if (pathname.endsWith('/shell')) return 'WebShell';
  if (pathname.endsWith('/files')) return 'WebFile';
  if (pathname.endsWith('/map')) return '资源地图';
  if (pathname.endsWith('/workloads')) return '工作负载';
  if (cluster) return '概览';
  return 'Kust';
}

function ThemeSelector() {
  const { mode, setMode } = useThemeMode();
  const options: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { value: 'system', label: '跟随系统', icon: <Laptop size={15} /> },
    { value: 'light', label: '浅色模式', icon: <Sun size={15} /> },
    { value: 'dark', label: '深色模式', icon: <Moon size={15} /> },
  ];
  return <div className="segmented" aria-label="主题模式">{options.map((option) => <IconButton key={option.value} label={option.label} active={mode === option.value} onClick={() => setMode(option.value)}>{option.icon}</IconButton>)}</div>;
}

export function TopBar({ cluster, onMenu, onSearch }: { cluster?: Cluster; onMenu: () => void; onSearch: () => void }) {
  const { mode, getResources, clusters } = useData();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [namespaces, setNamespaces] = useState<ResourceRow[]>([]);

  useEffect(() => {
    if (!cluster) return;
    getResources(cluster.id, 'namespaces').then((result) => setNamespaces(result.items)).catch(() => setNamespaces([]));
  }, [cluster, getResources]);

  const currentNamespace = searchParams.get('namespace') || 'all';
  const setNamespace = (namespace: string) => {
    const next = new URLSearchParams(searchParams);
    if (namespace === 'all') next.delete('namespace'); else next.set('namespace', namespace);
    setSearchParams(next, { replace: true });
  };

  return (
    <header className="topbar glass-panel">
      <div className="topbar__leading">
        <IconButton label="打开导航" className="mobile-menu" onClick={onMenu}><Menu size={20} /></IconButton>
        <div className="page-title">
          {cluster && <span>{cluster.name}</span>}
          <h1>{getPageTitle(location.pathname, cluster)}</h1>
        </div>
      </div>

      <div className="topbar__context">
        {cluster && (
          <>
            <label className="compact-select">
              <span>集群</span>
              <select value={cluster.id} onChange={(event) => navigate(`/cluster/${event.target.value}`)}>
                {clusters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label className="compact-select namespace-select">
              <span>命名空间</span>
              <select value={currentNamespace} onChange={(event) => setNamespace(event.target.value)}>
                <option value="all">全部命名空间</option>
                {namespaces.map((namespace) => <option key={namespace.uid} value={namespace.name}>{namespace.name}</option>)}
              </select>
            </label>
          </>
        )}
      </div>

      <div className="topbar__actions">
        <button className="search-trigger" aria-label="搜索资源" onClick={onSearch}>
          <Search size={16} /><span>搜索资源</span><kbd><Command size={11} />K</kbd>
        </button>
        <span className={`mode-badge mode-badge--${mode}`}>{mode === 'demo' ? '演示' : '实时'}</span>
        <ThemeSelector />
        <IconButton label="通知" onClick={() => navigate('/notifications')}><Bell size={18} /><i className="notification-dot" /></IconButton>
        <div className="avatar" title="本地管理员">K</div>
      </div>
    </header>
  );
}
