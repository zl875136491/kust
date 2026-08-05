import Editor from '@monaco-editor/react';
import { AlertCircle, Braces, Download, Save } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { parseDocument } from 'yaml';
import { api } from '../../api';
import { useThemeMode } from '../../theme-context';
import { useWorkspaceWindows, type WorkspaceWindow } from '../../workspace-windows-context';
import { Button, useToast } from '../ui';

function downloadYaml(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/yaml;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${name.replaceAll(' ', '-')}.yaml`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ResourceEditorWindowContent({ item }: { item: WorkspaceWindow }) {
  const { resolved } = useThemeMode();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const { registerLifecycle, setWindowDirty, setWindowStatus, updateWindow } = useWorkspaceWindows();
  const initialContent = item.editorContent || '';
  const [content, setContent] = useState(initialContent);
  const [savedContent, setSavedContent] = useState(item.editorSavedContent ?? initialContent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dirty = content !== savedContent;

  const save = useCallback(async () => {
    if (busy) return false;
    const document = parseDocument(content);
    if (document.errors.length) {
      const message = document.errors[0]?.message || 'YAML 格式无效';
      setError(message);
      pushToast(message, 'error');
      return false;
    }
    setBusy(true);
    setError(undefined);
    try {
      const resource = await api.applyYaml(item.clusterId, content, item.namespace === '_' ? undefined : item.namespace);
      setSavedContent(content);
      setWindowDirty(item.id, false);
      setWindowStatus(item.id, 'connected', `${resource.kind}/${resource.name} 已应用`);
      updateWindow(item.id, {
        resourceName: resource.name,
        namespace: resource.namespace || '_',
        editorMode: 'edit',
        editorKind: resource.kind.toLowerCase(),
        editorContent: content,
        editorSavedContent: content,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['resources', item.clusterId] }),
        queryClient.invalidateQueries({ queryKey: ['workloads', item.clusterId] }),
        queryClient.invalidateQueries({ queryKey: ['overview', item.clusterId] }),
      ]);
      pushToast(`${resource.kind}/${resource.name} 已应用`);
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '应用资源失败';
      setError(message);
      pushToast(message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy, content, item.clusterId, item.id, item.namespace, pushToast, queryClient, setWindowDirty, setWindowStatus, updateWindow]);

  useEffect(() => setWindowDirty(item.id, dirty), [dirty, item.id, setWindowDirty]);
  useEffect(() => {
    const timer = window.setTimeout(() => updateWindow(item.id, {
      editorContent: content,
      editorSavedContent: savedContent,
    }), 180);
    return () => window.clearTimeout(timer);
  }, [content, item.id, savedContent, updateWindow]);
  useEffect(() => registerLifecycle(item.id, {
    save,
    discard: () => setContent(savedContent),
  }), [item.id, registerLifecycle, save, savedContent]);

  return <div className="workspace-tool resource-editor-window">
    <div className="workspace-tool__toolbar resource-editor-toolbar">
      <span><Braces size={15} />{item.editorMode === 'create' ? '新建资源' : `编辑 ${item.editorKind || '资源'}`}</span>
      <small>{item.clusterName || item.clusterId} · {item.namespace === '_' ? '集群级' : item.namespace}{dirty ? ' · 未保存' : ''}</small>
      <div className="resource-editor-toolbar__actions">
        <Button variant="ghost" icon={<Download size={15} />} onClick={() => downloadYaml(item.resourceName, content)}>下载</Button>
        <Button variant="primary" icon={<Save size={15} />} onClick={() => void save()} disabled={(item.editorMode !== 'create' && !dirty) || busy}>{busy ? '应用中' : '应用'}</Button>
      </div>
    </div>
    {error && <div className="resource-editor-error"><AlertCircle size={14} /><span>{error}</span></div>}
    <div className="resource-editor-monaco">
      <Editor
        height="100%"
        theme={resolved === 'dark' ? 'vs-dark' : 'vs'}
        language="yaml"
        value={content}
        onChange={(value) => setContent(value ?? '')}
        options={{ automaticLayout: true, minimap: { enabled: true }, fontSize: 13, lineHeight: 21, padding: { top: 14 }, wordWrap: 'on', tabSize: 2, insertSpaces: true, smoothScrolling: true, renderLineHighlight: 'all', scrollBeyondLastLine: false }}
      />
    </div>
  </div>;
}
