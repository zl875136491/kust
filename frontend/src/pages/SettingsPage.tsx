import { Check, ChevronRight, KeyRound, Laptop, LoaderCircle, LogOut, Moon, Palette, Rows3, ShieldCheck, Sparkles, Sun } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth-context';
import { Button, Modal, useToast } from '../components/ui';
import { usePreferences } from '../preferences-context';
import { useThemeMode } from '../theme-context';
import type { ThemeMode, UserSettings } from '../types';
import { useVisualEffects } from '../visual-effects-context';

type SettingsView = 'appearance' | 'effects' | 'resources' | 'security';

export function SettingsPage() {
  const { mode: theme, setMode: setTheme } = useThemeMode();
  const { effects, setEffect } = useVisualEffects();
  const { settings, loading, save } = usePreferences();
  const { user, logout } = useAuth();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [rows, setRows] = useState(25);
  const [windowCloseConfirmation, setWindowCloseConfirmation] = useState(true);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [rememberDays, setRememberDays] = useState(7);
  const [saving, setSaving] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwords, setPasswords] = useState({ current: '', next: '' });
  const [activeView, setActiveView] = useState<SettingsView>('appearance');
  const isAdmin = Boolean(user?.roles.includes('admin'));

  useEffect(() => {
    if (!settings) return;
    setAutoRefresh(settings.autoRefresh);
    setRows(settings.pageSize);
    setWindowCloseConfirmation(settings.windowCloseConfirmation);
    setTwoFactorEnabled(settings.twoFactorEnabled);
    setRememberDays(settings.twoFactorRememberDays);
  }, [settings]);

  const themes: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { value: 'system', label: '系统', icon: <Laptop size={19} /> }, { value: 'light', label: '浅色', icon: <Sun size={19} /> }, { value: 'dark', label: '深色', icon: <Moon size={19} /> },
  ];
  const views: { value: SettingsView; label: string; description: string; icon: React.ReactNode }[] = [
    { value: 'appearance', label: '外观', description: '主题与显示模式', icon: <Palette size={18} /> },
    { value: 'effects', label: '视觉效果', description: '玻璃材质与动效', icon: <Sparkles size={18} /> },
    { value: 'resources', label: '资源与窗口', description: '列表与工作区行为', icon: <Rows3 size={18} /> },
    { value: 'security', label: '安全', description: '账号与双重认证', icon: <ShieldCheck size={18} /> },
  ];
  const effectOptions = [
    ['backdropBlur', '背景模糊', '半透明材质的背景模糊', false],
    ['hoverMotion', '悬停浮起', '控件悬停时的空间层次反馈', false],
    ['pointerHighlight', '指针高光', '跟随指针位置的局部高光', true],
    ['refraction', '液态折射', '移动指针时模拟玻璃折射', true],
  ] as const;
  const maxRememberDays = isAdmin ? 15 : 30;
  const payload = useMemo<UserSettings>(() => ({
    theme, ...effects, autoRefresh, pageSize: rows, windowCloseConfirmation,
    twoFactorEnabled: isAdmin ? true : twoFactorEnabled,
    twoFactorRequired: isAdmin,
    twoFactorRememberDays: Math.min(maxRememberDays, Math.max(1, rememberDays)),
  }), [autoRefresh, effects, isAdmin, maxRememberDays, rememberDays, rows, theme, twoFactorEnabled, windowCloseConfirmation]);
  const saveSettings = async () => { setSaving(true); try { await save(payload); pushToast('设置已保存到账号'); } catch (reason) { pushToast(reason instanceof Error ? reason.message : '保存失败', 'error'); } finally { setSaving(false); } };
  const changePassword = async () => { try { await api.changePassword(passwords.current, passwords.next); setPasswords({ current: '', next: '' }); setPasswordOpen(false); pushToast('密码已更新'); return true; } catch (reason) { pushToast(reason instanceof Error ? reason.message : '修改失败', 'error'); return false; } };

  if (loading && !settings) return <div className="page settings-page"><div className="auth-loading"><LoaderCircle className="spin" size={22} /><span>加载用户设置</span></div></div>;
  return <div className="page settings-page">
    <header className="page-header">
      <div><span className="eyebrow">preferences</span><h2>个人设置</h2></div>
      <Button variant="primary" icon={<Check size={17} />} onClick={() => void saveSettings()} disabled={saving}>{saving ? '保存中' : '保存'}</Button>
    </header>
    <div className="settings-workspace">
      <nav className="settings-sidebar glass-card" aria-label="个人设置分类">
        {views.map((item) => <button
          key={item.value}
          id={`settings-nav-${item.value}`}
          className={activeView === item.value ? 'is-active' : ''}
          aria-current={activeView === item.value ? 'page' : undefined}
          aria-controls={`settings-panel-${item.value}`}
          onClick={() => setActiveView(item.value)}
        >
          {item.icon}
          <span className="settings-sidebar__copy"><strong>{item.label}</strong><small>{item.description}</small></span>
          <ChevronRight size={15} />
        </button>)}
      </nav>

      <div className="settings-content">
        {activeView === 'appearance' && <section id="settings-panel-appearance" aria-labelledby="settings-nav-appearance" className="settings-section settings-panel glass-card">
          <header><Palette size={19} /><div><h3>外观</h3><p>选择界面的明暗显示方式</p></div></header>
          <div className="theme-options">{themes.map((item) => <button key={item.value} className={theme === item.value ? 'is-selected' : ''} onClick={() => setTheme(item.value)}>{item.icon}<span>{item.label}</span>{theme === item.value && <Check size={15} />}</button>)}</div>
        </section>}

        {activeView === 'effects' && <section id="settings-panel-effects" aria-labelledby="settings-nav-effects" className="settings-section settings-panel glass-card">
          <header><Sparkles size={19} /><div><h3>视觉效果</h3><p>调整玻璃材质和界面动效</p></div></header>
          {effectOptions.map(([key, label, description, experimental]) => <div className="setting-row" key={key}>
            <div><strong>{label}</strong><span>{description}</span>{experimental && <span className="setting-note--experimental">实验性功能，可能造成性能问题</span>}</div>
            <label className="switch-control"><input aria-label={label} type="checkbox" checked={effects[key]} onChange={(event) => setEffect(key, event.target.checked)} /><i /></label>
          </div>)}
        </section>}

        {activeView === 'resources' && <section id="settings-panel-resources" aria-labelledby="settings-nav-resources" className="settings-section settings-panel glass-card">
          <header><Rows3 size={19} /><div><h3>资源与窗口</h3><p>设置资源列表和工作区窗口行为</p></div></header>
          <div className="setting-row"><div><strong>自动刷新</strong><span>缓存按后端同步周期更新</span></div><label className="switch-control"><input aria-label="自动刷新" type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} /><i /></label></div>
          <div className="setting-row"><div><strong>每页行数</strong><span>资源表格</span></div><input className="number-input" type="number" min={10} max={200} step={5} value={rows} onChange={(event) => setRows(Number(event.target.value))} /></div>
          <div className="setting-row"><div><strong>窗口关闭二次确认</strong><span>关闭终端、文件或日志窗口前再次确认</span></div><label className="switch-control"><input aria-label="窗口关闭二次确认" type="checkbox" checked={windowCloseConfirmation} onChange={(event) => setWindowCloseConfirmation(event.target.checked)} /><i /></label></div>
        </section>}

        {activeView === 'security' && <section id="settings-panel-security" aria-labelledby="settings-nav-security" className="settings-section settings-panel glass-card">
          <header><ShieldCheck size={19} /><div><h3>安全</h3><p>管理账号密码与双重认证</p></div></header>
          <div className="setting-row"><div><strong>双重认证</strong><span>{isAdmin ? '管理员角色必须启用，不能关闭' : '使用 TOTP 验证器保护账号'}</span></div><label className="switch-control"><input aria-label="双重认证" type="checkbox" checked={isAdmin || twoFactorEnabled} disabled={isAdmin} onChange={(event) => event.target.checked && !user?.twoFactorEnabled ? navigate('/two-factor?mode=enroll') : setTwoFactorEnabled(event.target.checked)} /><i /></label></div>
          <div className="setting-row"><div><strong>免验证有效期</strong><span>{isAdmin ? '管理员可设置 1-15 天' : '普通用户可设置 1-30 天'}</span></div><input className="number-input" type="number" min={1} max={maxRememberDays} value={rememberDays} onChange={(event) => setRememberDays(Number(event.target.value))} /></div>
          <div className="settings-inline-actions"><Button icon={<KeyRound size={16} />} onClick={() => setPasswordOpen(true)}>修改密码</Button><Button variant="ghost" icon={<LogOut size={16} />} onClick={() => void logout()}>退出登录</Button></div>
        </section>}
      </div>
    </div>
    <Modal open={passwordOpen} onClose={() => setPasswordOpen(false)} title="修改密码" dirty={Boolean(passwords.current || passwords.next)} onSave={changePassword} footer={<><Button variant="ghost" onClick={() => setPasswordOpen(false)}>取消</Button><Button variant="primary" onClick={() => void changePassword()}>更新密码</Button></>}><div className="form-grid"><label><span>当前密码</span><input type="password" value={passwords.current} onChange={(event) => setPasswords({ ...passwords, current: event.target.value })} /></label><label><span>新密码（至少 10 位）</span><input type="password" minLength={10} value={passwords.next} onChange={(event) => setPasswords({ ...passwords, next: event.target.value })} /></label></div></Modal>
  </div>;
}
