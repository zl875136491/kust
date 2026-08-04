import { FileKey2, Plus, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../data-context';
import { Button, Modal, useToast } from './ui';
import type { Cluster } from '../types';

export function AddClusterModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { createCluster } = useData();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [context, setContext] = useState('');
  const [kubeconfig, setKubeconfig] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const dirty = Boolean(name || description || context || kubeconfig);

  const resetFields = () => {
    setName('');
    setDescription('');
    setContext('');
    setKubeconfig('');
  };
  const saveCluster = async () => {
    if (!name.trim()) {
      pushToast('请输入集群名称', 'error');
      return false;
    }
    if (!kubeconfig.trim()) {
      pushToast('请提供 kubeconfig', 'error');
      return false;
    }
    setSubmitting(true);
    try {
      const cluster = await createCluster({ name: name.trim(), description, context: context || undefined, kubeconfig });
      pushToast(`集群 ${cluster.name} 已添加`);
      resetFields();
      navigate(`/cluster/${cluster.id}`);
      return true;
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '添加集群失败', 'error');
      return false;
    } finally {
      setSubmitting(false);
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await saveCluster()) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="添加集群"
      width="680px"
      dirty={dirty}
      closeDisabled={submitting}
      onSave={saveCluster}
      onDiscard={resetFields}
      footer={(requestClose) => <><Button variant="ghost" onClick={requestClose}>取消</Button><Button variant="primary" type="submit" form="add-cluster-form" disabled={submitting} icon={<Plus size={17} />}>{submitting ? '连接中' : '添加集群'}</Button></>}
    >
      <form id="add-cluster-form" className="form-stack" onSubmit={submit}>
        <div className="form-grid">
          <label className="field"><span>名称</span><div className="input-wrap"><Server size={16} /><input value={name} onChange={(event) => setName(event.target.value)} placeholder="prod-shanghai" autoFocus /></div></label>
          <label className="field"><span>Context</span><input value={context} onChange={(event) => setContext(event.target.value)} placeholder="使用 current-context" /></label>
        </div>
        <label className="field"><span>描述</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="生产集群 · 华东区域" /></label>
        <label className="field"><span>Kubeconfig</span><div className="code-field"><FileKey2 size={17} /><textarea value={kubeconfig} onChange={(event) => setKubeconfig(event.target.value)} rows={12} spellCheck={false} placeholder={'apiVersion: v1\nkind: Config\n...'} /></div></label>
      </form>
    </Modal>
  );
}

export function EditClusterModal({ cluster, onClose }: { cluster?: Cluster; onClose: () => void }) {
  const { updateCluster } = useData();
  const { pushToast } = useToast();
  const [name, setName] = useState(cluster?.name || '');
  const [description, setDescription] = useState(cluster?.description || '');
  const [context, setContext] = useState(cluster?.context || '');
  const [kubeconfig, setKubeconfig] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const initial = `${cluster?.name || ''}\n${cluster?.description || ''}\n${cluster?.context || ''}`;
  const dirty = Boolean(cluster && (`${name}\n${description}\n${context}` !== initial || kubeconfig));
  useEffect(() => {
    setName(cluster?.name || ''); setDescription(cluster?.description || ''); setContext(cluster?.context || ''); setKubeconfig('');
  }, [cluster]);
  const save = async () => {
    if (!cluster || !name.trim()) return false;
    setSubmitting(true);
    try {
      await updateCluster(cluster.id, { name: name.trim(), description, context: context.trim() || undefined, kubeconfig: kubeconfig.trim() || undefined });
      pushToast(`集群 ${name.trim()} 已更新`); return true;
    } catch (error) { pushToast(error instanceof Error ? error.message : '更新集群失败', 'error'); return false; }
    finally { setSubmitting(false); }
  };
  const submit = async (event: React.FormEvent) => { event.preventDefault(); if (await save()) onClose(); };
  return <Modal open={Boolean(cluster)} onClose={onClose} title={`编辑 ${cluster?.name || ''}`} width="680px" dirty={dirty} closeDisabled={submitting} onSave={save} footer={(requestClose) => <><Button variant="ghost" onClick={requestClose}>取消</Button><Button variant="primary" type="submit" form="edit-cluster-form" disabled={submitting}>{submitting ? '验证中' : '保存更改'}</Button></>}>
    <form id="edit-cluster-form" className="form-stack" onSubmit={submit}><div className="form-grid"><label className="field"><span>名称</span><div className="input-wrap"><Server size={16} /><input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></div></label><label className="field"><span>Context</span><input value={context} onChange={(event) => setContext(event.target.value)} /></label></div><label className="field"><span>描述</span><input value={description} onChange={(event) => setDescription(event.target.value)} /></label><label className="field"><span>替换 Kubeconfig（可选）</span><div className="code-field"><FileKey2 size={17} /><textarea value={kubeconfig} onChange={(event) => setKubeconfig(event.target.value)} rows={10} spellCheck={false} placeholder="留空则保留现有凭据" /></div></label></form>
  </Modal>;
}
