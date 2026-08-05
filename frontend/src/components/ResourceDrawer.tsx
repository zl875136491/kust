import { useQueryClient } from '@tanstack/react-query';
import { Braces, Copy, FileText, FolderOpen, Layers3, Logs, Scale, TerminalSquare, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { stringify } from 'yaml';
import { copyText } from '../browser-compat';
import { useData } from '../data-context';
import { motionDuration, useEscapeLayer } from '../hooks/useEscapeLayer';
import type { ResourceDescriptor, ResourceRow } from '../types';
import { useWorkspaceWindows } from '../workspace-windows-context';
import { Button, IconButton, Modal, StatusPill, UnsavedChangesPrompt, useToast } from './ui';

function yamlFor(row: ResourceRow) {
  return stringify({
    apiVersion: row.kind === 'Deployment' || row.kind === 'StatefulSet' || row.kind === 'DaemonSet' ? 'apps/v1' : 'v1',
    kind: row.kind,
    metadata: {
      name: row.name,
      ...(row.namespace ? { namespace: row.namespace } : {}),
      labels: row.labels,
    },
    ...(row.kind === 'Deployment' ? { spec: { replicas: Number(row.ready?.split('/')[1] || 1) } } : {}),
  });
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'object') return <pre>{JSON.stringify(value, null, 2)}</pre>;
  return String(value);
}

export function ResourceDrawer({
  clusterId,
  descriptor,
  row: sourceRow,
  onClose,
}: {
  clusterId: string;
  descriptor: ResourceDescriptor;
  row?: ResourceRow;
  onClose: () => void;
}) {
  const { clusters, deleteResource, getResourceYaml, scaleDeployment, applyYaml } = useData();
  const { windows, openWindow, setWindowStatus } = useWorkspaceWindows();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [tab, setTab] = useState<'overview' | 'yaml'>('overview');
  const [yaml, setYaml] = useState('');
  const [savedYaml, setSavedYaml] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [scaleOpen, setScaleOpen] = useState(false);
  const [unsavedOpen, setUnsavedOpen] = useState(false);
  const [replicas, setReplicas] = useState(1);
  const [savedReplicas, setSavedReplicas] = useState(1);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [localRow, setLocalRow] = useState<ResourceRow>();
  const closeTimer = useRef<number | undefined>(undefined);
  const row = localRow?.uid === sourceRow?.uid ? localRow : sourceRow;
  const dirty = yaml !== savedYaml;
  const podContainer = row?.kind === 'Pod' && Array.isArray(row.details.containers)
    ? String(row.details.containers[0] || '') || undefined
    : undefined;

  const beginClose = () => {
    if (closing) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(onClose, motionDuration(230));
  };
  const requestClose = () => {
    if (busy || closing) return;
    if (dirty) {
      setUnsavedOpen(true);
      return;
    }
    beginClose();
  };

  useEscapeLayer(Boolean(row) && !closing, requestClose, 60);

  useEffect(() => () => {
    if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (!sourceRow) {
      setLocalRow(undefined);
      return;
    }
    if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current);
    setClosing(false);
    setUnsavedOpen(false);
    setLocalRow(sourceRow);
    setTab('overview');
    const fallbackYaml = yamlFor(sourceRow);
    setYaml(fallbackYaml);
    setSavedYaml(fallbackYaml);
    let cancelled = false;
    void getResourceYaml(clusterId, descriptor.kind, sourceRow).then((resourceYaml) => {
      if (cancelled) return;
      setYaml((current) => current === fallbackYaml ? resourceYaml : current);
      setSavedYaml(resourceYaml);
    }).catch(() => undefined);
    const currentReplicas = Number(sourceRow.ready?.split('/')[1] || 1);
    setReplicas(currentReplicas);
    setSavedReplicas(currentReplicas);
    return () => { cancelled = true; };
  }, [clusterId, descriptor.kind, getResourceYaml, sourceRow]);

  const details = useMemo(() => Object.entries(row?.details || {}), [row]);
  if (!row) return null;

  const invalidate = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['resources', clusterId] }),
    queryClient.invalidateQueries({ queryKey: ['workloads', clusterId] }),
    queryClient.invalidateQueries({ queryKey: ['overview', clusterId] }),
  ]);
  const remove = async () => {
    setBusy(true);
    try {
      await deleteResource(clusterId, descriptor.kind, row);
      await invalidate();
      if (row.kind === 'Pod') {
        windows
          .filter((item) => item.clusterId === clusterId && item.namespace === row.namespace && item.resourceName === row.name)
          .forEach((item) => setWindowStatus(item.id, 'missing', 'Pod 已被删除'));
      }
      pushToast(`${row.kind}/${row.name} 已删除`);
      setDeleteOpen(false);
      beginClose();
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '删除资源失败', 'error');
    } finally { setBusy(false); }
  };
  const scaleResource = async () => {
    if (!row.namespace) return false;
    setBusy(true);
    try {
      const updatedRow = await scaleDeployment(clusterId, row.namespace, row.name, replicas);
      setLocalRow(updatedRow);
      let updatedYaml: string;
      try {
        updatedYaml = await getResourceYaml(clusterId, descriptor.kind, updatedRow);
      } catch {
        updatedYaml = yamlFor(updatedRow);
      }
      setYaml(updatedYaml);
      setSavedYaml(updatedYaml);
      setSavedReplicas(replicas);
      await invalidate();
      pushToast(`${row.name} 已扩缩容至 ${replicas}`);
      return true;
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '扩缩容失败', 'error');
      return false;
    } finally { setBusy(false); }
  };
  const applyChanges = async () => {
    setBusy(true);
    try {
      await applyYaml(clusterId, yaml, row.namespace);
      await invalidate();
      setSavedYaml(yaml);
      pushToast(`${row.kind}/${row.name} 已更新`);
      return true;
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '更新资源失败', 'error');
      return false;
    }
    finally { setBusy(false); }
  };
  const saveAndClose = async () => {
    if (await applyChanges()) {
      setUnsavedOpen(false);
      beginClose();
    }
  };
  const discardAndClose = () => {
    setYaml(savedYaml);
    setUnsavedOpen(false);
    beginClose();
  };
  const copyYaml = async () => {
    try {
      await copyText(yaml);
      pushToast('YAML 已复制');
    } catch {
      pushToast('浏览器未允许复制，请手动选中 YAML', 'error');
    }
  };

  return (
    <>
      <button className={`drawer-scrim ${closing ? 'is-closing' : ''}`} aria-label="关闭详情" onClick={requestClose} />
      <aside className={`resource-drawer glass-panel ${closing ? 'is-closing' : ''}`} aria-label={`${row.name} 详情`}>
        <header className="drawer__header">
          <div className="resource-identity"><span className="resource-kind-icon"><Layers3 size={20} /></span><div><small>{row.kind}</small><h2>{row.name}</h2></div></div>
          <IconButton label="关闭" onClick={requestClose} disabled={busy}><X size={18} /></IconButton>
        </header>
        <div className="drawer__status"><StatusPill status={row.status} />{row.namespace && <span>{row.namespace}</span>}{row.ready && <span>{row.ready} 就绪</span>}</div>
        <div className="drawer__actions">
          {row.kind === 'Pod' && row.namespace && <Button variant="secondary" aria-label="在窗口中查看日志" icon={<Logs size={16} />} onClick={() => openWindow({ type: 'logs', clusterId, clusterName: clusters.find((item) => item.id === clusterId)?.name, namespace: row.namespace!, resourceName: row.name, resourceUid: row.uid, container: podContainer })}>日志</Button>}
          {row.kind === 'Pod' && row.namespace && <Button variant="secondary" aria-label="在窗口中打开终端" icon={<TerminalSquare size={16} />} onClick={() => openWindow({ type: 'shell', clusterId, clusterName: clusters.find((item) => item.id === clusterId)?.name, namespace: row.namespace!, resourceName: row.name, resourceUid: row.uid, container: podContainer })}>终端</Button>}
          {row.kind === 'Pod' && row.namespace && <Button variant="secondary" aria-label="在窗口中打开文件" icon={<FolderOpen size={16} />} onClick={() => openWindow({ type: 'files', clusterId, clusterName: clusters.find((item) => item.id === clusterId)?.name, namespace: row.namespace!, resourceName: row.name, resourceUid: row.uid, container: podContainer })}>文件</Button>}
          {row.kind === 'Deployment' && <Button variant="secondary" aria-label="扩缩容" icon={<Scale size={16} />} onClick={() => { setReplicas(savedReplicas); setScaleOpen(true); }}>扩缩容</Button>}
          <Button variant="secondary" aria-label="复制 YAML" icon={<Copy size={16} />} onClick={() => void copyYaml()}>复制</Button>
          <Button variant="danger" aria-label="删除资源" icon={<Trash2 size={16} />} onClick={() => setDeleteOpen(true)}>删除</Button>
        </div>
        <div className="drawer-tabs" role="tablist">
          <button className={tab === 'overview' ? 'is-active' : ''} onClick={() => setTab('overview')}><FileText size={15} />概览</button>
          <button className={tab === 'yaml' ? 'is-active' : ''} onClick={() => setTab('yaml')}><Braces size={15} />YAML</button>
        </div>
        <div className="drawer__body">
          {tab === 'overview' && <>
            <section className="detail-section"><h3>元数据</h3><dl className="detail-grid detail-grid--metadata"><div><dt>名称</dt><dd>{row.name}</dd></div><div><dt>命名空间</dt><dd>{row.namespace || '-'}</dd></div><div><dt>UID</dt><dd className="mono-cell wrap-anywhere">{row.uid}</dd></div><div><dt>创建时间</dt><dd>{row.createdAt ? new Date(row.createdAt).toLocaleString('zh-CN') : '-'}</dd></div></dl></section>
            <section className="detail-section"><h3>标签</h3><div className="labels">{Object.entries(row.labels).map(([key, value]) => <span key={key}>{key}{value ? `=${value}` : ''}</span>)}{Object.keys(row.labels).length === 0 && <em>无</em>}</div></section>
            {details.length > 0 && <section className="detail-section"><h3>资源信息</h3><dl className="detail-grid detail-grid--resources">{details.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{displayValue(value)}</dd></div>)}</dl></section>}
          </>}
          {tab === 'yaml' && <div className="yaml-editor yaml-editor--drawer"><div className="yaml-editor__bar"><Braces size={14} /><span>{row.name}.yaml</span></div><textarea value={yaml} onChange={(event) => setYaml(event.target.value)} spellCheck={false} /><div className="yaml-editor__footer"><Button variant="primary" onClick={applyChanges} disabled={busy}>应用更改</Button></div></div>}
        </div>
      </aside>

      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title={`删除 ${row.name}`} width="440px" footer={<><Button variant="ghost" onClick={() => setDeleteOpen(false)}>取消</Button><Button variant="danger" onClick={remove} disabled={busy} icon={<Trash2 size={16} />}>{busy ? '删除中' : '确认删除'}</Button></>}>
        <p className="confirm-copy">资源 <strong>{row.kind}/{row.name}</strong> 将从集群中删除。</p>
      </Modal>
      <Modal
        open={scaleOpen}
        onClose={() => setScaleOpen(false)}
        title="扩缩容 Deployment"
        width="420px"
        dirty={replicas !== savedReplicas}
        closeDisabled={busy}
        onSave={scaleResource}
        onDiscard={() => setReplicas(savedReplicas)}
        footer={(requestScaleClose) => <><Button variant="ghost" onClick={requestScaleClose}>取消</Button><Button variant="primary" onClick={async () => { if (await scaleResource()) setScaleOpen(false); }} disabled={busy} icon={<Scale size={16} />}>{busy ? '更新中' : '更新副本数'}</Button></>}
      >
        <label className="field"><span>副本数</span><input type="number" min={0} max={10000} value={replicas} onChange={(event) => setReplicas(Number(event.target.value))} /></label>
      </Modal>
      <UnsavedChangesPrompt
        open={unsavedOpen}
        saving={busy}
        onContinue={() => setUnsavedOpen(false)}
        onDiscard={discardAndClose}
        onSave={() => void saveAndClose()}
      />
    </>
  );
}
