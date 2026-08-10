import { ArrowUpRight, CirclePlus, Clock3, ExternalLink, GitBranch, KeyRound, Link2, LoaderCircle, PackageCheck, RefreshCw, RotateCcw, Rocket, Settings2, ShieldCheck, Trash2, Bot, AlertTriangle, CheckCircle2, Check, Circle, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useData } from '../data-context';
import { motionDuration, useEscapeLayer } from '../hooks/useEscapeLayer';
import type { AgentAnalysis, ApplicationBuild, ApplicationWebhook, CreateGitCredentialPayload, CreateHostedApplicationPayload, GitCredential, HostedApplication, HostingCapabilities } from '../types';
import { Button, EmptyState, IconButton, Modal, SelectMenu, Spinner, StatusPill, useToast } from '../components/ui';

const initialApplication = (): CreateHostedApplicationPayload => ({
  name: '', repositoryUrl: '', gitRef: 'main', buildMode: 'dockerfile', sourceSubdirectory: '', buildCommand: '', outputDirectory: 'dist', buildEnvironment: {}, runtimeEnvironment: {}, runtimeProfile: 'non_root', containerPort: 8080, healthPath: '/', healthScheme: 'HTTP', serviceScheme: 'HTTP', clusterId: '', namespace: 'default', replicas: 1, cpuRequest: '100m', memoryRequest: '128Mi', cpuLimit: '500m', memoryLimit: '512Mi', routePath: '/', autoDeploy: false,
});

function environmentText(environment: Record<string, string>) {
  return Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n');
}

function parseEnvironment(value: string) {
  return value.split('\n').reduce<Record<string, string>>((environment, line) => {
    const separator = line.indexOf('=');
    if (separator > 0) environment[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    return environment;
  }, {});
}

function formatDate(value?: string) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function actionTitle(type: 'redeploy' | 'rebuild' | 'rollback' | 'delete', name: string) {
  const label = { redeploy: '重新发布', rebuild: '重新构建并部署', rollback: '回滚版本', delete: '删除应用' }[type];
  return `${label} ${name}`;
}

function actionDescription(type: 'redeploy' | 'rebuild' | 'rollback' | 'delete', name: string) {
  if (type === 'redeploy') return `将使用 ${name} 最近构建的不可变镜像，并应用当前运行设置，不会重新触发 Jenkins 构建。`;
  if (type === 'rebuild') return `将重新触发 Jenkins 构建 ${name} 的当前 Git 引用，并在构建成功后更新 Kubernetes 资源。`;
  if (type === 'rollback') return `将把 ${name} 回滚到上一个成功发布的镜像版本。`;
  return `将删除 ${name} 管理的 Deployment、Service 与 HTTPRoute。Harbor 中已构建的镜像不会立即清理。`;
}

export function HostingPage() {
  const { clusters } = useData();
  const { pushToast } = useToast();
  const [applications, setApplications] = useState<HostedApplication[]>([]);
  const [credentials, setCredentials] = useState<GitCredential[]>([]);
  const [capabilities, setCapabilities] = useState<HostingCapabilities>({ hostingEnabled: false, jenkinsConfigured: false, agentEnabled: false, agentProvider: 'builtin', allowedNamespaces: [], defaultNamespace: 'default' });
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [selected, setSelected] = useState<HostedApplication>();
  const [webhook, setWebhook] = useState<ApplicationWebhook>();
  const [compatibility, setCompatibility] = useState<HostedApplication>();
  const [pendingAction, setPendingAction] = useState<{ application: HostedApplication; type: 'redeploy' | 'rebuild' | 'rollback' | 'delete' }>();
  const updateBuilds = useCallback((applicationId: string, builds: ApplicationBuild[]) => {
    const latestBuild = builds[0];
    if (!latestBuild) return;
    setApplications((current) => current.map((item) => item.id === applicationId ? { ...item, latestBuild } : item));
    setSelected((current) => current?.id === applicationId ? { ...current, latestBuild } : current);
  }, []);

  const reload = useCallback(async ({ initial = false, reportError = true }: { initial?: boolean; reportError?: boolean } = {}) => {
    try {
      const [nextApplications, nextCredentials, nextCapabilities] = await Promise.all([api.hostedApplications(), api.hostingCredentials(), api.hostingCapabilities()]);
      setApplications(nextApplications); setCredentials(nextCredentials); setCapabilities(nextCapabilities);
    } catch (error) {
      if (reportError) pushToast(error instanceof Error ? error.message : '无法加载应用托管数据', 'error');
    } finally {
      if (initial) setLoading(false);
    }
  }, [pushToast]);
  useEffect(() => { void reload({ initial: true }); }, [reload]);
  useEffect(() => {
    if (createOpen || credentialOpen || selected || compatibility || pendingAction) return;
    if (!applications.some((application) => ['queued', 'running'].includes(application.latestBuild?.status || ''))) return;
    const timer = window.setInterval(() => void reload({ reportError: false }), 5000);
    return () => window.clearInterval(timer);
  }, [applications, compatibility, createOpen, credentialOpen, pendingAction, reload, selected]);

  const deploy = async (application: HostedApplication) => {
    try { const build = await api.deployHostedApplication(application.id); setApplications((current) => current.map((item) => item.id === application.id ? { ...item, latestBuild: build } : item)); setSelected((current) => current?.id === application.id ? { ...current, latestBuild: build } : current); pushToast(`已触发 ${application.name} 的构建`); } catch (error) { pushToast(error instanceof Error ? error.message : '无法触发部署', 'error'); }
  };
  const redeploy = async (application: HostedApplication) => {
    try { const build = await api.redeployHostedApplication(application.id); setApplications((current) => current.map((item) => item.id === application.id ? { ...item, latestBuild: build } : item)); setSelected((current) => current?.id === application.id ? { ...current, latestBuild: build } : current); pushToast(`正在重新发布 ${application.name}`); } catch (error) { pushToast(error instanceof Error ? error.message : '无法重新发布应用', 'error'); }
  };
  const rollback = async (application: HostedApplication) => {
    try { await api.rollbackHostedApplication(application.id); pushToast(`已将 ${application.name} 回滚到上一版本`); void reload(); } catch (error) { pushToast(error instanceof Error ? error.message : '无法回滚', 'error'); }
  };
  const remove = async (application: HostedApplication) => {
    try { await api.deleteHostedApplication(application.id); setApplications((current) => current.filter((item) => item.id !== application.id)); pushToast(`应用 ${application.name} 已删除`); return true; } catch (error) { pushToast(error instanceof Error ? error.message : '无法删除应用', 'error'); return false; }
  };
  const confirmAction = async () => {
    if (!pendingAction) return false;
    const { application, type } = pendingAction;
    if (type === 'redeploy') await redeploy(application);
    if (type === 'rebuild') await deploy(application);
    if (type === 'rollback') await rollback(application);
    if (type === 'delete') await remove(application);
    setPendingAction(undefined);
    return true;
  };

  if (loading) return <div className="page hosting-page"><Spinner label="正在读取应用托管状态" /></div>;
  return <div className="page hosting-page">
    <header className="page-header"><div><span className="eyebrow">application hosting</span><h2>应用托管</h2></div><div className="page-actions"><IconButton label="刷新应用" onClick={() => void reload()}><RefreshCw size={18} /></IconButton><Button icon={<KeyRound size={17} />} onClick={() => setCredentialOpen(true)}>Git 凭证</Button><Button variant="primary" icon={<CirclePlus size={17} />} onClick={() => setCreateOpen(true)} disabled={!capabilities.hostingEnabled || !capabilities.agentEnabled}>新建应用</Button></div></header>
    {!capabilities.hostingEnabled && <div className="hosting-notice glass-card"><ShieldCheck size={19} /><div><strong>应用托管尚未启用</strong><span>管理员需要配置 KUST_APP_HOSTING_ENABLED、受控 Gateway、路由域名与 Harbor 仓库前缀。</span></div></div>}
    {!capabilities.jenkinsConfigured && capabilities.hostingEnabled && <div className="hosting-notice glass-card is-warning"><Clock3 size={19} /><div><strong>Jenkins 尚未连接</strong><span>应用可以被保存，但部署会保持排队，直到配置 Jenkins URL 和 API Token。</span></div></div>}
    {!capabilities.agentEnabled && capabilities.hostingEnabled && <div className="hosting-notice glass-card is-warning"><Bot size={19} /><div><strong>托管 Agent 尚未启用</strong><span>管理员需要在系统设置中启用 Agent，所有托管应用都会先经过项目分析。</span></div></div>}
    <section className="hosting-summary"><article className="glass-card"><PackageCheck size={20} /><div><strong>{applications.length}</strong><span>托管应用</span></div></article><article className="glass-card"><Rocket size={20} /><div><strong>{applications.filter((item) => item.latestBuild?.status === 'succeeded').length}</strong><span>已发布版本</span></div></article><article className="glass-card"><GitBranch size={20} /><div><strong>{credentials.length}</strong><span>Git 凭证</span></div></article></section>
    {applications.length === 0 ? <EmptyState icon={<Rocket size={25} />} title="还没有托管应用" body="连接 Git 仓库后，Kust 会先由 Agent 读取项目证据，再通过 Jenkins 构建镜像，并用受控 Deployment、Service 与 HTTPRoute 发布。" action={<Button variant="primary" icon={<CirclePlus size={16} />} disabled={!capabilities.hostingEnabled || !capabilities.agentEnabled} onClick={() => setCreateOpen(true)}>新建应用</Button>} /> : <section className="hosting-list glass-card">
      <header className="hosting-list__header"><div><Rocket size={18} /><strong>应用</strong><span>{applications.length}</span></div><small>受控部署到 Deployment、Service 与 HTTPRoute</small></header>
      <div className="hosting-list__body">{applications.map((application) => <ApplicationRow key={application.id} application={application} onDeploy={() => setPendingAction({ application, type: 'rebuild' })} onRedeploy={() => setPendingAction({ application, type: 'redeploy' })} onRollback={() => setPendingAction({ application, type: 'rollback' })} onOpen={() => setSelected(application)} onDelete={() => setPendingAction({ application, type: 'delete' })} />)}</div>
    </section>}
    <CreateApplicationModal open={createOpen} clusters={clusters} credentials={credentials} capabilities={capabilities} onClose={() => setCreateOpen(false)} onCreated={(application) => { setApplications((current) => [application, ...current]); setCreateOpen(false); void deploy(application); }} />
    <CredentialsModal open={credentialOpen} credentials={credentials} onClose={() => setCredentialOpen(false)} onChanged={setCredentials} />
    <ApplicationDetailDrawer application={selected} onClose={() => { setSelected(undefined); setWebhook(undefined); }} onDeploy={deploy} onRedeploy={redeploy} onConfigureCompatibility={setCompatibility} onBuildsUpdated={updateBuilds} webhook={webhook} onConfigureWebhook={async (application) => { try { const value = await api.rotateHostedApplicationWebhook(application.id); setWebhook(value); setApplications((current) => current.map((item) => item.id === application.id ? { ...item, webhookConfigured: true } : item)); setSelected((current) => current?.id === application.id ? { ...current, webhookConfigured: true } : current); pushToast('GitLab Webhook 密钥已生成，仅在当前窗口展示一次'); } catch (error) { pushToast(error instanceof Error ? error.message : '无法生成 GitLab Webhook 配置', 'error'); } }} />
    <CompatibilityModal application={compatibility} onClose={() => setCompatibility(undefined)} onSaved={(application) => { setApplications((current) => current.map((item) => item.id === application.id ? application : item)); setSelected((current) => current?.id === application.id ? application : current); setCompatibility(undefined); pushToast('兼容性设置已保存，请重新部署应用'); }} />
    <Modal open={Boolean(pendingAction)} onClose={() => setPendingAction(undefined)} title={pendingAction ? actionTitle(pendingAction.type, pendingAction.application.name) : ''} width="480px" footer={(requestClose) => <><Button variant="ghost" onClick={requestClose}>取消</Button><Button variant={pendingAction?.type === 'delete' ? 'danger' : 'primary'} icon={pendingAction?.type === 'delete' ? <Trash2 size={16} /> : pendingAction?.type === 'rollback' ? <RotateCcw size={16} /> : pendingAction?.type === 'rebuild' ? <Rocket size={16} /> : <RefreshCw size={16} />} onClick={() => void confirmAction()}>{pendingAction?.type === 'delete' ? '删除应用' : '确认执行'}</Button></>}>
      <p className="confirm-copy">{pendingAction && actionDescription(pendingAction.type, pendingAction.application.name)}</p>
    </Modal>
  </div>;
}

function ApplicationRow({ application, onDeploy, onRedeploy, onRollback, onOpen, onDelete }: { application: HostedApplication; onDeploy: () => void; onRedeploy: () => void; onRollback: () => void; onOpen: () => void; onDelete: () => void }) {
  const routePath = application.routePath.endsWith('/') ? application.routePath : `${application.routePath}/`;
  const url = `http://${application.routeHost}${routePath}`;
  return <article className="hosting-app-row">
    <button className="hosting-app-row__main" onClick={onOpen}><span className="hosting-app-mark"><Rocket size={18} /></span><span><strong>{application.name}</strong><small><GitBranch size={12} />{application.repositoryUrl.replace(/^https?:\/\//, '')}<i />{application.gitRef}</small></span></button>
    <div className="hosting-app-target"><span>{application.namespace}</span><small>{application.replicas} 副本 · {application.containerPort}</small></div>
    <a className="hosting-route" href={url} target="_blank" rel="noreferrer" title={url}><span>{application.routePath}</span><ExternalLink size={14} /></a>
    <div className="hosting-app-build"><StatusPill status={application.latestBuild?.status === 'succeeded' ? '已发布' : application.latestBuild?.status === 'running' ? '构建中' : application.latestBuild?.status === 'failed' ? '失败' : '未部署'} /><small>{formatDate(application.latestBuild?.createdAt)}</small></div>
    <div className="hosting-app-actions"><IconButton label="重新发布已有镜像" onClick={onRedeploy}><RefreshCw size={16} /></IconButton><IconButton label="重新构建并部署" onClick={onDeploy}><Rocket size={16} /></IconButton><IconButton label="回滚上一版本" onClick={onRollback}><RotateCcw size={16} /></IconButton><IconButton label="删除应用" onClick={onDelete}><Trash2 size={16} /></IconButton></div>
  </article>;
}

function CreateApplicationModal({ open, clusters, credentials, capabilities, onClose, onCreated }: { open: boolean; clusters: Array<{ id: string; name: string }>; credentials: GitCredential[]; capabilities: HostingCapabilities; onClose: () => void; onCreated: (application: HostedApplication) => void }) {
  const { pushToast } = useToast(); const [value, setValue] = useState<CreateHostedApplicationPayload>(initialApplication); const [analysis, setAnalysis] = useState<AgentAnalysis>(); const [analyzing, setAnalyzing] = useState(false); const [submitting, setSubmitting] = useState(false); const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => { if (open) setValue((current) => ({ ...current, clusterId: current.clusterId || clusters[0]?.id || '', namespace: capabilities.allowedNamespaces.includes(current.namespace) ? current.namespace : capabilities.defaultNamespace })); }, [capabilities.allowedNamespaces, capabilities.defaultNamespace, clusters, open]);
  const set = <K extends keyof CreateHostedApplicationPayload>(key: K, next: CreateHostedApplicationPayload[K]) => setValue((current) => ({ ...current, [key]: next }));
  const runAnalysis = async () => {
    if (!value.repositoryUrl.trim()) { pushToast('请先输入 Git 仓库地址', 'error'); return; }
    setAnalyzing(true);
    try { const next = await api.analyzeHostedApplication(value.repositoryUrl.trim(), value.gitRef || 'main', value.credentialId, value.sourceSubdirectory); setAnalysis(next); setValue((current) => ({ ...current, buildMode: next.buildMode, containerPort: next.containerPort, healthPath: next.healthPath, agentAnalysis: next, agentReviewAcknowledged: false, routePath: current.routePath === '/' ? `/apps/${current.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : current.routePath })); } catch (error) { pushToast(error instanceof Error ? error.message : 'Agent 分析失败', 'error'); } finally { setAnalyzing(false); }
  };
  const submit = async () => {
    if (!value.name.trim() || !value.repositoryUrl.trim() || !value.clusterId || !value.routePath.trim()) { pushToast('请补齐应用名、仓库、集群与路由路径', 'error'); return false; }
    let currentAnalysis = analysis;
    if (!currentAnalysis) {
      setAnalyzing(true);
      try {
        currentAnalysis = await api.analyzeHostedApplication(value.repositoryUrl.trim(), value.gitRef || 'main', value.credentialId, value.sourceSubdirectory);
        setAnalysis(currentAnalysis);
      } catch (error) {
        pushToast(error instanceof Error ? error.message : 'Agent 分析失败', 'error');
        return false;
      } finally { setAnalyzing(false); }
    }
    const generatedRoute = value.routePath === '/' || value.routePath === '/apps/' ? `/apps/${value.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}` : value.routePath;
    if (currentAnalysis.requiresReview && !value.agentReviewAcknowledged) { pushToast('该项目包含有状态或持久化特征，请先确认风险提示', 'error'); return false; }
    setSubmitting(true); try { const application = await api.createHostedApplication({ ...value, routePath: generatedRoute, agentAnalysis: currentAnalysis, agentReviewAcknowledged: value.agentReviewAcknowledged, sourceSubdirectory: value.sourceSubdirectory || undefined, buildCommand: value.buildCommand || undefined, outputDirectory: value.outputDirectory || undefined }); onCreated(application); setValue(initialApplication()); setAnalysis(undefined); setAdvancedOpen(false); return true; } catch (error) { pushToast(error instanceof Error ? error.message : '创建应用失败', 'error'); return false; } finally { setSubmitting(false); }
  };
  return <Modal open={open} onClose={onClose} title="新建托管应用" description="输入仓库地址后由 Agent 读取项目证据并生成部署计划；环境变量仍由你明确控制。" width="1120px" className="modal--hosting" dirty={Boolean(value.name || value.repositoryUrl)} closeDisabled={submitting} onSave={submit} onDiscard={() => { setValue(initialApplication()); setAnalysis(undefined); setAdvancedOpen(false); }} footer={(requestClose) => <><Button variant="ghost" onClick={requestClose}>取消</Button><Button variant="primary" icon={<Rocket size={16} />} onClick={() => void submit()} disabled={submitting || analyzing || Boolean(analysis?.requiresReview && !value.agentReviewAcknowledged)}>{submitting ? '保存中' : analyzing ? '分析中' : '创建应用'}</Button></>}>
    <div className="hosting-form">
      <section><header><GitBranch size={17} /><div><strong>源码</strong><span>仓库、分支和凭证是用户需要提供的最小信息。</span></div></header><div className="form-grid"><label className="field"><span>应用名称</span><input value={value.name} onChange={(event) => set('name', event.target.value)} placeholder="orders-web" autoFocus /></label><label className="field"><span>分支或标签</span><input value={value.gitRef} onChange={(event) => { set('gitRef', event.target.value); setAnalysis(undefined); set('agentReviewAcknowledged', false); }} placeholder="main" /></label></div><label className="field hosting-form__repository"><span>Git 仓库地址</span><div className="hosting-agent-input"><input value={value.repositoryUrl} onChange={(event) => { set('repositoryUrl', event.target.value); setAnalysis(undefined); set('agentReviewAcknowledged', false); }} placeholder="https://github.com/denoland/celld.git" /><Button variant="secondary" icon={<Bot size={16} />} onClick={() => void runAnalysis()} disabled={analyzing}>{analyzing ? '分析中' : 'Agent 分析'}</Button></div></label><div className="form-grid"><div className="field"><span>Git 凭证</span><SelectMenu value={value.credentialId || ''} options={[{ value: '', label: '公开仓库，不使用凭证' }, ...credentials.map((credential) => ({ value: credential.id, label: `${credential.name} · ${credential.credentialType === 'ssh_key' ? 'SSH Key' : 'Access Token'}` }))]} onChange={(next) => { set('credentialId', next || undefined); setAnalysis(undefined); set('agentReviewAcknowledged', false); }} aria-label="Git 凭证" /></div></div></section>
      {analysis && <section className="hosting-agent-plan"><header><Bot size={17} /><div><strong>Agent 部署计划</strong><span>{analysis.framework} · 置信度 {Math.round(analysis.confidence * 100)}% · 证据：{analysis.evidence.join('、')}</span></div><CheckCircle2 size={18} /></header><div className="hosting-agent-plan__grid"><div><strong>构建</strong><span>{analysis.buildMode} · 端口 {analysis.containerPort} · 健康检查 {analysis.healthPath}</span></div><div><strong>运行特征</strong><span>{analysis.stateful ? '有状态' : '无状态'}{analysis.needsPersistentStorage ? ' · 需要持久化' : ''}{analysis.websocket ? ' · WebSocket' : ''}</span></div>{analysis.requiredEnvironment.length > 0 && <div><strong>必须补充的环境变量</strong><span>{analysis.requiredEnvironment.join('、')}</span></div>}{analysis.warnings.map((warning) => <div className="hosting-agent-plan__warning" key={warning}><AlertTriangle size={15} /><span>{warning}</span></div>)}{analysis.requiresReview && <label className="hosting-agent-review"><input type="checkbox" checked={Boolean(value.agentReviewAcknowledged)} onChange={(event) => set('agentReviewAcknowledged', event.target.checked)} /><span>我已阅读上述运行风险，并确认由我提供所需的存储、S3 或数据库环境变量。</span></label>}</div></section>}
      {analysis && <section className="hosting-agent-env"><label className="field"><span>运行环境变量（可选）</span><textarea rows={4} value={environmentText(value.runtimeEnvironment)} onChange={(event) => set('runtimeEnvironment', parseEnvironment(event.target.value))} placeholder={analysis.requiredEnvironment.length ? analysis.requiredEnvironment.map((name) => `${name}=...`).join('\n') : 'KEY=value'} spellCheck={false} /><small>Agent 只提出建议；这里的值由你提供并作为应用运行时约束。</small></label></section>}
      <section><header><PackageCheck size={17} /><div><strong>构建适配</strong><span>构建方式由 Agent 推断，只有兼容项需要手动指定。</span></div></header><div className="hosting-build-editor"><label className="field hosting-build-editor__environment"><span>构建环境变量（可选）</span><textarea rows={8} value={environmentText(value.buildEnvironment)} onChange={(event) => set('buildEnvironment', parseEnvironment(event.target.value))} placeholder="ONNXRUNTIME_NODE_INSTALL_CUDA=skip" spellCheck={false} /></label><div className="hosting-build-editor__settings"><label className="field hosting-switch-field"><span>Root 兼容</span><span className="hosting-switch-control"><small>允许官方入口完成必要的初始化。</small><input type="checkbox" checked={value.runtimeProfile === 'root_compatible'} onChange={(event) => set('runtimeProfile', event.target.checked ? 'root_compatible' : 'non_root')} /><i /></span></label><label className="field"><span>源码子目录（可选）</span><input value={value.sourceSubdirectory || ''} onChange={(event) => { set('sourceSubdirectory', event.target.value); setAnalysis(undefined); set('agentReviewAcknowledged', false); }} placeholder="apps/web" /></label></div></div><button type="button" className="hosting-advanced-toggle" onClick={() => setAdvancedOpen((current) => !current)} aria-expanded={advancedOpen}>{advancedOpen ? '收起高级适配' : '显示高级适配'}<small>仅在 Agent 无法确定项目入口时填写</small></button>{advancedOpen && <div className="hosting-advanced-fields"><label className="field"><span>构建命令</span><input value={value.buildCommand || ''} onChange={(event) => set('buildCommand', event.target.value)} placeholder="npm ci && npm run build" /></label><label className="field"><span>产物目录</span><input value={value.outputDirectory || ''} onChange={(event) => set('outputDirectory', event.target.value)} placeholder="dist" /></label></div>}</section>
      <section><header><Rocket size={17} /><div><strong>部署与访问</strong><span>平台仅生成 Deployment、Service 和 HTTPRoute。</span></div></header><div className="hosting-deployment-grid"><div className="field hosting-deployment-grid__cluster"><span>目标集群</span><SelectMenu value={value.clusterId} options={clusters.map((cluster) => ({ value: cluster.id, label: cluster.name }))} onChange={(next) => set('clusterId', next)} aria-label="目标集群" /></div>{capabilities.allowedNamespaces.length ? <div className="field hosting-deployment-grid__namespace"><span>命名空间</span><SelectMenu value={value.namespace} options={capabilities.allowedNamespaces.map((namespace) => ({ value: namespace, label: namespace }))} onChange={(next) => set('namespace', next)} aria-label="命名空间" /></div> : <label className="field hosting-deployment-grid__namespace"><span>命名空间</span><input value={value.namespace} onChange={(event) => set('namespace', event.target.value)} /></label>}<label className="field hosting-deployment-grid__route"><span>HTTPRoute Path</span><input value={value.routePath} onChange={(event) => set('routePath', event.target.value)} placeholder="/apps/orders-web" /></label><label className="field hosting-switch-field hosting-deployment-grid__auto-deploy"><span>启用自动部署</span><span className="hosting-switch-control"><small>分支推送时自动触发构建。</small><input type="checkbox" checked={value.autoDeploy} onChange={(event) => set('autoDeploy', event.target.checked)} /><i /></span></label></div></section>
    </div>
  </Modal>;
}

function CredentialsModal({ open, credentials, onClose, onChanged }: { open: boolean; credentials: GitCredential[]; onClose: () => void; onChanged: (value: GitCredential[]) => void }) {
  const { pushToast } = useToast(); const [form, setForm] = useState<CreateGitCredentialPayload>({ name: '', credentialType: 'token', username: 'oauth2', secret: '' }); const [saving, setSaving] = useState(false);
  const create = async () => { if (!form.name.trim() || !form.secret.trim()) { pushToast('请填写凭证名称和密钥内容', 'error'); return false; } setSaving(true); try { const credential = await api.createHostingCredential(form); onChanged([credential, ...credentials]); setForm({ name: '', credentialType: 'token', username: 'oauth2', secret: '' }); pushToast('Git 凭证已加密保存'); return true; } catch (error) { pushToast(error instanceof Error ? error.message : '保存 Git 凭证失败', 'error'); return false; } finally { setSaving(false); } };
  const remove = async (credential: GitCredential) => { try { await api.deleteHostingCredential(credential.id); onChanged(credentials.filter((item) => item.id !== credential.id)); pushToast('Git 凭证已删除'); } catch (error) { pushToast(error instanceof Error ? error.message : '无法删除 Git 凭证', 'error'); } };
  return <Modal open={open} onClose={onClose} title="Git 凭证" description="密钥不会返回到浏览器，只会在构建期间以短期租约提供给 Jenkins。" width="720px" dirty={Boolean(form.name || form.secret)} onSave={create} footer={(requestClose) => <><Button variant="ghost" onClick={requestClose}>关闭</Button><Button variant="primary" icon={<KeyRound size={16} />} onClick={() => void create()} disabled={saving}>{saving ? '保存中' : '保存凭证'}</Button></>}>
    <div className="credentials-modal"><div className="form-grid"><label className="field"><span>名称</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="GitLab project read-only" /></label><div className="field"><span>类型</span><SelectMenu value={form.credentialType} options={[{ value: 'token', label: 'Access Token' }, { value: 'ssh_key', label: 'SSH Deploy Key' }]} onChange={(credentialType) => setForm({ ...form, credentialType: credentialType as CreateGitCredentialPayload['credentialType'] })} aria-label="类型" /></div></div><label className="field"><span>用户名（Token 可选）</span><input value={form.username || ''} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="oauth2" /></label><label className="field"><span>{form.credentialType === 'ssh_key' ? '私钥内容' : 'Access Token'}</span><textarea value={form.secret} onChange={(event) => setForm({ ...form, secret: event.target.value })} rows={4} spellCheck={false} /></label><div className="credential-list">{credentials.map((credential) => <div key={credential.id}><span className="hosting-app-mark"><KeyRound size={16} /></span><div><strong>{credential.name}</strong><small>{credential.credentialType === 'ssh_key' ? 'SSH Deploy Key' : 'Access Token'} · {credential.username || '默认用户名'}</small></div><IconButton label={`删除 ${credential.name}`} onClick={() => void remove(credential)}><Trash2 size={16} /></IconButton></div>)}</div></div>
  </Modal>;
}

function CompatibilityModal({ application, onClose, onSaved }: { application?: HostedApplication; onClose: () => void; onSaved: (application: HostedApplication) => void }) {
  const { pushToast } = useToast();
  const [buildEnvironment, setBuildEnvironment] = useState('');
  const [runtimeEnvironment, setRuntimeEnvironment] = useState('');
  const [runtimeProfile, setRuntimeProfile] = useState<'non_root' | 'root_compatible'>('non_root');
  const [healthScheme, setHealthScheme] = useState<'HTTP' | 'HTTPS'>('HTTP');
  const [serviceScheme, setServiceScheme] = useState<'HTTP' | 'HTTPS'>('HTTP');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setBuildEnvironment(environmentText(application?.buildEnvironment || {}));
    setRuntimeEnvironment(environmentText(application?.runtimeEnvironment || {}));
    setRuntimeProfile(application?.runtimeProfile || 'non_root');
    setHealthScheme(application?.healthScheme || 'HTTP');
    setServiceScheme(application?.serviceScheme || 'HTTP');
  }, [application]);
  const save = async () => {
    if (!application) return false;
    const invalid = [buildEnvironment, runtimeEnvironment].some((environment) => environment.split('\n').filter(Boolean).some((line) => !/^[A-Z_][A-Z0-9_]*=.+$/.test(line.trim())));
    if (invalid) {
      pushToast('环境变量必须使用 KEY=value 格式', 'error');
      return false;
    }
    setSaving(true);
    try {
      onSaved(await api.updateHostedApplication(application.id, { buildEnvironment: parseEnvironment(buildEnvironment), runtimeEnvironment: parseEnvironment(runtimeEnvironment), runtimeProfile, healthScheme, serviceScheme }));
      return true;
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '无法保存兼容性设置', 'error');
      return false;
    } finally { setSaving(false); }
  };
  return <Modal open={Boolean(application)} onClose={onClose} title={`${application?.name || ''} · 兼容性`} description="构建参数只影响 Jenkins；运行参数会写入 Deployment，并可直接重新发布现有镜像。" width="720px" dirty={Boolean(buildEnvironment !== environmentText(application?.buildEnvironment || {}) || runtimeEnvironment !== environmentText(application?.runtimeEnvironment || {}) || runtimeProfile !== (application?.runtimeProfile || 'non_root') || healthScheme !== (application?.healthScheme || 'HTTP') || serviceScheme !== (application?.serviceScheme || 'HTTP'))} onSave={save} footer={(requestClose) => <><Button variant="ghost" onClick={requestClose}>取消</Button><Button variant="primary" icon={<Settings2 size={16} />} onClick={() => void save()} disabled={saving}>{saving ? '保存中' : '保存设置'}</Button></>}>
    <div className="hosting-compatibility"><label className="field"><span>构建环境变量</span><textarea rows={4} value={buildEnvironment} onChange={(event) => setBuildEnvironment(event.target.value)} placeholder="ONNXRUNTIME_NODE_INSTALL_CUDA=skip" spellCheck={false} /><small>每行一个 KEY=value。变量会注入 Dockerfile 的构建阶段。</small></label><label className="field"><span>运行环境变量</span><textarea rows={4} value={runtimeEnvironment} onChange={(event) => setRuntimeEnvironment(event.target.value)} placeholder="BYPASS_EMBEDDING_AND_RETRIEVAL=true" spellCheck={false} /><small>每行一个 KEY=value。变量会注入容器启动环境，修改后可直接重新发布已有镜像。</small></label><div className="form-grid"><div className="field"><span>运行兼容模式</span><SelectMenu value={runtimeProfile} options={[{ value: 'non_root', label: '默认非 root' }, { value: 'root_compatible', label: 'Root 兼容（受限）' }]} onChange={(value) => setRuntimeProfile(value as 'non_root' | 'root_compatible')} aria-label="运行兼容模式" /></div><div className="field"><span>健康检查协议</span><SelectMenu value={healthScheme} options={[{ value: 'HTTP', label: 'HTTP' }, { value: 'HTTPS', label: 'HTTPS' }]} onChange={(value) => setHealthScheme(value as 'HTTP' | 'HTTPS')} aria-label="健康检查协议" /></div><div className="field"><span>网关后端协议</span><SelectMenu value={serviceScheme} options={[{ value: 'HTTP', label: 'HTTP' }, { value: 'HTTPS', label: 'HTTPS' }]} onChange={(value) => setServiceScheme(value as 'HTTP' | 'HTTPS')} aria-label="网关后端协议" /></div></div><p className="confirm-copy">Root 兼容用于必须由官方入口以 root 完成初始化的上游镜像。它不会赋予 privileged 权限或 Linux capabilities。</p></div>
  </Modal>;
}

const buildStages = [
  { id: 'queued', label: '排队' },
  { id: 'source', label: '源码' },
  { id: 'checkout', label: '检出' },
  { id: 'build', label: '构建' },
  { id: 'push', label: '推送' },
  { id: 'deploy', label: '发布' },
] as const;

function ApplicationDetailDrawer({ application, onClose, onDeploy, onRedeploy, onConfigureCompatibility, onBuildsUpdated, webhook, onConfigureWebhook }: { application?: HostedApplication; onClose: () => void; onDeploy: (application: HostedApplication) => void; onRedeploy: (application: HostedApplication) => void; onConfigureCompatibility: (application: HostedApplication) => void; onBuildsUpdated: (applicationId: string, builds: ApplicationBuild[]) => void; webhook?: ApplicationWebhook; onConfigureWebhook: (application: HostedApplication) => Promise<void> }) {
  const { pushToast } = useToast();
  const [builds, setBuilds] = useState<ApplicationBuild[]>([]);
  const [loading, setLoading] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const activeBuild = builds[0] || application?.latestBuild;
  const refreshBuilds = useCallback(async (initial = false) => {
    if (!application) return;
    if (initial) setLoading(true);
    try {
      const next = await api.hostedApplicationBuilds(application.id);
      setBuilds(next);
      onBuildsUpdated(application.id, next);
    } catch (error) {
      if (initial) pushToast(error instanceof Error ? error.message : '无法读取构建记录', 'error');
    } finally {
      if (initial) setLoading(false);
    }
  }, [application, onBuildsUpdated, pushToast]);
  useEffect(() => {
    if (!application) { setBuilds([]); setClosing(false); return; }
    void refreshBuilds(true);
  }, [application, refreshBuilds]);
  useEffect(() => {
    if (!application || !['queued', 'running'].includes(activeBuild?.status || '')) return;
    const timer = window.setInterval(() => void refreshBuilds(), 3000);
    return () => window.clearInterval(timer);
  }, [activeBuild?.status, application, refreshBuilds]);
  useEffect(() => () => { if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current); }, []);
  const requestClose = useCallback(() => {
    if (!application || closing) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => { onClose(); setClosing(false); }, motionDuration(230));
  }, [application, closing, onClose]);
  useEscapeLayer(Boolean(application) && !closing, requestClose, 85);
  if (!application) return null;
  const routePath = application.routePath.endsWith('/') ? application.routePath : `${application.routePath}/`;
  const url = `http://${application.routeHost}${routePath}`;
  const progress = activeBuild?.progress || [];
  const progressByStage = new Map(progress.map((event) => [event.stage, event]));
  const completedCount = buildStages.filter((stage) => progressByStage.get(stage.id)?.state === 'succeeded').length;
  const failedEvent = progress.find((event) => event.state === 'failed');
  const progressPercent = activeBuild?.status === 'succeeded' ? 100 : activeBuild?.status === 'failed' ? Math.max(8, Math.round((completedCount / buildStages.length) * 100)) : Math.max(8, Math.round(((completedCount + (progress.some((event) => event.state === 'running') ? .5 : 0)) / buildStages.length) * 100));
  return createPortal(<><button className={`drawer-scrim ${closing ? 'is-closing' : ''}`} aria-label="关闭应用详情" onClick={requestClose} /><aside className={`hosting-detail-drawer glass-panel ${closing ? 'is-closing' : ''}`} aria-label={`${application.name} 应用详情`}><header className="hosting-detail-drawer__header"><div className="resource-identity"><span className="resource-kind-icon"><Rocket size={21} /></span><div><small>{application.clusterId} · {application.namespace} · {application.buildMode}</small><h2>{application.name}</h2></div></div><IconButton label="关闭详情" onClick={requestClose}><X size={18} /></IconButton></header><div className="hosting-detail-drawer__body"><section className="application-detail__route"><ArrowUpRight size={18} /><div><strong>{application.routeHost}{application.routePath}</strong><small>Gateway: {application.gatewayNamespace}/{application.gatewayName}</small></div><StatusPill status={activeBuild?.status === 'succeeded' ? '已发布' : activeBuild?.status === 'running' ? '构建中' : activeBuild?.status === 'failed' ? '失败' : activeBuild?.status || '未部署'} /></section><section className="hosting-build-progress"><header><div><h3>构建进度</h3><p>{activeBuild?.message || '等待构建任务'}</p></div><span>{progressPercent}%</span></header><div className={`hosting-build-progress__bar ${failedEvent ? 'is-failed' : ''}`}><i style={{ width: `${progressPercent}%` }} /></div><ol className="hosting-build-progress__stages">{buildStages.map((stage, index) => { const event = progressByStage.get(stage.id); const state = event?.state || (failedEvent && index > buildStages.findIndex((item) => item.id === failedEvent.stage) ? 'pending' : 'pending'); return <li key={stage.id} className={`is-${state}`}><span>{state === 'succeeded' ? <Check size={12} /> : state === 'running' ? <LoaderCircle className="spin" size={12} /> : state === 'failed' ? <AlertTriangle size={12} /> : <Circle size={10} />}</span><strong>{stage.label}</strong></li>; })}</ol></section><section className="hosting-build-log"><header><h3>简要日志</h3>{activeBuild?.jenkinsBuildUrl && <a href={activeBuild.jenkinsBuildUrl} target="_blank" rel="noreferrer">Jenkins <ExternalLink size={13} /></a>}</header>{loading ? <div className="detail-loading"><LoaderCircle className="spin" size={17} />加载构建记录</div> : <div className="hosting-build-log__events">{progress.length ? progress.slice().reverse().map((event) => <div key={`${event.stage}:${event.createdAt}`} className={`is-${event.state}`}><span>{event.state === 'succeeded' ? <Check size={13} /> : event.state === 'running' ? <LoaderCircle className="spin" size={13} /> : <AlertTriangle size={13} />}</span><div><strong>{buildStages.find((stage) => stage.id === event.stage)?.label || event.stage}</strong><small>{event.message}</small></div><time>{formatDate(event.createdAt)}</time></div>) : <span className="muted-cell">尚无阶段事件</span>}</div>}</section><section className="application-webhook"><header><div><Link2 size={16} /><span><strong>GitLab 自动部署</strong><small>{application.autoDeploy ? '匹配的分支或 Tag push 会触发构建。' : '请先在编辑应用时启用自动部署。'}</small></span></div><Button variant="secondary" icon={<KeyRound size={15} />} onClick={() => void onConfigureWebhook(application)}>{application.webhookConfigured ? '轮换密钥' : '生成 Webhook'}</Button></header>{webhook && <div className="application-webhook__secret"><label><span>Webhook URL</span><code>{webhook.url}</code></label><label><span>Secret Token（仅展示一次）</span><code>{webhook.secret}</code></label></div>}</section><section className="hosting-build-history"><h3>构建历史</h3><div className="build-history">{builds.length ? builds.map((build) => <article key={build.id}><StatusPill status={build.status === 'succeeded' ? '成功' : build.status === 'running' ? '构建中' : build.status === 'failed' ? '失败' : build.status} /><div><strong>{build.gitCommit ? build.gitCommit.slice(0, 12) : build.gitRef}</strong><small>{build.message || '等待 Jenkins 回传状态'}</small></div><time>{formatDate(build.createdAt)}</time>{build.jenkinsBuildUrl && <a href={build.jenkinsBuildUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /></a>}</article>) : <span className="muted-cell">尚无构建记录</span>}</div></section></div><footer className="hosting-detail-drawer__footer"><a className="button button--secondary" href={url} target="_blank" rel="noreferrer"><ExternalLink size={16} /><span>访问路由</span></a><Button variant="secondary" icon={<Settings2 size={16} />} onClick={() => onConfigureCompatibility(application)}>兼容性</Button><Button variant="secondary" icon={<RefreshCw size={16} />} onClick={() => onRedeploy(application)}>重新发布</Button><Button variant="primary" icon={<Rocket size={16} />} onClick={() => onDeploy(application)}>重新构建</Button></footer></aside></>, document.body);
}
