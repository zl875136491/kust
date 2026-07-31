import { Braces, Play } from 'lucide-react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useData } from '../data-context';
import type { Cluster } from '../types';
import { Button, Modal, useToast } from './ui';

const starterYaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: example
          image: nginx:1.27
          ports:
            - containerPort: 80
`;

export function YamlApplyModal({ cluster, open, onClose }: { cluster: Cluster; open: boolean; onClose: () => void }) {
  const { applyYaml } = useData();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [yaml, setYaml] = useState(starterYaml);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      const resource = await applyYaml(cluster.id, yaml);
      pushToast(`${resource.kind}/${resource.name} 已应用`);
      await queryClient.invalidateQueries({ queryKey: ['resources', cluster.id] });
      setYaml(starterYaml);
      return true;
    } catch (error) {
      pushToast(error instanceof Error ? error.message : '应用资源失败', 'error');
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="创建 / 应用资源"
      width="760px"
      dirty={yaml !== starterYaml}
      closeDisabled={submitting}
      onSave={submit}
      onDiscard={() => setYaml(starterYaml)}
      footer={(requestClose) => <><Button variant="ghost" onClick={requestClose}>取消</Button><Button variant="primary" onClick={async () => { if (await submit()) onClose(); }} disabled={submitting} icon={<Play size={16} />}>{submitting ? '应用中' : '应用'}</Button></>}
    >
      <div className="yaml-editor">
        <div className="yaml-editor__bar"><Braces size={15} /><span>manifest.yaml</span><small>{cluster.name}</small></div>
        <textarea value={yaml} onChange={(event) => setYaml(event.target.value)} spellCheck={false} aria-label="资源 YAML" />
      </div>
    </Modal>
  );
}
