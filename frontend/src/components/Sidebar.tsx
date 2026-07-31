import {
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  Home,
  Settings,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useEscapeLayer } from '../hooks/useEscapeLayer';
import { navigationGroups } from '../navigation';
import type { Cluster } from '../types';
import { Button, IconButton } from './ui';

interface SidebarProps {
  cluster?: Cluster;
  collapsed: boolean;
  mobileOpen: boolean;
  onToggle: () => void;
  onCloseMobile: () => void;
  onAddCluster: () => void;
  onApply: () => void;
}

export function Sidebar({
  cluster,
  collapsed,
  mobileOpen,
  onToggle,
  onCloseMobile,
  onAddCluster,
  onApply,
}: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const activeGroup = navigationGroups.find((group) =>
    group.items?.some((item) => location.pathname.includes(`/resources/${item.kind}`)) ||
    (group.path && location.pathname.endsWith(`/${group.path}`)),
  )?.id;
  const [expanded, setExpanded] = useState<string[]>(() => activeGroup ? [activeGroup] : ['cluster', 'workloads']);
  const [wideLayout, setWideLayout] = useState(() => window.matchMedia('(min-width: 761px)').matches);
  const expandedView = !collapsed || mobileOpen;

  useEffect(() => {
    if (activeGroup) setExpanded((current) => current.includes(activeGroup) ? current : [...current, activeGroup]);
  }, [activeGroup]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 761px)');
    const updateLayout = () => setWideLayout(media.matches);
    media.addEventListener('change', updateLayout);
    return () => media.removeEventListener('change', updateLayout);
  }, []);

  useEscapeLayer(mobileOpen, onCloseMobile, 80);
  useEscapeLayer(
    expanded.length > 0 && ((wideLayout && !collapsed) || mobileOpen),
    () => setExpanded((current) => current.slice(0, -1)),
    10,
  );

  const clusterBase = cluster ? `/cluster/${cluster.id}` : '';
  const closeOnMobile = () => {
    if (window.innerWidth < 720) onCloseMobile();
  };

  return (
    <>
      <button className={`sidebar-scrim ${mobileOpen ? 'is-open' : ''}`} aria-label="关闭导航" onClick={onCloseMobile} tabIndex={mobileOpen ? 0 : -1} />
      <aside className={`sidebar glass-panel ${collapsed ? 'is-collapsed' : ''} ${mobileOpen ? 'is-mobile-open' : ''}`}>
        <div className="sidebar__brand">
          <button className="brand-mark" aria-label="Kust 首页" onClick={() => navigate('/')}>
            <span className="brand-mark__hex"><i /><i /><i /></span>
          </button>
          {expandedView && <button className="brand-word" onClick={() => navigate('/')}>Kust</button>}
        </div>

        <nav className="sidebar__nav" aria-label="主导航">
          <NavLink to="/" end className="nav-item" onClick={closeOnMobile} title={!expandedView ? '首页' : undefined}>
            <Home size={19} /><span>首页</span>
          </NavLink>

          {cluster && (
            <>
              <div className="nav-divider" />
              {navigationGroups.map((group) => {
                const Icon = group.icon;
                const isExpanded = expanded.includes(group.id);
                const toggleGroup = () => setExpanded((current) => isExpanded ? current.filter((id) => id !== group.id) : [...current, group.id]);
                const groupPath = `${clusterBase}/${group.path || ''}`.replace(/\/$/, '');
                const firstResourcePath = group.items?.[0] ? `${clusterBase}/resources/${group.items[0].kind}` : groupPath;
                const isGroupPage = group.path !== undefined && location.pathname === groupPath;
                const isCurrent = isGroupPage || (!expandedView && activeGroup === group.id);
                return (
                  <div className={`nav-group ${isCurrent ? 'is-active' : ''}`} key={group.id}>
                    <div className="nav-group__head">
                      {group.path !== undefined ? (
                        <NavLink
                          to={groupPath}
                          end
                          className={() => `nav-item ${isCurrent ? 'active' : ''}`}
                          onClick={closeOnMobile}
                          title={!expandedView ? group.label : undefined}
                        >
                          <Icon size={19} /><span>{group.label}</span>
                        </NavLink>
                      ) : (
                        <button
                          type="button"
                          className={`nav-item ${isCurrent ? 'active' : ''}`}
                          onClick={() => collapsed && window.innerWidth > 760 ? navigate(firstResourcePath) : toggleGroup()}
                          title={!expandedView ? group.label : undefined}
                        >
                          <Icon size={19} /><span>{group.label}</span>
                        </button>
                      )}
                      {expandedView && group.items && (
                        <button
                          type="button"
                          className="nav-group-toggle"
                          aria-label={isExpanded ? `收起${group.label}` : `展开${group.label}`}
                          title={isExpanded ? `收起${group.label}` : `展开${group.label}`}
                          onClick={toggleGroup}
                          aria-expanded={isExpanded}
                        >
                          <ChevronDown size={15} className={isExpanded ? 'chevron-open' : ''} />
                        </button>
                      )}
                    </div>
                    {group.items && (
                      <div className={`nav-sublist-shell ${expandedView && isExpanded ? 'is-open' : ''}`} aria-hidden={!expandedView || !isExpanded}>
                        <div className="nav-sublist-clip">
                          <div className="nav-sublist">
                            {group.items.map((item) => (
                              <NavLink
                                key={item.kind}
                                to={`${clusterBase}/resources/${item.kind}`}
                                className={({ isActive }) => `nav-subitem ${isActive ? 'active' : ''}`}
                                onClick={closeOnMobile}
                                tabIndex={expandedView && isExpanded ? undefined : -1}
                              >
                                <span>{item.label}</span><ChevronRight size={13} />
                              </NavLink>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </nav>

        <div className="sidebar__footer">
          {cluster ? (
            !expandedView ? (
              <IconButton label="创建资源" onClick={onApply}><CirclePlus size={20} /></IconButton>
            ) : (
              <Button variant="primary" icon={<CirclePlus size={17} />} onClick={onApply}>创建资源</Button>
            )
          ) : (
            !expandedView ? (
              <IconButton label="添加集群" onClick={onAddCluster}><CirclePlus size={20} /></IconButton>
            ) : (
              <Button variant="primary" icon={<CirclePlus size={17} />} onClick={onAddCluster}>添加集群</Button>
            )
          )}
          <NavLink to="/notifications" className="nav-item" onClick={closeOnMobile} title={!expandedView ? '通知' : undefined}>
            <Bell size={18} /><span>通知</span>
          </NavLink>
          <NavLink to="/settings" className="nav-item" onClick={closeOnMobile} title={!expandedView ? '设置' : undefined}>
            <Settings size={18} /><span>设置</span>
          </NavLink>
          <button
            className="sidebar-toggle"
            onClick={onToggle}
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            aria-expanded={!collapsed}
            title={collapsed ? '展开侧栏' : '收起侧栏'}
          >
            {collapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
            {expandedView && <span>收起侧栏</span>}
          </button>
        </div>
      </aside>
    </>
  );
}
