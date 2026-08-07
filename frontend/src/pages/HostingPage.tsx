import { ArrowUpRight, CirclePlus, Clock3, ExternalLink, GitBranch, KeyRound, Link2, LoaderCircle, PackageCheck, RefreshCw, RotateCcw, Rocket, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useData } from '../data-context';
import type { ApplicationBuild, ApplicationWebhook, CreateGitCredentialPayload, CreateHostedApplicationPayload, GitCredential, HostedApplication, HostingBuildMode, HostingCapabilities } from '../types';
import { Button, EmptyState, IconButton, Modal, SelectMenu, Spinner, StatusPill, useToast } from '../components/ui';

const modeOptions: Array<{ value: HostingBuildMode; label: string; detail: string }> = [
  { value: 'dockerfile', label: 'Dockerfile', detail: '使用仓库中的 Dockerfile' },
  { value: 'buildpack', label: 'Buildpacks', detail: '自动识别常见服务项目' },
  { value: 'static', label: '静态站点', detail: '构建产物由受控 Nginx 托管' },
  { value: 'custom', label: '自定义构建', detail: '仅执行受限构建命令' },
];

const initialApplication = (): CreateHostedApplicationPayload => ({
  name: '', repositoryUrl: '', gitRef: 'main', buildMode: 'dockerfile', sourceSubdirectory: '', buildCommand: '', outputDirectory: 'dist', containerPort: 8080, healthPath: '/', clusterId: '', namespace: 'default', replicas: 1, cpuRequest: '100m', memoryRequest: '128Mi', cpuLimit: '500m', memoryLimit: '512Mi', routePath: '/', autoDeploy: false,
});

function formatDate(value?: string) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function HostingPage() {
  const { clusters } = useData();
  const { pushToast } = useToast();
  const [applications, setApplications] = useState<HostedApplication[]>([]);
  const [credentials, setCredentials] = useState<GitCredential[]>([]);
  const [capabilities, setCapabilities] = useState<HostingCapabilities>({ hostingEnabled: false, jenkinsConfigured: false, allowedNamespaces: [], defaultNamespace: 'default' });
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [selected, setSelected] = useState<HostedApplication>();
  const [deleting, setDeleting] = useState<HostedApplication>();
  const [webhook, setWebhook] = useState<ApplicationWebhook>();

  const reload = async () => {
    setLoading(true);
    try {
      const [nextApplications, nextCredentials, nextCapabilities] = await Promise.all([api.hostedApplications(), api.hostingCredentials(), api.hostingCapabilities()]);
      setApplications(nextApplications); setCredentials(nextCredentials); setCapabilities(nextCapabilities);
    } catch (error) { pushToast(error instanceof Error ? error.message : '无法加载应用托管数据', 'error'); } finally { setLoading(false); }
  };
  // The initial load intentionally runs once; reload is also exposed through the toolbar.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, []);

  const deploy = async (application: HostedApplication) => {
    try { const build = await api.deployHostedApplication(application.id); setApplications((current) => current.map((item) => item.id === application.id ? { ...item, latestBuild: build } : item)); pushToast(`已触发 ${application.name} 的构建`); } catch (error) { pushToast(error instanceof Error ? error.message : '无法触发部署', 'error'); }
  };
  const rollback = async (application: HostedApplication) => {
    try { await api.rollbackHostedApplication(application.id); pushToast(`已将 ${application.name} 回滚到上一版本`); void reload(); } catch (error) { pushToast(error instanceof Error ? error.message : '无法回滚', 'error'); }
  };
  const remove = async () => {
    if (!deleting) return false;
    try { await api.deleteHostedApplication(deleting.id); setApplications((current) => current.filter((item) => item.id !== deleting.id)); setDeleting(undefined); pushToast(`应用 ${deleting.name} 已删除`); return true; } catch (error) { pushToast(error instanceof Error ? error.message : '无法删除应用', 'error'); return false; }
  };

  if (loading) return <div className="page hosting-page"><Spinner label="正在读取应用托管状态" /></div>;
  return <div className="page hosting-page">
    <header className="page-header"><div><span className="eyebrow">application hosting</span><h2>应用托管</h2></div><div className="page-actions"><IconButton label="刷新应用" onClick={() => void reload()}><RefreshCw size={18} /></IconButton><Button icon={<KeyRound size={17} />} onClick={() => setCredentialOpen(true)}>Git 凭证</Button><Button variant="primary" icon={<CirclePlus size={17} />} onClick={() => setCreateOpen(true)} disabled={!capabilities.hostingEnabled}>新建应用</Button></div></header>
    {!capabilities.hostingEnabled && <div className="hosting-notice glass-card"><ShieldCheck size={19} /><div><strong>应用托管尚未启用</strong><span>管理员需要配置 KUST_APP_HOSTING_ENABLED、受控 Gateway、路由域名与 Harbor 仓库前缀。</span></div></div>}
    {!capabilities.jenkinsConfigured && capabilities.hostingEnabled && <div className="hosting-notice glass-card is-warning"><Clock3 size={19} /><div><strong>Jenkins 尚未连接</strong><span>应用可以被保存，但部署会保持排队，直到配置 Jenkins URL 和 API Token。</span></div></div>}
    <section className="hosting-summary"><article className="glass-card"><PackageCheck size={20} /><div><strong>{applications.length}</strong><span>托管应用</span></div></article><article className="glass-card"><Rocket size={20} /><div><strong>{applications.filter((item) => item.latestBuild?.status === 'succeeded').length}</strong><span>已发布版本</span></div></article><article className="glass-card"><GitBranch size={20} /><div><strong>{credentials.length}</strong><span>Git 凭证</span></div></article></section>
    {applications.length === 0 ? <EmptyState icon={<Rocket size={25} />} title="还没有托管应用" body="连接 Git 仓库后，Kust 会通过 Jenkins 构建镜像，并用受控 Deployment、Service 与 HTTPRoute 发布。" action={<Button variant="primary" icon={<CirclePlus size={16} />} disabled={!capabilities.hostingEnabled} onClick={() => setCreateOpen(true)}>新建应用</Button>} /> : <section className="hosting-list glass-card">
      <header className="hosting-list__header"><div><Rocket size={18} /><strong>应用</strong><span>{applications.length}</span></div><small>受控部署到 Deployment、Service 与 HTTPRoute</small></header>
      <div className="hosting-list__body">{applications.map((application) => <ApplicationRow key={application.id} application={application} onDeploy={() => void deploy(application)} onRollback={() => void rollback(application)} onOpen={() => setSelected(application)} onDelete={() => setDeleting(application)} />)}</div>
    </section>}
    <CreateApplicationModal open={createOpen} clusters={clusters} credentials={credentials} capabilities={capabilities} onClose={() => setCreateOpen(false)} onCreated={(application) => { setApplications((current) => [application, ...current]); setCreateOpen(false); void deploy(application); }} />
    <CredentialsModal open={credentialOpen} credentials={credentials} onClose={() => setCredentialOpen(false)} onChanged={setCredentials} />
    <ApplicationDetailModal application={selected} onClose={() => { setSelected(undefined); setWebhook(undefined); }} onDeploy={deploy} webhook={webhook} onConfigureWebhook={async (application) => { try { const value = await api.rotateHostedApplicationWebhook(application.id); setWebhook(value); setApplications((current) => current.map((item) => item.id === application.id ? { ...item, webhookConfigured: true } : item)); setSelected((current) => current?.id === application.id ? { ...current, webhookConfigured: true } : current); pushToast('GitLab Webhook 密钥已生成，仅在当前窗口展示一次'); } catch (error) { pushToast(error instanceof Error ? error.message : '无法生成 GitLab Webhook 配置', 'error'); } }} />
    <Modal open={Boolean(deleting)} onClose={() => setDeleting(undefined)} title={`删除 ${deleting?.name || ''}`} width="460px" footer={(requestClose) => <><Button variant="ghost" onClick={requestClose}>取消</Button><Button variant="danger" icon={<Trash2 size={16} />} onClick={() => void remove()}>删除应用</Button></>}>
      <p className="confirm-copy">Kust 将删除它管理的 Deployment、Service 与 HTTPRoute。Harbor 中已构建的镜像不会被立即清理。</p>
    </Modal>
  </div>;
}

function ApplicationRow({ application, onDeploy, onRollback, onOpen, onDelete }: { application: HostedApplication; onDeploy: () => void; onRollback: () => void; onOpen: () => void; onDelete: () => void }) {
  const url = `http://${application.routeHost}${application.routePath}`;
  return <article className="hosting-app-row">
    <button className="hosting-app-row__main" onClick={onOpen}><span className="hosting-app-mark"><Rocket size={18} /></span><span><strong>{application.name}</strong><small><GitBranch size={12} />{application.repositoryUrl.replace(/^https?:\/\//, '')}<i />{application.gitRef}</small></span></button>
    <div className="hosting-app-target"><span>{application.namespace}</span><small>{application.replicas} 副本 · {application.containerPort}</small></div>
    <a className="hosting-route" href={url} target="_blank" rel="noreferrer" title={url}><span>{application.routePath}</span><ExternalLink size={14} /></a>
    <div className="hosting-app-build"><StatusPill status={application.latestBuild?.status === 'succeeded' ? '已发布' : application.latestBuild?.status === 'running' ? '构建中' : application.latestBuild?.status === 'failed' ? '失败' : '未部署'} /><small>{formatDate(application.latestBuild?.createdAt)}</small></div>
    <div className="hosting-app-actions"><IconButton label="重新部署" onClick={onDeploy}><Rocket size={16} /></IconButton><IconButton label="回滚上一版本" onClick={onRollback}><RotateCcw size={16} /></IconButton><IconButton label="删除应用" onClick={onDelete}><Trash2 size={16} /></IconButton></div>
  </article>;
}

function CreateApplicationModal({ open, clusters, credentials, capabilities, onClose, onCreated }: { open: boolean; clusters: Array<{ id: string; name: string }>; credentials: GitCredential[]; capabilities: HostingCapabilities; onClose: () => void; onCreated: (application: HostedApplication) => void }) {
  const { pushToast } = useToast(); const [value, setValue] = useState<CreateHostedApplicationPayload>(initialApplication); const [submitting, setSubmitting] = useState(false);
  useEffect(() => { if (open) setValue((current) => ({ ...current, clusterId: current.clusterId || clusters[0]?.id || '', namespace: capabilities.allowedNamespaces.includes(current.namespace) ? current.namespace : capabilities.defaultNamespace })); }, [capabilities.allowedNamespaces, capabilities.defaultNamespace, clusters, open]);
  const set = <K extends keyof CreateHostedApplicationPayload>(key: K, next: CreateHostedApplicationPayload[K]) => setValue((current) => ({ ...current, [key]: next }));
  const submit = async () => {
    if (!value.name.trim() || !value.repositoryUrl.trim() || !value.clusterId || !value.routePath.trim()) { pushToast('请补齐应用名、仓库、集群与路由路径', 'error'); return false; }
    setSubmitting(true); try { const application = await api.createHostedApplication({ ...value, sourceSubdirectory: value.sourceSubdirectory || undefined, buildCommand: value.buildCommand || undefined, outputDirectory: value.outputDirectory || undefined }); onCreated(application); setValue(initialApplication()); return true; } catch (error) { pushToast(error instanceof Error ? error.message : '创建应用失败', 'error'); return false; } finally { setSubmitting(false); }
  };
  const selectedMode = modeOptions.find((item) => item.value === value.buildMode)!;
  return <Modal open={open} onClose={onClose} title="新建托管应用" description="Kust 保存受限规格，Jenkins 构建不可变镜像，后端发布受控 Kubernetes 资源。" width="980px" className="modal--hosting" dirty={Boolean(value.name || value.repositoryUrl)} closeDisabled={submitting} onSave={submit} onDiscard={() => setValue(initialApplication())} footer={(requestClose) => <><Button variant="ghost" onClick={requestClose}>取消</Button><Button variant="primary" icon={<Rocket size={16} />} onClick={() => void submit()} disabled={submitting}>{submitting ? '保存中' : '创建应用'}</Button></>}>
    <div className="hosting-form">
      <section><header><GitBranch size={17} /><div><strong>源码</strong><span>仓库凭证仅加密保存，构建时短暂提供给 Jenkins。</span></div></header><div className="form-grid"><label className="field"><span>应用名称</span><input value={value.name} onChange={(event) => set('name', event.target.value)} placeholder="orders-web" autoFocus /></label><label className="field"><span>分支或标签</span><input value={value.gitRef} onChange={(event) => set('gitRef', event.target.value)} placeholder="main" /></label></div><label className="field"><span>Git 仓库地址</span><input value={value.repositoryUrl} onChange={(event) => set('repositoryUrl', event.target.value)} placeholder="https://gitlab.example.com/team/orders-web.git" /></label><div className="form-grid"><SelectMenu label="Git 凭证" value={value.credentialId || ''} options={[{ value: '', label: '公开仓库，不使用凭证' }, ...credentials.map((credential) => ({ value: credential.id, label: `${credential.name} · ${credential.credentialType === 'ssh_key' ? 'SSH Key' : 'Access Token'}` }))]} onChange={(next) => set('credentialId', next || undefined)} /><label className="field"><span>源码子目录（可选）</span><input value={value.sourceSubdirectory || ''} onChange={(event) => set('sourceSubdirectory', event.target.value)} placeholder="apps/web" /></label></div></section>
      <section><header><PackageCheck size={17} /><div><strong>构建</strong><span>{selectedMode.detail}</span></div></header><div className="build-mode-grid">{modeOptions.map((item) => <button key={item.value} type="button" className={item.value === value.buildMode ? 'is-active' : ''} onClick={() => set('buildMode', item.value)}><strong>{item.label}</strong><small>{item.detail}</small></button>)}</div>{(value.buildMode === 'static' || value.buildMode === 'custom') && <div className="form-grid"><label className="field"><span>构建命令</span><input value={value.buildCommand || ''} onChange={(event) => set('buildCommand', event.target.value)} placeholder="npm ci && npm run build" /></label><label className="field"><span>产物目录</span><input value={value.outputDirectory || ''} onChange={(event) => set('outputDirectory', event.target.value)} placeholder="dist" /></label></div>}</section>
      <section><header><Rocket size={17} /><div><strong>部署与访问</strong><span>平台仅生成 Deployment、Service 和 HTTPRoute。</span></div></header><div className="hosting-form-grid"><div className="form-grid"><SelectMenu label="目标集群" value={value.clusterId} options={clusters.map((cluster) => ({ value: cluster.id, label: cluster.name }))} onChange={(next) => set('clusterId', next)} />{capabilities.allowedNamespaces.length ? <SelectMenu label="命名空间" value={value.namespace} options={capabilities.allowedNamespaces.map((namespace) => ({ value: namespace, label: namespace }))} onChange={(next) => set('namespace', next)} /> : <label className="field"><span>命名空间</span><input value={value.namespace} onChange={(event) => set('namespace', event.target.value)} /></label>}<label className="field"><span>容器端口</span><input type="number" min={1} max={65535} value={value.containerPort} onChange={(event) => set('containerPort', Number(event.target.value))} /></label><label className="field"><span>健康检查路径</span><input value={value.healthPath} onChange={(event) => set('healthPath', event.target.value)} /></label></div><div className="form-grid"><div className="field field--read-only"><span>HTTPRoute Host</span><strong>由平台受控 Gateway 配置</strong></div><label className="field"><span>HTTPRoute Path</span><input value={value.routePath} onChange={(event) => set('routePath', event.target.value)} placeholder="/apps/orders-web" /></label><label className="field"><span>副本数</span><input type="number" min={1} max={100} value={value.replicas} onChange={(event) => set('replicas', Number(event.target.value))} /></label><label className="check-field"><input type="checkbox" checked={value.autoDeploy} onChange={(event) => set('autoDeploy', event.target.checked)} /><span><strong>启用自动部署</strong><small>Webhook 配置后可根据分支推送自动触发构建</small></span></label></div></div></section>
    </div>
  </Modal>;
}

function CredentialsModal({ open, credentials, onClose, onChanged }: { open: boolean; credentials: GitCredential[]; onClose: () => void; onChanged: (value: GitCredential[]) => void }) {
  const { pushToast } = useToast(); const [form, setForm] = useState<CreateGitCredentialPayload>({ name: '', credentialType: 'token', username: 'oauth2', secret: '' }); const [saving, setSaving] = useState(false);
  const create = async () => { if (!form.name.trim() || !form.secret.trim()) { pushToast('请填写凭证名称和密钥内容', 'error'); return false; } setSaving(true); try { const credential = await api.createHostingCredential(form); onChanged([credential, ...credentials]); setForm({ name: '', credentialType: 'token', username: 'oauth2', secret: '' }); pushToast('Git 凭证已加密保存'); return true; } catch (error) { pushToast(error instanceof Error ? error.message : '保存 Git 凭证失败', 'error'); return false; } finally { setSaving(false); } };
  const remove = async (credential: GitCredential) => { try { await api.deleteHostingCredential(credential.id); onChanged(credentials.filter((item) => item.id !== credential.id)); pushToast('Git 凭证已删除'); } catch (error) { pushToast(error instanceof Error ? error.message : '无法删除 Git 凭证', 'error'); } };
  return <Modal open={open} onClose={onClose} title="Git 凭证" description="密钥不会返回到浏览器，只会在构建期间以短期租约提供给 Jenkins。" width="720px" dirty={Boolean(form.name || form.secret)} onSave={create} footer={(requestClose) => <><Button variant="ghost" onClick={requestClose}>关闭</Button><Button variant="primary" icon={<KeyRound size={16} />} onClick={() => void create()} disabled={saving}>{saving ? '保存中' : '保存凭证'}</Button></>}>
    <div className="credentials-modal"><div className="form-grid"><label className="field"><span>名称</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="GitLab project read-only" /></label><SelectMenu label="类型" value={form.credentialType} options={[{ value: 'token', label: 'Access Token' }, { value: 'ssh_key', label: 'SSH Deploy Key' }]} onChange={(credentialType) => setForm({ ...form, credentialType: credentialType as CreateGitCredentialPayload['credentialType'] })} /></div><label className="field"><span>用户名（Token 可选）</span><input value={form.username || ''} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="oauth2" /></label><label className="field"><span>{form.credentialType === 'ssh_key' ? '私钥内容' : 'Access Token'}</span><textarea value={form.secret} onChange={(event) => setForm({ ...form, secret: event.target.value })} rows={4} spellCheck={false} /></label><div className="credential-list">{credentials.map((credential) => <div key={credential.id}><span className="hosting-app-mark"><KeyRound size={16} /></span><div><strong>{credential.name}</strong><small>{credential.credentialType === 'ssh_key' ? 'SSH Deploy Key' : 'Access Token'} · {credential.username || '默认用户名'}</small></div><IconButton label={`删除 ${credential.name}`} onClick={() => void remove(credential)}><Trash2 size={16} /></IconButton></div>)}</div></div>
  </Modal>;
}

function ApplicationDetailModal({ application, onClose, onDeploy, webhook, onConfigureWebhook }: { application?: HostedApplication; onClose: () => void; onDeploy: (application: HostedApplication) => void; webhook?: ApplicationWebhook; onConfigureWebhook: (application: HostedApplication) => Promise<void> }) {
  const { pushToast } = useToast(); const [builds, setBuilds] = useState<ApplicationBuild[]>([]); const [loading, setLoading] = useState(false);
  useEffect(() => { if (!application) { setBuilds([]); return; } setLoading(true); api.hostedApplicationBuilds(application.id).then(setBuilds).catch((error) => pushToast(error instanceof Error ? error.message : '无法读取构建记录', 'error')).finally(() => setLoading(false)); }, [application, pushToast]);
  if (!application) return null; const url = `http://${application.routeHost}${application.routePath}`;
  return <Modal open onClose={onClose} title={application.name} description={`${application.clusterId} · ${application.namespace} · ${application.buildMode}`} width="880px" footer={<><a className="button button--secondary" href={url} target="_blank" rel="noreferrer"><ExternalLink size={16} /><span>访问路由</span></a><Button variant="primary" icon={<Rocket size={16} />} onClick={() => onDeploy(application)}>重新部署</Button></>}>
    <div className="application-detail"><section className="application-detail__route"><ArrowUpRight size={18} /><div><strong>{application.routeHost}{application.routePath}</strong><small>Gateway: {application.gatewayNamespace}/{application.gatewayName}</small></div><StatusPill status={application.latestBuild?.status === 'succeeded' ? '已发布' : application.latestBuild?.status || '未部署'} /></section><section className="application-webhook"><header><div><Link2 size={16} /><span><strong>GitLab 自动部署</strong><small>{application.autoDeploy ? '匹配的分支或 Tag push 会触发构建。' : '请先在编辑应用时启用自动部署。'}</small></span></div><Button variant="secondary" icon={<KeyRound size={15} />} onClick={() => void onConfigureWebhook(application)}>{application.webhookConfigured ? '轮换密钥' : '生成 Webhook'}</Button></header>{webhook && <div className="application-webhook__secret"><label><span>Webhook URL</span><code>{webhook.url}</code></label><label><span>Secret Token（仅展示一次）</span><code>{webhook.secret}</code></label></div>}</section><section><h3>构建历史</h3>{loading ? <div className="detail-loading"><LoaderCircle className="spin" size={17} />加载构建记录</div> : <div className="build-history">{builds.length ? builds.map((build) => <article key={build.id}><StatusPill status={build.status === 'succeeded' ? '成功' : build.status === 'running' ? '构建中' : build.status === 'failed' ? '失败' : build.status} /><div><strong>{build.gitCommit ? build.gitCommit.slice(0, 12) : build.gitRef}</strong><small>{build.message || '等待 Jenkins 回传状态'}</small></div><time>{formatDate(build.createdAt)}</time>{build.jenkinsBuildUrl && <a href={build.jenkinsBuildUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /></a>}</article>) : <span className="muted-cell">尚无构建记录</span>}</div>}</section></div>
  </Modal>;
}
