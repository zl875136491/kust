import {
  AlertTriangle,
  FileCode2,
  FileWarning,
  FolderOpen,
  LoaderCircle,
  Logs,
  Maximize2,
  Minimize2,
  Minus,
  RotateCw,
  TerminalSquare,
  WifiOff,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Rnd } from 'react-rnd';
import { type WorkspaceWindow, type WorkspaceWindowStatus, type WorkspaceWindowType, useWorkspaceWindows } from '../workspace-windows-context';
import { FileWindowContent } from './workspace/FileWindowContent';
import { LogsWindowContent } from './workspace/LogsWindowContent';
import { ResourceEditorWindowContent } from './workspace/ResourceEditorWindowContent';
import { ShellWindowContent } from './workspace/ShellWindowContent';
import { Button, IconButton } from './ui';

const typeLabels: Record<WorkspaceWindowType, string> = { shell: '终端', files: '文件', logs: '日志', editor: 'YAML' };
const statusLabels: Record<WorkspaceWindowStatus, string> = {
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  disconnected: '已断开',
  error: '连接异常',
  missing: '资源已删除',
};

function TypeIcon({ type, size = 16 }: { type: WorkspaceWindowType; size?: number }) {
  if (type === 'shell') return <TerminalSquare size={size} />;
  if (type === 'files') return <FolderOpen size={size} />;
  if (type === 'editor') return <FileCode2 size={size} />;
  return <Logs size={size} />;
}

function WindowContent({ item }: { item: WorkspaceWindow }) {
  if (item.type === 'shell') return <ShellWindowContent item={item} />;
  if (item.type === 'files') return <FileWindowContent item={item} />;
  if (item.type === 'editor') return <ResourceEditorWindowContent item={item} />;
  return <LogsWindowContent item={item} />;
}

function statusLabel(item: WorkspaceWindow) {
  return item.type === 'editor' && item.status === 'connected' ? '已打开' : statusLabels[item.status];
}

function ConnectionState({ item }: { item: WorkspaceWindow }) {
  const { reconnectWindow, removeWindow } = useWorkspaceWindows();
  if (item.type === 'editor') return null;
  if (!['disconnected', 'error', 'missing'].includes(item.status)) return null;
  const missing = item.status === 'missing';
  return (
    <div className={`workspace-window-state ${missing ? 'is-missing' : ''}`} role="status">
      <span className="workspace-window-state__icon">{missing ? <b>F</b> : item.status === 'error' ? <AlertTriangle size={23} /> : <WifiOff size={23} />}</span>
      <strong>{statusLabels[item.status]}</strong>
      <p>{item.statusMessage || (missing ? '该 Pod 已不存在，窗口无法重新连接。' : '连接已经中断，可以保留窗口并稍后重试。')}</p>
      {missing
        ? <Button variant="danger" icon={<FileWarning size={16} />} onClick={() => removeWindow(item.id)}>移除窗口</Button>
        : <Button variant="primary" icon={<RotateCw size={16} />} onClick={() => reconnectWindow(item.id)}>重新连接</Button>}
    </div>
  );
}

function TaskAction({ item }: { item: WorkspaceWindow }) {
  const { reconnectWindow, removeWindow, requestClose } = useWorkspaceWindows();
  if (item.status === 'missing') {
    return <button className="workspace-task__failure" aria-label={`移除已删除的 ${item.resourceName}`} title="资源已删除，点击移除" onClick={() => removeWindow(item.id)}>F</button>;
  }
  if (item.type !== 'editor' && (item.status === 'disconnected' || item.status === 'error')) {
    return <IconButton className="workspace-task__action" label={`重新连接${typeLabels[item.type]} ${item.resourceName}`} onClick={() => reconnectWindow(item.id)}><RotateCw size={15} /></IconButton>;
  }
  if (item.status === 'connecting' || item.status === 'reconnecting') {
    return <span className="workspace-task__progress" role="status" title={statusLabels[item.status]}><LoaderCircle className="spin" size={15} /></span>;
  }
  return <IconButton className="workspace-task__action" label={`关闭${typeLabels[item.type]}窗口 ${item.resourceName}`} onClick={() => requestClose(item.id)}><X size={15} /></IconButton>;
}

export function WorkspaceDesktop() {
  const {
    windows,
    fitWindowsToWorkspace,
    focusWindow,
    minimizeWindow,
    requestClose,
    restoreWindow,
    toggleMaximized,
    updateWindowBounds,
  } = useWorkspaceWindows();
  const layerRef = useRef<HTMLDivElement>(null);
  const [workspaceSize, setWorkspaceSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const measure = () => {
      const size = { width: layer.clientWidth, height: layer.clientHeight };
      setWorkspaceSize(size);
      fitWindowsToWorkspace(size.width, size.height);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    measure();
    return () => observer.disconnect();
  }, [fitWindowsToWorkspace]);

  useEffect(() => {
    if (!workspaceSize.width || !workspaceSize.height) return;
    fitWindowsToWorkspace(workspaceSize.width, workspaceSize.height);
  }, [fitWindowsToWorkspace, windows.length, workspaceSize.height, workspaceSize.width]);

  const orderedTasks = useMemo(() => [...windows].sort((left, right) => left.createdAt - right.createdAt), [windows]);

  return <>
    <div className="workspace-window-layer" ref={layerRef} aria-label="工作区窗口">
      {windows.map((item) => (
        <Rnd
          key={item.id}
          className={`workspace-window ${item.minimized ? 'is-minimized' : ''} ${item.maximized ? 'is-maximized' : ''}`}
          bounds="parent"
          dragHandleClassName="workspace-window__titlebar"
          cancel=".workspace-window__controls"
          disableDragging={item.maximized || item.minimized}
          enableResizing={!item.maximized && !item.minimized}
          minWidth={Math.min(460, workspaceSize.width || 460)}
          minHeight={Math.min(320, workspaceSize.height || 320)}
          size={{ width: item.bounds.width, height: item.bounds.height }}
          position={{ x: item.bounds.x, y: item.bounds.y }}
          style={{ zIndex: item.zIndex }}
          onMouseDown={() => focusWindow(item.id)}
          onDragStart={() => focusWindow(item.id)}
          onDragStop={(_event, data) => updateWindowBounds(item.id, { ...item.bounds, x: data.x, y: data.y })}
          onResizeStart={() => focusWindow(item.id)}
          onResizeStop={(_event, _direction, element, _delta, position) => updateWindowBounds(item.id, {
            x: position.x,
            y: position.y,
            width: element.offsetWidth,
            height: element.offsetHeight,
          })}
        >
          <section className="workspace-window__surface" aria-label={`${item.resourceName} ${typeLabels[item.type]}窗口`}>
            <header className="workspace-window__titlebar">
              <span className={`workspace-window__type workspace-window__type--${item.type}`}><TypeIcon type={item.type} /></span>
              <div className="workspace-window__identity">
                <strong>{item.resourceName}</strong>
                <span>{typeLabels[item.type]} · {item.type === 'editor' ? `${item.editorMode === 'create' ? '新建' : '编辑'} · ${item.namespace}` : `${item.namespace}${item.container ? ` / ${item.container}` : ''}`}</span>
              </div>
              <span className={`workspace-window__status is-${item.status}`} title={item.statusMessage || statusLabel(item)}>
                {(item.status === 'connecting' || item.status === 'reconnecting') && <LoaderCircle className="spin" size={13} />}
                <i />{statusLabel(item)}{item.dirty && <em>未保存</em>}
              </span>
              <div className="workspace-window__controls">
                <IconButton label="最小化" onClick={() => minimizeWindow(item.id)}><Minus size={16} /></IconButton>
                <IconButton label={item.maximized ? '还原窗口' : '最大化'} onClick={() => toggleMaximized(item.id, workspaceSize.width, workspaceSize.height)}>{item.maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</IconButton>
                <IconButton label="关闭窗口" onClick={() => requestClose(item.id)}><X size={16} /></IconButton>
              </div>
            </header>
            <div className={`workspace-window__body workspace-window__body--${item.type}`}><WindowContent item={item} /><ConnectionState item={item} /></div>
          </section>
        </Rnd>
      ))}
    </div>
    {orderedTasks.length > 0 && <footer className="workspace-taskbar glass-panel" aria-label="窗口任务栏">
      <div className="workspace-taskbar__list">
        {orderedTasks.map((item) => <div key={item.id} className={`workspace-task ${item.minimized ? 'is-minimized' : ''} is-${item.status}`}>
          <button className="workspace-task__main" aria-label={`${typeLabels[item.type]} ${item.resourceName}`} title={`${item.resourceName} · ${typeLabels[item.type]} · ${statusLabel(item)}`} onClick={() => item.minimized ? restoreWindow(item.id) : focusWindow(item.id)}>
            <span className={`workspace-task__type workspace-window__type--${item.type}`}><TypeIcon type={item.type} size={15} /></span>
            <span className="workspace-task__name">{item.resourceName}</span>
            {item.dirty && <i className="workspace-task__dirty" title="有未保存的更改" />}
          </button>
          <TaskAction item={item} />
        </div>)}
      </div>
    </footer>}
  </>;
}
