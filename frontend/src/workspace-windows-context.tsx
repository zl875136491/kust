/* eslint-disable react-refresh/only-export-components */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, UnsavedChangesPrompt, useToast } from './components/ui';
import { useAuth } from './auth-context';
import { createClientId } from './browser-compat';
import { usePreferences } from './preferences-context';

export type WorkspaceWindowType = 'shell' | 'files' | 'logs';
export type WorkspaceWindowStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error' | 'missing';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OpenWorkspaceWindow {
  type: WorkspaceWindowType;
  clusterId: string;
  clusterName?: string;
  namespace: string;
  resourceName: string;
  resourceUid?: string;
  container?: string;
}

export interface WorkspaceWindow extends OpenWorkspaceWindow {
  id: string;
  status: WorkspaceWindowStatus;
  statusMessage?: string;
  minimized: boolean;
  maximized: boolean;
  bounds: WindowBounds;
  restoreBounds?: WindowBounds;
  zIndex: number;
  dirty: boolean;
  connectOnMount: boolean;
  connectionRevision: number;
  createdAt: number;
}

interface WindowLifecycle {
  save?: () => Promise<boolean>;
  discard?: () => void;
}

interface WorkspaceWindowsContextValue {
  windows: WorkspaceWindow[];
  openWindow: (input: OpenWorkspaceWindow) => string;
  requestClose: (id: string) => void;
  removeWindow: (id: string) => void;
  focusWindow: (id: string) => void;
  minimizeWindow: (id: string) => void;
  restoreWindow: (id: string) => void;
  reconnectWindow: (id: string) => void;
  setWindowStatus: (id: string, status: WorkspaceWindowStatus, message?: string) => void;
  setWindowDirty: (id: string, dirty: boolean) => void;
  updateWindowBounds: (id: string, bounds: WindowBounds) => void;
  toggleMaximized: (id: string, workspaceWidth: number, workspaceHeight: number) => void;
  fitWindowsToWorkspace: (workspaceWidth: number, workspaceHeight: number) => void;
  registerLifecycle: (id: string, lifecycle: WindowLifecycle) => () => void;
}

const WorkspaceWindowsContext = createContext<WorkspaceWindowsContextValue | null>(null);
const STORAGE_VERSION = 1;

type PersistedWorkspaceWindow = Omit<WorkspaceWindow, 'status' | 'statusMessage' | 'dirty' | 'connectOnMount' | 'connectionRevision'>;

function storageKey(userId?: string) {
  return userId ? `kust-workspace-windows:${userId}` : undefined;
}

function restoredWindows(userId?: string): WorkspaceWindow[] {
  const key = storageKey(userId);
  if (!key) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '') as { version?: number; windows?: PersistedWorkspaceWindow[] };
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.windows)) return [];
    const restored = parsed.windows.flatMap((item) => {
      if (!item?.id || !['shell', 'files', 'logs'].includes(item.type) || !item.clusterId || !item.namespace || !item.resourceName) return [];
      const bounds = item.bounds;
      if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return [];
      return [{
        ...item,
        status: 'disconnected' as const,
        statusMessage: '页面刷新后连接已断开',
        dirty: false,
        connectOnMount: false,
        connectionRevision: 0,
      }];
    });
    return restored.filter((item, index) => restored.findIndex((candidate) => sameTarget(candidate, item)) === index);
  } catch {
    return [];
  }
}

function defaultBounds(type: WorkspaceWindowType, offset: number): WindowBounds {
  const availableWidth = Math.max(320, window.innerWidth - 290);
  const availableHeight = Math.max(300, window.innerHeight - 150);
  const preferred = type === 'files' ? { width: 1040, height: 680 } : { width: 900, height: 560 };
  const width = Math.min(preferred.width, Math.max(320, availableWidth - 28));
  const height = Math.min(preferred.height, Math.max(300, availableHeight - 24));
  const cascade = (offset * 28) % 168;
  return {
    x: Math.min(18 + cascade, Math.max(0, availableWidth - width)),
    y: Math.min(14 + cascade, Math.max(0, availableHeight - height)),
    width,
    height,
  };
}

function sameTarget(left: OpenWorkspaceWindow, right: OpenWorkspaceWindow) {
  return left.type === right.type
    && left.clusterId === right.clusterId
    && left.namespace === right.namespace
    && left.resourceName === right.resourceName
    && left.container === right.container;
}

export function WorkspaceWindowsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { settings } = usePreferences();
  const { pushToast } = useToast();
  const [windows, setWindows] = useState<WorkspaceWindow[]>(() => restoredWindows(user?.id));
  const [closeRequest, setCloseRequest] = useState<{ id: string; dirty: boolean }>();
  const windowsRef = useRef(windows);
  const lifecycleRef = useRef(new Map<string, WindowLifecycle>());
  const zIndexRef = useRef(Math.max(100, ...windows.map((item) => item.zIndex)));
  windowsRef.current = windows;

  useEffect(() => {
    const key = storageKey(user?.id);
    if (!key) return;
    const persisted: PersistedWorkspaceWindow[] = windows.map((item) => ({
      id: item.id,
      type: item.type,
      clusterId: item.clusterId,
      clusterName: item.clusterName,
      namespace: item.namespace,
      resourceName: item.resourceName,
      resourceUid: item.resourceUid,
      container: item.container,
      minimized: item.minimized,
      maximized: item.maximized,
      bounds: item.bounds,
      restoreBounds: item.restoreBounds,
      zIndex: item.zIndex,
      createdAt: item.createdAt,
    }));
    localStorage.setItem(key, JSON.stringify({ version: STORAGE_VERSION, windows: persisted }));
  }, [user?.id, windows]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!windowsRef.current.some((item) => item.dirty)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, []);

  const nextZIndex = useCallback(() => {
    zIndexRef.current += 1;
    return zIndexRef.current;
  }, []);

  const removeWindow = useCallback((id: string) => {
    lifecycleRef.current.delete(id);
    setWindows((current) => current.filter((item) => item.id !== id));
    setCloseRequest((current) => current?.id === id ? undefined : current);
  }, []);

  const focusWindow = useCallback((id: string) => {
    const zIndex = nextZIndex();
    setWindows((current) => current.map((item) => item.id === id ? { ...item, zIndex } : item));
  }, [nextZIndex]);

  const restoreWindow = useCallback((id: string) => {
    const zIndex = nextZIndex();
    setWindows((current) => current.map((item) => item.id === id ? { ...item, minimized: false, zIndex } : item));
  }, [nextZIndex]);

  const openWindow = useCallback((input: OpenWorkspaceWindow) => {
    const existing = windowsRef.current.find((item) => sameTarget(item, input));
    if (existing) {
      restoreWindow(existing.id);
      return existing.id;
    }
    const id = createClientId();
    const item: WorkspaceWindow = {
      ...input,
      id,
      status: 'connecting',
      minimized: false,
      maximized: false,
      bounds: defaultBounds(input.type, windowsRef.current.length),
      zIndex: nextZIndex(),
      dirty: false,
      connectOnMount: true,
      connectionRevision: 0,
      createdAt: Date.now(),
    };
    windowsRef.current = [...windowsRef.current, item];
    setWindows((current) => current.some((candidate) => sameTarget(candidate, input)) ? current : [...current, item]);
    return id;
  }, [nextZIndex, restoreWindow]);

  const requestClose = useCallback((id: string) => {
    const item = windowsRef.current.find((candidate) => candidate.id === id);
    if (!item) return;
    if (item.dirty) {
      setCloseRequest({ id, dirty: true });
      return;
    }
    if (settings?.windowCloseConfirmation ?? true) {
      setCloseRequest({ id, dirty: false });
      return;
    }
    removeWindow(id);
  }, [removeWindow, settings?.windowCloseConfirmation]);

  const minimizeWindow = useCallback((id: string) => {
    setWindows((current) => current.map((item) => item.id === id ? { ...item, minimized: true } : item));
  }, []);

  const reconnectWindow = useCallback((id: string) => {
    const zIndex = nextZIndex();
    setWindows((current) => current.map((item) => item.id === id && item.status !== 'missing' ? {
      ...item,
      minimized: false,
      status: 'reconnecting',
      statusMessage: '正在重新建立连接',
      connectionRevision: item.connectionRevision + 1,
      zIndex,
    } : item));
  }, [nextZIndex]);

  const setWindowStatus = useCallback((id: string, status: WorkspaceWindowStatus, message?: string) => {
    setWindows((current) => current.map((item) => item.id === id ? { ...item, status, statusMessage: message } : item));
  }, []);

  const setWindowDirty = useCallback((id: string, dirty: boolean) => {
    setWindows((current) => current.map((item) => item.id === id && item.dirty !== dirty ? { ...item, dirty } : item));
  }, []);

  const updateWindowBounds = useCallback((id: string, bounds: WindowBounds) => {
    setWindows((current) => current.map((item) => item.id === id ? { ...item, bounds, maximized: false, restoreBounds: undefined } : item));
  }, []);

  const toggleMaximized = useCallback((id: string, workspaceWidth: number, workspaceHeight: number) => {
    const zIndex = nextZIndex();
    setWindows((current) => current.map((item) => {
      if (item.id !== id) return item;
      if (item.maximized && item.restoreBounds) {
        return { ...item, bounds: item.restoreBounds, restoreBounds: undefined, maximized: false, zIndex };
      }
      return {
        ...item,
        restoreBounds: item.bounds,
        bounds: { x: 0, y: 0, width: workspaceWidth, height: workspaceHeight },
        maximized: true,
        minimized: false,
        zIndex,
      };
    }));
  }, [nextZIndex]);

  const fitWindowsToWorkspace = useCallback((workspaceWidth: number, workspaceHeight: number) => {
    if (workspaceWidth <= 0 || workspaceHeight <= 0) return;
    setWindows((current) => current.map((item) => {
      if (item.maximized) {
        return { ...item, bounds: { x: 0, y: 0, width: workspaceWidth, height: workspaceHeight } };
      }
      const width = Math.min(item.bounds.width, workspaceWidth);
      const height = Math.min(item.bounds.height, workspaceHeight);
      const x = Math.max(0, Math.min(item.bounds.x, workspaceWidth - width));
      const y = Math.max(0, Math.min(item.bounds.y, workspaceHeight - height));
      if (width === item.bounds.width && height === item.bounds.height && x === item.bounds.x && y === item.bounds.y) return item;
      return { ...item, bounds: { x, y, width, height } };
    }));
  }, []);

  const registerLifecycle = useCallback((id: string, lifecycle: WindowLifecycle) => {
    lifecycleRef.current.set(id, lifecycle);
    return () => lifecycleRef.current.delete(id);
  }, []);

  const saveAndClose = async () => {
    if (!closeRequest) return;
    const lifecycle = lifecycleRef.current.get(closeRequest.id);
    if (!lifecycle?.save) return;
    if (await lifecycle.save()) removeWindow(closeRequest.id);
  };

  const discardAndClose = () => {
    if (!closeRequest) return;
    lifecycleRef.current.get(closeRequest.id)?.discard?.();
    removeWindow(closeRequest.id);
  };

  const closeTarget = closeRequest && windows.find((item) => item.id === closeRequest.id);
  const value = useMemo<WorkspaceWindowsContextValue>(() => ({
    windows,
    openWindow,
    requestClose,
    removeWindow,
    focusWindow,
    minimizeWindow,
    restoreWindow,
    reconnectWindow,
    setWindowStatus,
    setWindowDirty,
    updateWindowBounds,
    toggleMaximized,
    fitWindowsToWorkspace,
    registerLifecycle,
  }), [fitWindowsToWorkspace, focusWindow, minimizeWindow, openWindow, reconnectWindow, registerLifecycle, removeWindow, requestClose, restoreWindow, setWindowDirty, setWindowStatus, toggleMaximized, updateWindowBounds, windows]);

  return (
    <WorkspaceWindowsContext.Provider value={value}>
      {children}
      <Modal
        open={Boolean(closeTarget && !closeRequest?.dirty)}
        onClose={() => setCloseRequest(undefined)}
        title="关闭窗口？"
        description="该设置可以在个人设置中调整。"
        width="440px"
        footer={<><Button variant="ghost" onClick={() => setCloseRequest(undefined)}>取消</Button><Button variant="danger" onClick={() => closeTarget && removeWindow(closeTarget.id)}>关闭窗口</Button></>}
      >
        <p className="confirm-copy">关闭 <strong>{closeTarget?.resourceName}</strong> 的{closeTarget?.type === 'shell' ? '终端' : closeTarget?.type === 'files' ? '文件' : '日志'}窗口后，当前连接将断开。</p>
      </Modal>
      <UnsavedChangesPrompt
        open={Boolean(closeTarget && closeRequest?.dirty)}
        onContinue={() => setCloseRequest(undefined)}
        onDiscard={discardAndClose}
        onSave={lifecycleRef.current.get(closeTarget?.id || '')?.save ? () => void saveAndClose().catch(() => pushToast('保存文件失败', 'error')) : undefined}
        priority={150}
      />
    </WorkspaceWindowsContext.Provider>
  );
}

export function useWorkspaceWindows() {
  const value = useContext(WorkspaceWindowsContext);
  if (!value) throw new Error('useWorkspaceWindows must be used inside WorkspaceWindowsProvider');
  return value;
}
