import { AtSign, Bell, Command, Fingerprint, IdCard, Laptop, LogOut, Mail, Menu, Moon, Search, Settings, ShieldCheck, Sun, UserRound } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useData } from '../data-context';
import { resourceDescriptors } from '../navigation';
import { useThemeMode } from '../theme-context';
import type { Cluster, ResourceRow, ThemeMode } from '../types';
import { IconButton, SelectMenu } from './ui';
import { useAuth } from '../auth-context';
import { useAnimatedPresence, useEscapeLayer } from '../hooks/useEscapeLayer';
import { useNamespaceSelection } from '../namespace-context';

const roleLabels: Record<string, string> = {
  admin: '管理员',
  operator: '运维人员',
  viewer: '只读用户',
};

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
  const { user, logout } = useAuth();
  const { getResources, clusters } = useData();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { getNamespace, setNamespace: rememberNamespace } = useNamespaceSelection();
  const [namespaces, setNamespaces] = useState<ResourceRow[]>([]);
  const [accountOpen, setAccountOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const accountMenuId = useId();
  const { mounted: accountMounted, closing: accountClosing } = useAnimatedPresence(accountOpen, 190);

  useEffect(() => {
    if (!cluster) return;
    getResources(cluster.id, 'namespaces').then((result) => setNamespaces(result.items)).catch(() => setNamespaces([]));
  }, [cluster, getResources]);

  useEffect(() => {
    if (!accountOpen) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutside);
    return () => document.removeEventListener('mousedown', closeOnOutside);
  }, [accountOpen]);

  useEffect(() => { setAccountOpen(false); }, [location.pathname]);

  const closeAccount = () => {
    setAccountOpen(false);
    accountButtonRef.current?.focus();
  };
  useEscapeLayer(accountOpen, closeAccount, 90);

  const openSettings = () => {
    setAccountOpen(false);
    navigate('/settings');
  };
  const signOut = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setAccountOpen(false);
    await logout();
    navigate('/login', { replace: true });
  };

  const namespaceParam = searchParams.get('namespace');
  const currentNamespace = cluster ? namespaceParam || getNamespace(cluster.id) : 'all';
  useEffect(() => {
    if (cluster && namespaceParam) rememberNamespace(cluster.id, namespaceParam);
  }, [cluster, namespaceParam, rememberNamespace]);

  const setNamespace = (namespace: string) => {
    if (!cluster) return;
    rememberNamespace(cluster.id, namespace);
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
            <div className="compact-select">
              <span>集群</span>
              <SelectMenu
                aria-label="集群"
                value={cluster.id}
                options={clusters.map((item) => ({ value: item.id, label: item.name }))}
                onChange={(next) => navigate(`/cluster/${next}`)}
              />
            </div>
            <div className="compact-select namespace-select">
              <span>命名空间</span>
              <SelectMenu
                aria-label="命名空间"
                value={currentNamespace}
                options={[{ value: 'all', label: '全部命名空间' }, ...namespaces.map((namespace) => ({ value: namespace.name, label: namespace.name }))]}
                onChange={setNamespace}
              />
            </div>
          </>
        )}
      </div>

      <div className="topbar__actions">
        <button className="search-trigger" aria-label="搜索资源" onClick={onSearch}>
          <Search size={16} /><span>搜索资源</span><kbd><Command size={11} />K</kbd>
        </button>
        <ThemeSelector />
        <IconButton label="通知" onClick={() => navigate('/notifications')}><Bell size={18} /><i className="notification-dot" /></IconButton>
        <div className="account-menu" ref={accountRef}>
          <button
            ref={accountButtonRef}
            className={`avatar ${accountOpen ? 'is-active' : ''}`}
            aria-label="当前用户"
            aria-haspopup="dialog"
            aria-expanded={accountOpen}
            aria-controls={accountOpen ? accountMenuId : undefined}
            title={user?.displayName || user?.username || '当前用户'}
            onClick={() => setAccountOpen((current) => !current)}
          >
            {(user?.displayName || user?.username || 'K').slice(0, 1).toUpperCase()}
          </button>
          {accountMounted && user && (
            <section id={accountMenuId} className={`account-card glass-panel ${accountClosing ? 'is-closing' : ''}`} role="dialog" aria-label="当前用户信息">
              <div className="account-card__header">
                <div className="account-card__avatar">{(user.displayName || user.username).slice(0, 1).toUpperCase()}</div>
                <div>
                  <strong>{user.displayName || user.realName || user.username}</strong>
                  <span><AtSign size={12} />{user.username}</span>
                </div>
              </div>
              <div className="account-card__roles">
                {user.roles.length > 0
                  ? user.roles.map((role) => <span key={role}><ShieldCheck size={12} />{roleLabels[role] || role}</span>)
                  : <span><ShieldCheck size={12} />未分配角色</span>}
              </div>
              <dl className="account-card__details">
                <div><dt><UserRound size={13} />姓名</dt><dd>{user.realName || user.displayName || '-'}</dd></div>
                <div><dt><IdCard size={13} />用户源</dt><dd>{user.source === 'oa' ? 'OA' : '本地账号'}</dd></div>
                {user.email && <div><dt><Mail size={13} />邮箱</dt><dd title={user.email}>{user.email}</dd></div>}
                {user.itcode && <div><dt><Fingerprint size={13} />ITCode</dt><dd>{user.itcode}</dd></div>}
                <div><dt><Fingerprint size={13} />双重认证</dt><dd>{user.twoFactorEnabled ? '已启用' : '未启用'}</dd></div>
              </dl>
              <div className="account-card__actions">
                <button type="button" onClick={openSettings}><Settings size={15} /><span>个人设置</span></button>
                <button type="button" className="is-danger" disabled={loggingOut} onClick={() => void signOut()}><LogOut size={15} /><span>{loggingOut ? '正在退出' : '退出登录'}</span></button>
              </div>
            </section>
          )}
        </div>
      </div>
    </header>
  );
}
