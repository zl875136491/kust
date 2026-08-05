import {
  Activity,
  Check,
  Clock,
  ChevronRight,
  Database,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  UserCheck,
  UserCog,
  UserX,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth-context';
import { copyText } from '../browser-compat';
import { Button, EmptyState, Modal, SelectMenu, useToast } from '../components/ui';
import { useData } from '../data-context';
import type { PlatformSettings, PlatformSettingsUpdate, Role, User } from '../types';

type SystemView = 'general' | 'users' | 'roles';

interface ResetCode {
  username: string;
  code: string;
  expiresInMinutes: number;
}

const permissionLabels: Record<string, string> = {
  'clusters:*': '集群全部权限',
  'clusters:read': '查看集群',
  'resources:*': '资源全部权限',
  'resources:read': '查看资源',
  'resources:write': '修改资源',
  'users:*': '用户与角色管理',
  'settings:*': '系统设置管理',
  'settings:write': '保存个人设置',
};

function updatePayload(settings: PlatformSettings): PlatformSettingsUpdate {
  return {
    registrationEnabled: settings.registrationEnabled,
    oaLoginEnabled: settings.oaLoginEnabled,
    defaultRole: settings.defaultRole,
    cacheTtlSeconds: settings.cacheTtlSeconds,
    cacheSyncSeconds: settings.cacheSyncSeconds,
    sessionTimeoutHours: settings.sessionTimeoutHours,
  };
}

export function SystemSettingsPage() {
  const { user: currentUser } = useAuth();
  const { clusters } = useData();
  const { pushToast } = useToast();
  const [view, setView] = useState<SystemView>('general');
  const [settings, setSettings] = useState<PlatformSettings>();
  const [draft, setDraft] = useState<PlatformSettings>();
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [databaseConnected, setDatabaseConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [busyUsers, setBusyUsers] = useState<Set<string>>(() => new Set());
  const [statusTarget, setStatusTarget] = useState<User>();
  const [resetTarget, setResetTarget] = useState<User>();
  const [resetCode, setResetCode] = useState<ResetCode>();
  const [resetting, setResetting] = useState(false);

  const views: { value: SystemView; label: string; description: string; icon: React.ReactNode }[] = [
    { value: 'general', label: '平台', description: '访问、缓存与运行状态', icon: <Server size={18} /> },
    { value: 'users', label: '用户', description: '账号状态与安全管理', icon: <Users size={18} /> },
    { value: 'roles', label: '角色', description: '权限与成员概览', icon: <ShieldCheck size={18} /> },
  ];

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [platform, userList, roleList, health] = await Promise.all([
        api.platformSettings(),
        api.users(),
        api.roles(),
        api.health(),
      ]);
      setSettings(platform);
      setDraft(platform);
      setUsers(userList);
      setRoles(roleList);
      setDatabaseConnected(health.database === 'connected');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '系统设置加载失败';
      setLoadError(message);
      pushToast(message, 'error');
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => { void load(); }, [load]);

  const dirty = Boolean(settings && draft && JSON.stringify(updatePayload(settings)) !== JSON.stringify(updatePayload(draft)));
  const roleOptions = roles.map((role) => ({ value: role.name, label: role.label }));
  const defaultRoleOptions = roleOptions.filter((role) => role.value !== 'admin');
  const visibleUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return users;
    return users.filter((item) => [
      item.displayName,
      item.realName,
      item.username,
      item.email || '',
      item.source,
      ...item.roles,
    ].some((value) => value.toLowerCase().includes(query)));
  }, [search, users]);

  const activeUsers = users.filter((item) => !item.disabled).length;
  const presetClusters = clusters.filter((cluster) => cluster.preset).length;
  const roleMemberCount = (role: string) => users.filter((item) => item.roles.includes(role)).length;
  const setUserBusy = (id: string, busy: boolean) => setBusyUsers((current) => {
    const next = new Set(current);
    if (busy) next.add(id); else next.delete(id);
    return next;
  });

  const saveSettings = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const updated = await api.updatePlatformSettings(updatePayload(draft));
      setSettings(updated);
      setDraft(updated);
      pushToast('系统设置已保存');
    } catch (reason) {
      pushToast(reason instanceof Error ? reason.message : '系统设置保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const changeRole = async (target: User, role: string) => {
    if (target.roles.length === 1 && target.roles[0] === role) return;
    setUserBusy(target.id, true);
    try {
      const updated = await api.updateRoles(target.id, [role]);
      setUsers((current) => current.map((item) => item.id === updated.id ? updated : item));
      pushToast(`${target.displayName} 的角色已更新`);
    } catch (reason) {
      pushToast(reason instanceof Error ? reason.message : '角色更新失败', 'error');
    } finally {
      setUserBusy(target.id, false);
    }
  };

  const updateStatus = async () => {
    if (!statusTarget) return;
    setUserBusy(statusTarget.id, true);
    try {
      const updated = await api.updateUserStatus(statusTarget.id, !statusTarget.disabled);
      setUsers((current) => current.map((item) => item.id === updated.id ? updated : item));
      pushToast(updated.disabled ? '账号已停用' : '账号已启用');
      setStatusTarget(undefined);
    } catch (reason) {
      pushToast(reason instanceof Error ? reason.message : '账号状态更新失败', 'error');
    } finally {
      setUserBusy(statusTarget.id, false);
    }
  };

  const generateResetCode = async () => {
    if (!resetTarget) return;
    setResetting(true);
    try {
      setResetCode(await api.adminResetCode(resetTarget.id));
    } catch (reason) {
      pushToast(reason instanceof Error ? reason.message : '无法生成重置码', 'error');
    } finally {
      setResetting(false);
    }
  };

  const copyResetCode = async () => {
    if (!resetCode) return;
    try {
      await copyText(resetCode.code);
      pushToast('重置码已复制');
    } catch {
      pushToast('浏览器未允许复制，请手动选中重置码', 'error');
    }
  };

  const closeReset = () => {
    setResetTarget(undefined);
    setResetCode(undefined);
  };

  if (loading && !settings) {
    return <div className="page system-settings-page"><div className="auth-loading"><LoaderCircle className="spin" size={22} /><span>加载系统设置</span></div></div>;
  }
  if (!settings || !draft) {
    return <div className="page system-settings-page"><EmptyState icon={<Server size={23} />} title="无法加载系统设置" body={loadError} action={<Button icon={<RefreshCw size={16} />} onClick={() => void load()}>重试</Button>} /></div>;
  }

  return (
    <div className="page system-settings-page">
      <header className="page-header">
        <div><span className="eyebrow">administration</span><h2>系统设置</h2></div>
        <div className="page-actions">
          <Button variant="ghost" icon={<RefreshCw size={16} />} onClick={() => void load()} disabled={loading}>刷新</Button>
          {view === 'general' && <Button variant="primary" icon={<Check size={17} />} onClick={() => void saveSettings()} disabled={!dirty || saving}>{saving ? '保存中' : '保存设置'}</Button>}
        </div>
      </header>

      <div className="settings-workspace system-settings-workspace">
        <nav className="settings-sidebar glass-card" aria-label="系统设置分类">
          {views.map((item) => <button
            key={item.value}
            id={`system-settings-nav-${item.value}`}
            className={view === item.value ? 'is-active' : ''}
            aria-current={view === item.value ? 'page' : undefined}
            aria-controls={`system-settings-panel-${item.value}`}
            onClick={() => setView(item.value)}
          >
            {item.icon}
            <span className="settings-sidebar__copy"><strong>{item.label}</strong><small>{item.description}</small></span>
            <ChevronRight size={15} />
          </button>)}
        </nav>

        <div className="settings-content">
          {view === 'general' && (
            <div id="system-settings-panel-general" aria-labelledby="system-settings-nav-general" className="settings-panel system-settings-stack">
              <section className="settings-section glass-card system-overview-section">
                <header><Activity size={19} /><div><h3>系统概览</h3><p>平台运行状态与资源统计</p></div></header>
                <div className="system-overview-list" aria-label="系统概览">
                  <div className="system-overview-row"><span className="system-overview-icon"><Users size={16} /></span><div><strong>活跃用户</strong><small>当前可正常登录的账号</small></div><b>{activeUsers} <small>/ {users.length}</small></b></div>
                  <div className="system-overview-row"><span className="system-overview-icon"><ShieldCheck size={16} /></span><div><strong>系统角色</strong><small>已配置的角色与权限集合</small></div><b>{roles.length}</b></div>
                  <div className="system-overview-row"><span className="system-overview-icon"><Server size={16} /></span><div><strong>集群</strong><small>包含 {presetClusters} 个只读预设配置</small></div><b>{clusters.length}</b></div>
                  <div className="system-overview-row"><span className="system-overview-icon"><Database size={16} /></span><div><strong>MongoDB</strong><small>平台数据缓存与用户设置存储</small></div><b className={databaseConnected ? 'is-success' : 'is-danger'}>{databaseConnected ? '正常' : '异常'}</b></div>
                </div>
              </section>

              <section className="settings-section glass-card">
                <header><UserCog size={19} /><div><h3>访问与身份</h3><p>注册、登录和默认账号策略</p></div></header>
            <div className="setting-row"><div><strong>开放用户注册</strong><span>允许通过已配置用户源创建账号</span></div><label className="switch-control"><input aria-label="开放用户注册" type="checkbox" checked={draft.registrationEnabled} onChange={(event) => setDraft({ ...draft, registrationEnabled: event.target.checked })} /><i /></label></div>
            <div className="setting-row"><div><strong>OA 快捷登录</strong><span>{draft.oaUserSourceConfigured ? '通过 OA 消息完成无密码登录' : 'OA 用户源未配置'}</span></div><label className="switch-control"><input aria-label="OA 快捷登录" type="checkbox" checked={draft.oaLoginEnabled} disabled={!draft.oaUserSourceConfigured} onChange={(event) => setDraft({ ...draft, oaLoginEnabled: event.target.checked })} /><i /></label></div>
            <div className="setting-row"><div><strong>新用户默认角色</strong><span>管理员角色不能作为注册默认值</span></div><div className="system-setting-select"><SelectMenu aria-label="新用户默认角色" value={draft.defaultRole} options={defaultRoleOptions} onChange={(defaultRole) => setDraft({ ...draft, defaultRole })} /></div></div>
            <div className="setting-row"><div><strong>登录会话有效期</strong><span>新会话 1-72 小时</span></div><div className="number-with-unit"><input className="number-input" aria-label="登录会话有效期" type="number" min={1} max={72} value={draft.sessionTimeoutHours} onChange={(event) => setDraft({ ...draft, sessionTimeoutHours: Number(event.target.value) })} /><span>小时</span></div></div>
              </section>

              <section className="settings-section glass-card">
                <header><Database size={19} /><div><h3>缓存与同步</h3><p>控制资源缓存和后台同步策略</p></div></header>
            <div className="setting-row"><div><strong>资源缓存有效期</strong><span>过期后在后台刷新，范围 15-600 秒</span></div><div className="number-with-unit"><input className="number-input" aria-label="资源缓存有效期" type="number" min={15} max={600} value={draft.cacheTtlSeconds} onChange={(event) => setDraft({ ...draft, cacheTtlSeconds: Number(event.target.value) })} /><span>秒</span></div></div>
            <div className="setting-row"><div><strong>全量同步周期</strong><span>后台同步所有集群资源，范围 15-3600 秒</span></div><div className="number-with-unit"><input className="number-input" aria-label="全量同步周期" type="number" min={15} max={3600} value={draft.cacheSyncSeconds} onChange={(event) => setDraft({ ...draft, cacheSyncSeconds: Number(event.target.value) })} /><span>秒</span></div></div>
            <div className="system-runtime-list">
              <div><Database size={15} /><span>MongoDB</span><strong className={databaseConnected ? 'is-success' : 'is-danger'}>{databaseConnected ? '已连接' : '连接异常'}</strong></div>
              <div><UserCheck size={15} /><span>OA 用户源</span><strong className={draft.oaUserSourceConfigured ? 'is-success' : ''}>{draft.oaUserSourceConfigured ? '已配置' : '未配置'}</strong></div>
              <div><Server size={15} /><span>预设集群配置</span><strong>{draft.presetClustersReadOnly ? '只读保护' : '可修改'}</strong></div>
              <div><Clock size={15} /><span>最近更新</span><strong>{new Date(draft.updatedAt).toLocaleString()}</strong></div>
            </div>
              </section>
            </div>
          )}

          {view === 'users' && (
            <section id="system-settings-panel-users" aria-labelledby="system-settings-nav-users" className="admin-list settings-panel glass-card">
          <header className="admin-list__toolbar">
            <div><Users size={18} /><strong>用户管理</strong><span>{visibleUsers.length} / {users.length}</span></div>
            <label className="input-wrap admin-user-search"><Search size={15} /><input aria-label="搜索用户" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索姓名、账号或角色" /></label>
          </header>
          <div className="admin-user-list">
            {visibleUsers.map((item) => {
              const busy = busyUsers.has(item.id);
              const self = item.id === currentUser?.id;
              const options = roleOptions.map((option) => ({ ...option, disabled: self && item.roles.includes('admin') && option.value !== 'admin' }));
              return (
                <div className={`admin-user-row ${item.disabled ? 'is-disabled' : ''}`} key={item.id}>
                  <div className="admin-user-identity"><div className="avatar avatar--small">{item.displayName.slice(0, 1).toUpperCase()}</div><div><strong>{item.displayName}</strong><span>{item.username}{item.email ? ` · ${item.email}` : ''}</span></div></div>
                  <div className="admin-user-meta"><span className="meta-badge">{item.source === 'oa' ? 'OA' : '本地'}</span><span className={`meta-badge ${item.disabled ? 'is-danger' : 'is-success'}`}>{item.disabled ? '已停用' : '正常'}</span></div>
                  <div className="admin-user-security"><ShieldCheck size={14} /><span>{item.twoFactorEnabled ? '已启用 2FA' : item.roles.includes('admin') ? '待绑定 2FA' : '未启用 2FA'}</span></div>
                  <SelectMenu aria-label={`${item.username} 角色`} value={item.roles[0] || 'viewer'} options={options} onChange={(role) => void changeRole(item, role)} disabled={busy} />
                  <div className="admin-user-actions">
                    {item.source === 'local' && <Button variant="ghost" icon={<KeyRound size={15} />} onClick={() => { setResetTarget(item); setResetCode(undefined); }} disabled={busy}>重置</Button>}
                    <Button variant={item.disabled ? 'secondary' : 'danger'} icon={item.disabled ? <UserCheck size={15} /> : <UserX size={15} />} onClick={() => setStatusTarget(item)} disabled={busy || self} title={self ? '不能停用当前账号' : undefined}>{item.disabled ? '启用' : '停用'}</Button>
                  </div>
                </div>
              );
            })}
            {visibleUsers.length === 0 && <EmptyState icon={<Search size={22} />} title="没有匹配的用户" />}
          </div>
        </section>
      )}

          {view === 'roles' && (
            <div id="system-settings-panel-roles" aria-labelledby="system-settings-nav-roles" className="system-role-list settings-panel">
          {roles.map((role) => (
            <article className="role-admin-card settings-section glass-card" key={role.id}>
              <header><ShieldCheck size={19} /><div><h3>{role.label}</h3><p>{role.name} · {role.builtIn ? '系统内置角色' : '自定义角色'}</p></div>{role.builtIn && <em>内置角色</em>}</header>
              <div className="setting-row role-member-row"><div><strong>角色成员</strong><span>当前拥有该角色的用户数量</span></div><strong>{roleMemberCount(role.name)} 名用户</strong></div>
              <div className="role-permissions"><div className="role-permissions__label"><strong>权限范围</strong><span>该角色可以执行的操作</span></div><div className="role-permissions__list">{role.permissions.map((permission) => <span key={permission}>{permissionLabels[permission] || permission}</span>)}</div></div>
            </article>
          ))}
        </div>
          )}
        </div>
      </div>

      <Modal
        open={Boolean(statusTarget)}
        onClose={() => setStatusTarget(undefined)}
        title={`${statusTarget?.disabled ? '启用' : '停用'}账号`}
        width="440px"
        footer={<><Button variant="ghost" onClick={() => setStatusTarget(undefined)}>取消</Button><Button variant={statusTarget?.disabled ? 'primary' : 'danger'} onClick={() => void updateStatus()} disabled={Boolean(statusTarget && busyUsers.has(statusTarget.id))}>{statusTarget?.disabled ? '确认启用' : '确认停用'}</Button></>}
      >
        <p className="confirm-copy">{statusTarget?.disabled ? <>启用 <strong>{statusTarget?.displayName}</strong> 后，该用户可以重新登录。</> : <>停用 <strong>{statusTarget?.displayName}</strong> 后，其现有会话和受信任设备将立即失效。</>}</p>
      </Modal>

      <Modal
        open={Boolean(resetTarget)}
        onClose={closeReset}
        title={`重置 ${resetTarget?.displayName || ''} 的密码`}
        width="480px"
        footer={resetCode
          ? <><Button variant="ghost" onClick={closeReset}>关闭</Button><Button variant="primary" icon={<KeyRound size={15} />} onClick={() => void copyResetCode()}>复制重置码</Button></>
          : <><Button variant="ghost" onClick={closeReset}>取消</Button><Button variant="primary" icon={<KeyRound size={15} />} onClick={() => void generateResetCode()} disabled={resetting}>{resetting ? '生成中' : '生成重置码'}</Button></>}
      >
        {resetCode ? <div className="reset-code-panel"><span>{resetCode.username}</span><code>{resetCode.code}</code><small>{resetCode.expiresInMinutes} 分钟内有效，使用一次后立即失效</small></div> : <p className="confirm-copy">生成一次性重置码后，将其安全地交给该用户。</p>}
      </Modal>
    </div>
  );
}
