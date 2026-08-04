import { ArrowLeft, BadgeCheck, Check, KeyRound, LockKeyhole, Mail, Search, ShieldCheck, UserRound } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../api';
import { useAuth } from '../auth-context';
import { Button } from '../components/ui';
import type { RegistrationProfile } from '../types';

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <main className="auth-page"><section className="auth-panel glass-panel"><header className="auth-brand"><span className="auth-mark">K</span><div><strong>Kust</strong><small>Kubernetes 控制台</small></div></header><div className="auth-heading"><h1>{title}</h1><p>{subtitle}</p></div>{children}</section></main>;
}

export function LoginPage() {
  const { login, completeAuth } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState(params.get('username') || '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const code = params.get('code');
  useEffect(() => {
    if (!code || !username) return;
    setBusy(true);
    api.codeLogin(username, code).then((state) => { completeAuth(state); navigate('/'); }).catch((reason) => setError(reason.message)).finally(() => setBusy(false));
  }, [code, completeAuth, navigate, username]);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await login(username, password); navigate('/'); } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败'); } finally { setBusy(false); } };
  const oaLogin = async () => { setBusy(true); setError(''); try { const result = await api.oaLogin(username); setError(result.debugCode ? `开发登录码：${result.debugCode}` : result.message); } catch (reason) { setError(reason instanceof Error ? reason.message : 'OA 请求失败'); } finally { setBusy(false); } };
  return <AuthShell title="欢迎回来" subtitle="登录后继续管理你的 Kubernetes 集群"><form className="auth-form" onSubmit={submit}><label><span>用户名 / ITCode</span><div className="auth-input"><UserRound size={17} /><input required autoFocus value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></div></label><label><span>密码</span><div className="auth-input"><LockKeyhole size={17} /><input required type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></div></label>{error && <p className="auth-message">{error}</p>}<Button variant="primary" disabled={busy}>{busy ? '登录中' : '登录'}</Button><Button type="button" onClick={oaLogin} disabled={busy || username.length < 3}>通过 OA 获取登录链接</Button></form><footer className="auth-links"><Link to="/forgot-password">忘记密码</Link><Link to="/register">创建账号</Link></footer></AuthShell>;
}

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [profile, setProfile] = useState<RegistrationProfile>();
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [error, setError] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const passwordsMatch = passwordConfirmation.length === 0 || password === passwordConfirmation;

  const lookup = async () => {
    if (lookingUp || username.trim().length < 3) return;
    setLookingUp(true);
    setError('');
    try {
      const result = await api.registrationProfile(username);
      setUsername(result.username);
      setProfile(result);
      setPassword('');
      setPasswordConfirmation('');
    } catch (reason) {
      setProfile(undefined);
      setError(reason instanceof Error ? reason.message : '未查询到用户');
    } finally {
      setLookingUp(false);
    }
  };
  const resetProfile = () => {
    setProfile(undefined);
    setPassword('');
    setPasswordConfirmation('');
    setError('');
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!profile) {
      await lookup();
      return;
    }
    if (password !== passwordConfirmation) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await register(profile.username, password, passwordConfirmation);
      navigate('/');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '注册失败');
    } finally {
      setBusy(false);
    }
  };

  return <AuthShell title="创建账号" subtitle="使用组织账号设置 Kust 登录密码">
    <form className="auth-form" onSubmit={submit}>
      <label><span>用户名（ITCode）</span><div className="auth-input"><UserRound size={17} /><input required minLength={3} autoFocus={!profile} autoComplete="username" value={username} readOnly={Boolean(profile)} onChange={(event) => { setUsername(event.target.value); setProfile(undefined); setError(''); }} /></div></label>
      {!profile && <Button variant="primary" icon={<Search size={16} />} disabled={lookingUp || username.trim().length < 3}>{lookingUp ? '查询中' : '查询用户'}</Button>}
      {profile && <>
        <section className="registration-profile" aria-label="已匹配的用户资料">
          <header><BadgeCheck size={20} /><div><strong>{profile.realName}</strong><span>{profile.displayName} · {profile.itcode}</span></div><em>OA</em></header>
          <dl>
            <div><dt>用户名</dt><dd>{profile.username}</dd></div>
            <div><dt>真实姓名</dt><dd>{profile.realName}</dd></div>
            {profile.email && <div><dt><Mail size={12} />邮箱</dt><dd title={profile.email}>{profile.email}</dd></div>}
          </dl>
        </section>
        <label><span>密码（至少 10 位）</span><div className="auth-input"><KeyRound size={17} /><input required type="password" minLength={10} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></div></label>
        <label><span>再次输入密码</span><div className={`auth-input ${!passwordsMatch ? 'is-invalid' : ''}`}><LockKeyhole size={17} /><input required type="password" minLength={10} maxLength={256} value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} autoComplete="new-password" aria-invalid={!passwordsMatch} /></div>{!passwordsMatch && <small className="field-error">两次输入的密码不一致</small>}</label>
        <div className="registration-actions"><Button type="button" variant="ghost" onClick={resetProfile} disabled={busy}>更换用户</Button><Button variant="primary" icon={<Check size={16} />} disabled={busy || password.length < 10 || passwordConfirmation.length < 10 || !passwordsMatch}>{busy ? '创建中' : '完成注册'}</Button></div>
      </>}
      {error && <p className="auth-message">{error}</p>}
    </form>
    <footer className="auth-links"><Link to="/login"><ArrowLeft size={14} /> 返回登录</Link></footer>
  </AuthShell>;
}

export function ForgotPasswordPage() {
  const [username, setUsername] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { const result = await api.requestPasswordReset(username); setMessage(result.debugCode ? `${result.message}，开发重置码：${result.debugCode}` : result.message); } catch (reason) { setMessage(reason instanceof Error ? reason.message : '请求失败'); } finally { setBusy(false); } };
  return <AuthShell title="重置密码" subtitle="OA 账号会收到链接，本地账号请向管理员获取重置码"><form className="auth-form" onSubmit={submit}><label><span>用户名 / ITCode</span><div className="auth-input"><UserRound size={17} /><input required value={username} onChange={(event) => setUsername(event.target.value)} /></div></label>{message && <p className="auth-message">{message}</p>}<Button variant="primary" disabled={busy}>获取重置方式</Button><Link className="button button--ghost" to={`/reset-password?username=${encodeURIComponent(username)}`}>已有重置码</Link></form><footer className="auth-links"><Link to="/login"><ArrowLeft size={14} /> 返回登录</Link></footer></AuthShell>;
}

export function ResetPasswordPage() {
  const navigate = useNavigate(); const [params] = useSearchParams();
  const [form, setForm] = useState({ username: params.get('username') || '', code: params.get('code') || '', password: '' }); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await api.resetPassword(form.username, form.code, form.password); navigate('/login'); } catch (reason) { setError(reason instanceof Error ? reason.message : '重置失败'); } finally { setBusy(false); } };
  return <AuthShell title="设置新密码" subtitle="重置码有效期为 30 分钟，使用后立即失效"><form className="auth-form" onSubmit={submit}><label><span>用户名</span><div className="auth-input"><UserRound size={17} /><input required value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></div></label><label><span>重置码</span><div className="auth-input"><ShieldCheck size={17} /><input required value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} /></div></label><label><span>新密码</span><div className="auth-input"><KeyRound size={17} /><input required type="password" minLength={10} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></div></label>{error && <p className="auth-message">{error}</p>}<Button variant="primary" disabled={busy}>重置密码</Button></form></AuthShell>;
}

export function TwoFactorPage() {
  const { next, completeAuth, logout } = useAuth(); const navigate = useNavigate(); const [params] = useSearchParams();
  const enrolling = next === 'enroll' || params.get('mode') === 'enroll'; const [setup, setSetup] = useState<{ secret: string; uri: string }>(); const [code, setCode] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (enrolling) api.totpSetup().then(setSetup).catch((reason) => setError(reason.message)); }, [enrolling]);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { completeAuth(await api.totpVerify(code)); navigate('/'); } catch (reason) { setError(reason instanceof Error ? reason.message : '验证码错误'); } finally { setBusy(false); } };
  return <AuthShell title={enrolling ? '绑定双重认证' : '双重认证'} subtitle={enrolling ? '管理员必须先完成绑定才能进入控制台' : '请输入验证器生成的 6 位动态验证码'}>{enrolling && setup && <div className="totp-setup"><div className="totp-qr"><QRCodeSVG value={setup.uri} size={164} level="M" /></div><div><strong>使用验证器扫描</strong><p>Android 推荐 Google Authenticator，iPhone 可直接使用“密码”App 中的验证码功能。</p><code>{setup.secret}</code></div></div>}<form className="auth-form" onSubmit={submit}><label><span>6 位验证码</span><div className="auth-input auth-input--code"><ShieldCheck size={18} /><input required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoFocus value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} /></div></label>{error && <p className="auth-message">{error}</p>}<Button variant="primary" icon={<Check size={17} />} disabled={busy || code.length !== 6}>{busy ? '验证中' : '验证并继续'}</Button><Button type="button" variant="ghost" onClick={() => void logout()}>退出登录</Button></form></AuthShell>;
}
