import { FileKey2, Plus, Server } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useData } from '../data-context';
import { Button, Modal, useToast } from './ui';

export function AddClusterModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { createCluster, mode } = useData();
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
    if (mode === 'live' && !kubeconfig.trim()) {
      pushToast('请提供 kubeconfig', 'error');
      return false;
    }
    setSubmitting(true);
    try {
      const cluster = await createCluster({ name: name.trim(), description, context: context || undefined, kubeconfig: kubeconfig || 'apiVersion: v1' });
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
        <label className="field"><span>Kubeconfig</span><div className="code-field"><FileKey2 size={17} /><textarea value={kubeconfig} onChange={(event) => setKubeconfig(event.target.value)} rows={12} spellCheck={false} placeholder={mode === 'demo' ? '演示模式可留空' : 'apiVersion: v1\nkind: Config\n...'} /></div></label>
      </form>
    </Modal>
  );
}
