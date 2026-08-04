import Editor from '@monaco-editor/react';
import {
  AlertCircle,
  ArrowLeft,
  ChevronRight,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  FolderPlus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Button, EmptyState, IconButton, Modal, Spinner, UnsavedChangesPrompt, useToast } from '../components/ui';
import { useData } from '../data-context';
import { motionDuration, useEscapeLayer } from '../hooks/useEscapeLayer';
import { useThemeMode } from '../theme-context';
import type { FileEntry } from '../types';

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

function entryIcon(entry: FileEntry, open: boolean) {
  if (entry.kind === 'directory') return open ? <FolderOpen size={15} /> : <Folder size={15} />;
  if (entry.kind === 'symlink') return <ChevronRight size={14} />;
  return entry.name.includes('.') ? <FileCode2 size={15} /> : <File size={15} />;
}

export function WebFilePage() {
  const { clusterId = '', namespace = '', pod = '' } = useParams();
  const [searchParams] = useSearchParams();
  const container = searchParams.get('container') || undefined;
  const navigate = useNavigate();
  const { clusters } = useData();
  const { resolved } = useThemeMode();
  const { pushToast } = useToast();
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
  const [unsavedOpen, setUnsavedOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const cluster = clusters.find((item) => item.id === clusterId);
  const dirty = content !== savedContent;
  const selectedName = selectedPath?.split('/').filter(Boolean).pop();

  const loadTree = useCallback(async (nextPath: string) => {
    setLoadingTree(true);
    setError(undefined);
    try {
      const response = await api.fileTree(clusterId, namespace, pod, nextPath, container);
      setPath(response.path);
      setEntries(response.entries);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '无法读取目录');
    } finally {
      setLoadingTree(false);
    }
  }, [clusterId, container, namespace, pod]);

  useEffect(() => {
    if (cluster) void loadTree('/');
  }, [cluster, loadTree]);

  const openEntry = async (entry: FileEntry) => {
    if (entry.kind === 'directory') {
      setSelectedPath(undefined);
      await loadTree(entry.path);
      return;
    }
    setSelectedPath(entry.path);
    setLoadingFile(true);
    setError(undefined);
    try {
      const response = await api.readFile(clusterId, namespace, pod, entry.path, container);
      setContent(response.content);
      setSavedContent(response.content);
      if (response.truncated) pushToast('文件超过 4 MB，仅显示前 4 MB', 'info');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '无法读取文件');
      setContent('');
      setSavedContent('');
    } finally {
      setLoadingFile(false);
    }
  };

  const saveFile = async () => {
    if (!selectedPath || busy) return false;
    setBusy(true);
    try {
      await api.writeFile(clusterId, namespace, pod, selectedPath, content, container);
      setSavedContent(content);
      pushToast(`${selectedName || '文件'} 已保存`);
      return true;
    } catch (requestError) {
      pushToast(requestError instanceof Error ? requestError.message : '保存文件失败', 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createFolder = async () => {
    const name = folderName.trim().replaceAll('/', '');
    if (!name || busy) return;
    setBusy(true);
    try {
      const folderPath = path === '/' ? `/${name}` : `${path}/${name}`;
      await api.makeDirectory(clusterId, namespace, pod, folderPath, container);
      pushToast(`目录 ${name} 已创建`);
      setFolderOpen(false);
      setFolderName('');
      await loadTree(path);
    } catch (requestError) {
      pushToast(requestError instanceof Error ? requestError.message : '创建目录失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const deleteEntry = async () => {
    if (!selectedPath || busy) return;
    setBusy(true);
    try {
      await api.deleteFile(clusterId, namespace, pod, selectedPath, container);
      pushToast(`${selectedName || '资源'} 已删除`);
      setDeleteOpen(false);
      setSelectedPath(undefined);
      setContent('');
      setSavedContent('');
      await loadTree(path);
    } catch (requestError) {
      pushToast(requestError instanceof Error ? requestError.message : '删除失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const beginClose = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => navigate(`/cluster/${clusterId}/resources/pods`), motionDuration(210));
  };
  const requestClose = () => {
    if (busy || closing) return;
    if (dirty) {
      setUnsavedOpen(true);
      return;
    }
    beginClose();
  };
  useEscapeLayer(!folderOpen && !deleteOpen && !unsavedOpen && !closing, requestClose, 60);

  const breadcrumbs = useMemo(() => {
    const segments = path.split('/').filter(Boolean);
    return [{ label: '/', value: '/' }, ...segments.map((segment, index) => ({
      label: segment,
      value: `/${segments.slice(0, index + 1).join('/')}`,
    }))];
  }, [path]);

  if (!cluster) return <div className="page"><EmptyState icon={<AlertCircle size={24} />} title="集群不存在" /></div>;

  return (
    <div className={`page pod-tool-page webfile-page ${closing ? 'is-closing' : ''}`}>
      <header className="page-header compact-page-header">
        <div>
          <span className="eyebrow">{namespace} / Pod</span>
          <h2><FileCode2 size={20} />{pod}</h2>
          <p className="page-subtitle">WebFile{container ? ` · ${container}` : ''}</p>
        </div>
        <div className="page-actions">
          <IconButton label="刷新目录" onClick={() => void loadTree(path)}><RefreshCw size={17} /></IconButton>
          <IconButton label="返回资源详情" onClick={requestClose}><ArrowLeft size={17} /></IconButton>
        </div>
      </header>
      <section className="pod-tool-surface glass-card file-manager">
        <div className="pod-tool-toolbar file-manager__toolbar">
          <div className="file-breadcrumbs" aria-label="当前路径">
            {breadcrumbs.map((crumb, index) => <span key={crumb.value}>
              {index > 0 && <ChevronRight size={13} />}
              <button className={crumb.value === path ? 'is-current' : ''} onClick={() => void loadTree(crumb.value)}>{crumb.label}</button>
            </span>)}
          </div>
          <div className="file-manager__actions">
            <Button variant="ghost" icon={<FolderPlus size={15} />} onClick={() => setFolderOpen(true)}>新建目录</Button>
            <Button variant="primary" icon={<Save size={15} />} onClick={() => void saveFile()} disabled={!selectedPath || !dirty || busy}>{busy ? '保存中' : '保存'}</Button>
            <IconButton label="删除选中项" onClick={() => setDeleteOpen(true)} disabled={!selectedPath || busy}><Trash2 size={16} /></IconButton>
          </div>
        </div>
        <div className="file-manager__body">
          <aside className="file-tree" aria-label="Pod 文件树">
            <div className="file-tree__head"><span>文件</span><small>{path}</small></div>
            {loadingTree ? <Spinner label="读取目录" /> : error && !entries.length ? <EmptyState icon={<AlertCircle size={20} />} title="目录不可用" body={error} /> : entries.length === 0 ? <EmptyState icon={<Folder size={20} />} title="目录为空" /> : <div className="file-tree__list">
              {entries.map((entry) => <button key={entry.path} className={`file-tree-item ${selectedPath === entry.path ? 'is-selected' : ''}`} onClick={() => void openEntry(entry)}>
                <span className="file-tree-item__icon">{entryIcon(entry, false)}</span><span className="file-tree-item__name">{entry.name}</span><small>{entry.kind === 'file' ? formatBytes(entry.size) : entry.kind === 'symlink' ? '链接' : '目录'}</small>
              </button>)}
            </div>}
          </aside>
          <div className="monaco-editor-shell">
            <div className="monaco-editor-shell__head"><span>{selectedName || '选择文件以编辑'}</span>{selectedPath && <small>{editorLanguage(selectedPath)}</small>}</div>
            {loadingFile ? <Spinner label="读取文件" /> : selectedPath ? <Editor
              height="100%"
              theme={resolved === 'dark' ? 'vs-dark' : 'vs'}
              language={editorLanguage(selectedPath)}
              value={content}
              onChange={(value) => setContent(value ?? '')}
              options={{ automaticLayout: true, minimap: { enabled: false }, fontSize: 12, padding: { top: 12 }, wordWrap: 'on', tabSize: 2, smoothScrolling: true, renderLineHighlight: 'gutter' }}
            /> : <EmptyState icon={<FileCode2 size={22} />} title="选择一个文件" body="从左侧目录选择文件开始查看或编辑。" />}
          </div>
        </div>
        {error && entries.length > 0 && <div className="file-manager__error"><AlertCircle size={14} />{error}</div>}
      </section>
      <Modal open={folderOpen} onClose={() => setFolderOpen(false)} title="新建目录" width="420px" footer={<><Button variant="ghost" onClick={() => setFolderOpen(false)}>取消</Button><Button variant="primary" onClick={() => void createFolder()} disabled={!folderName.trim() || busy} icon={<FolderPlus size={15} />}>创建目录</Button></>}>
        <label className="field"><span>目录名称</span><input autoFocus value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="例如 config" onKeyDown={(event) => { if (event.key === 'Enter') void createFolder(); }} /></label>
      </Modal>
      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} title={`删除 ${selectedName || '文件'}`} width="420px" footer={<><Button variant="ghost" onClick={() => setDeleteOpen(false)}>取消</Button><Button variant="danger" onClick={() => void deleteEntry()} disabled={busy} icon={<Trash2 size={15} />}>{busy ? '删除中' : '确认删除'}</Button></>}>
        <p className="confirm-copy">{selectedName ? <><strong>{selectedName}</strong> 将从 Pod 中永久删除。</> : '请选择要删除的文件或目录。'}</p>
      </Modal>
      <UnsavedChangesPrompt open={unsavedOpen} saving={busy} onContinue={() => setUnsavedOpen(false)} onDiscard={() => { setUnsavedOpen(false); beginClose(); }} onSave={() => void saveFile().then((saved) => { if (saved) { setUnsavedOpen(false); beginClose(); } })} />
    </div>
  );
}
