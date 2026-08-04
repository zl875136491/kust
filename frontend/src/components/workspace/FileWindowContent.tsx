import Editor from '@monaco-editor/react';
import { AlertCircle, ChevronRight, File, FileCode2, Folder, FolderOpen, FolderPlus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../../api';
import { useThemeMode } from '../../theme-context';
import type { FileEntry } from '../../types';
import { useWorkspaceWindows, type WorkspaceWindow, type WorkspaceWindowStatus } from '../../workspace-windows-context';
import { Button, EmptyState, IconButton, Modal, Spinner, useToast } from '../ui';

function editorLanguage(path: string) {
  const extension = path.split('.').pop()?.toLowerCase();
  if (extension === 'yaml' || extension === 'yml') return 'yaml';
  if (extension === 'json') return 'json';
  if (extension === 'sh' || extension === 'bash') return 'shell';
  if (extension === 'xml' || extension === 'html') return 'html';
  if (extension === 'css') return 'css';
  if (extension === 'js' || extension === 'jsx' || extension === 'mjs') return 'javascript';
  if (extension === 'ts' || extension === 'tsx') return 'typescript';
  if (extension === 'md') return 'markdown';
  return 'plaintext';
}

function formatBytes(bytes?: number) {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

function entryIcon(entry: FileEntry) {
  if (entry.kind === 'directory') return <Folder size={15} />;
  if (entry.kind === 'symlink') return <ChevronRight size={14} />;
  return entry.name.includes('.') ? <FileCode2 size={15} /> : <File size={15} />;
}

function requestStatus(error: unknown): { status: WorkspaceWindowStatus; message: string } {
  if (error instanceof ApiError && error.status === 404) return { status: 'missing', message: 'Pod 已被删除' };
  return { status: 'error', message: error instanceof Error ? error.message : '文件连接不可用' };
}

export function FileWindowContent({ item }: { item: WorkspaceWindow }) {
  const { resolved } = useThemeMode();
  const { pushToast } = useToast();
  const { registerLifecycle, setWindowDirty, setWindowStatus } = useWorkspaceWindows();
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const dirty = content !== savedContent;
  const selectedName = selectedPath?.split('/').filter(Boolean).pop();

  const handleRequestError = useCallback((requestError: unknown, fallback: string) => {
    const classified = requestStatus(requestError);
    setError(requestError instanceof Error ? requestError.message : fallback);
    setWindowStatus(item.id, classified.status, classified.message);
  }, [item.id, setWindowStatus]);

  const loadTree = useCallback(async (nextPath: string) => {
    setLoadingTree(true);
    setError(undefined);
    try {
      const response = await api.fileTree(item.clusterId, item.namespace, item.resourceName, nextPath, item.container);
      setPath(response.path);
      setEntries(response.entries);
      setWindowStatus(item.id, 'connected', '文件连接可用');
      return true;
    } catch (requestError) {
      handleRequestError(requestError, '无法读取目录');
      return false;
    } finally {
      setLoadingTree(false);
    }
  }, [handleRequestError, item.clusterId, item.container, item.id, item.namespace, item.resourceName, setWindowStatus]);

  useEffect(() => {
    if (!item.connectOnMount && item.connectionRevision === 0) return;
    setWindowStatus(item.id, item.connectionRevision > 0 ? 'reconnecting' : 'connecting', '正在连接 Pod 文件系统');
    void loadTree('/');
  }, [item.connectOnMount, item.connectionRevision, item.id, loadTree, setWindowStatus]);

  const openEntry = async (entry: FileEntry) => {
    if (entry.kind === 'directory') {
      setSelectedPath(undefined);
      setContent('');
      setSavedContent('');
      await loadTree(entry.path);
      return;
    }
    setSelectedPath(entry.path);
    setLoadingFile(true);
    setError(undefined);
    try {
      const response = await api.readFile(item.clusterId, item.namespace, item.resourceName, entry.path, item.container);
      setContent(response.content);
      setSavedContent(response.content);
      setWindowStatus(item.id, 'connected', '文件连接可用');
      if (response.truncated) pushToast('文件超过 4 MB，仅显示前 4 MB', 'info');
    } catch (requestError) {
      handleRequestError(requestError, '无法读取文件');
      setContent('');
      setSavedContent('');
    } finally {
      setLoadingFile(false);
    }
  };

  const saveFile = useCallback(async () => {
    if (!selectedPath || busy) return false;
    setBusy(true);
    try {
      await api.writeFile(item.clusterId, item.namespace, item.resourceName, selectedPath, content, item.container);
      setSavedContent(content);
      setWindowStatus(item.id, 'connected', '文件已保存');
      pushToast(`${selectedName || '文件'} 已保存`);
      return true;
    } catch (requestError) {
      handleRequestError(requestError, '保存文件失败');
      pushToast(requestError instanceof Error ? requestError.message : '保存文件失败', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy, content, handleRequestError, item.clusterId, item.container, item.id, item.namespace, item.resourceName, pushToast, selectedName, selectedPath, setWindowStatus]);

  useEffect(() => setWindowDirty(item.id, dirty), [dirty, item.id, setWindowDirty]);
  useEffect(() => registerLifecycle(item.id, {
    save: saveFile,
    discard: () => setContent(savedContent),
  }), [item.id, registerLifecycle, saveFile, savedContent]);

  const createFolder = async () => {
    const name = folderName.trim().replaceAll('/', '');
    if (!name || busy) return;
    setBusy(true);
    try {
      const folderPath = path === '/' ? `/${name}` : `${path}/${name}`;
      await api.makeDirectory(item.clusterId, item.namespace, item.resourceName, folderPath, item.container);
      pushToast(`目录 ${name} 已创建`);
      setFolderOpen(false);
      setFolderName('');
      await loadTree(path);
    } catch (requestError) {
      handleRequestError(requestError, '创建目录失败');
      pushToast(requestError instanceof Error ? requestError.message : '创建目录失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const deleteEntry = async () => {
    if (!selectedPath || busy) return;
    setBusy(true);
    try {
      await api.deleteFile(item.clusterId, item.namespace, item.resourceName, selectedPath, item.container);
      pushToast(`${selectedName || '资源'} 已删除`);
      setDeleteOpen(false);
      setSelectedPath(undefined);
      setContent('');
      setSavedContent('');
      await loadTree(path);
    } catch (requestError) {
      handleRequestError(requestError, '删除失败');
      pushToast(requestError instanceof Error ? requestError.message : '删除失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const breadcrumbs = useMemo(() => {
    const segments = path.split('/').filter(Boolean);
    return [{ label: '/', value: '/' }, ...segments.map((segment, index) => ({
      label: segment,
      value: `/${segments.slice(0, index + 1).join('/')}`,
    }))];
  }, [path]);

  return (
    <div className="workspace-tool file-manager workspace-file-manager">
      <div className="workspace-tool__toolbar file-manager__toolbar">
        <div className="file-breadcrumbs" aria-label="当前路径">
          {breadcrumbs.map((crumb, index) => <span key={crumb.value}>{index > 0 && <ChevronRight size={13} />}<button className={crumb.value === path ? 'is-current' : ''} onClick={() => void loadTree(crumb.value)}>{crumb.label}</button></span>)}
        </div>
        <div className="file-manager__actions">
          <IconButton label="刷新目录" onClick={() => void loadTree(path)}><RefreshCw size={16} /></IconButton>
          <Button variant="ghost" icon={<FolderPlus size={15} />} onClick={() => setFolderOpen(true)}>新建目录</Button>
          <Button variant="primary" icon={<Save size={15} />} onClick={() => void saveFile()} disabled={!selectedPath || !dirty || busy}>{busy ? '保存中' : '保存'}</Button>
          <IconButton label="删除选中项" onClick={() => setDeleteOpen(true)} disabled={!selectedPath || busy}><Trash2 size={16} /></IconButton>
        </div>
      </div>
      <div className="file-manager__body">
        <aside className="file-tree" aria-label="Pod 文件树">
          <div className="file-tree__head"><span>文件</span><small>{path}</small></div>
          {loadingTree ? <Spinner label="读取目录" /> : error && !entries.length ? <EmptyState icon={<AlertCircle size={20} />} title="目录不可用" body={error} /> : entries.length === 0 ? <EmptyState icon={<FolderOpen size={20} />} title="目录为空" /> : <div className="file-tree__list">
            {entries.map((entry) => <button key={entry.path} className={`file-tree-item ${selectedPath === entry.path ? 'is-selected' : ''}`} onClick={() => void openEntry(entry)}><span className="file-tree-item__icon">{entryIcon(entry)}</span><span className="file-tree-item__name">{entry.name}</span><small>{entry.kind === 'file' ? formatBytes(entry.size) : entry.kind === 'symlink' ? '链接' : '目录'}</small></button>)}
          </div>}
        </aside>
        <div className="monaco-editor-shell">
          <div className="monaco-editor-shell__head"><span>{selectedName || '选择文件以编辑'}</span>{selectedPath && <small>{editorLanguage(selectedPath)}{dirty ? ' · 未保存' : ''}</small>}</div>
          {loadingFile ? <Spinner label="读取文件" /> : selectedPath ? <Editor height="100%" theme={resolved === 'dark' ? 'vs-dark' : 'vs'} language={editorLanguage(selectedPath)} value={content} onChange={(value) => setContent(value ?? '')} options={{ automaticLayout: true, minimap: { enabled: false }, fontSize: 13, padding: { top: 12 }, wordWrap: 'on', tabSize: 2, smoothScrolling: true, renderLineHighlight: 'gutter' }} /> : <EmptyState icon={<FileCode2 size={22} />} title="选择一个文件" body="从左侧目录选择文件开始查看或编辑。" />}
        </div>
      </div>
      {error && entries.length > 0 && <div className="file-manager__error"><AlertCircle size={14} />{error}</div>}
      <Modal open={folderOpen} onClose={() => setFolderOpen(false)} title="新建目录" width="420px" priority={180} footer={<><Button variant="ghost" onClick={() => setFolderOpen(false)}>取消</Button><Button variant="primary" onClick={() => void createFolder()} disabled={!folderName.trim() || busy} icon={<FolderPlus size={15} />}>创建目录</Button></>}>
        <label className="field"><span>目录名称</span><input autoFocus value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="例如 config" onKeyDown={(event) => { if (event.key === 'Enter') void createFolder(); }} /></label>
      </Modal>
      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title={`删除 ${selectedName || '文件'}`} width="420px" priority={180} footer={<><Button variant="ghost" onClick={() => setDeleteOpen(false)}>取消</Button><Button variant="danger" onClick={() => void deleteEntry()} disabled={busy} icon={<Trash2 size={15} />}>{busy ? '删除中' : '确认删除'}</Button></>}>
        <p className="confirm-copy">{selectedName ? <><strong>{selectedName}</strong> 将从 Pod 中永久删除。</> : '请选择要删除的文件或目录。'}</p>
      </Modal>
    </div>
  );
}
