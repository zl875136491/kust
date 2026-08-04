import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { Crosshair } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../../api';
import { useThemeMode } from '../../theme-context';
import { useWorkspaceWindows, type WorkspaceWindow } from '../../workspace-windows-context';
import { Button } from '../ui';

function terminalTheme(mode: 'light' | 'dark') {
  return mode === 'dark'
    ? { background: '#0b1013', foreground: '#e4ece8', cursor: '#55e7a1', selectionBackground: '#275944' }
    : { background: '#f7faf8', foreground: '#1d2923', cursor: '#08764b', selectionBackground: '#bfe8d3' };
}

export function ShellWindowContent({ item }: { item: WorkspaceWindow }) {
  const { resolved } = useThemeMode();
  const { setWindowStatus } = useWorkspaceWindows();
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const initiallyDisconnected = useRef(!item.connectOnMount);
  const [terminalReady, setTerminalReady] = useState(false);

  useEffect(() => {
    if (!terminalHost.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      scrollback: 10_000,
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: terminalTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(terminalHost.current);
    terminalRef.current = terminal;
    fitRef.current = fit;
    setTerminalReady(true);
    if (initiallyDisconnected.current) terminal.writeln('\x1b[33m页面刷新后原终端连接已断开，请点击“重新连接”。\x1b[0m');

    const input = terminal.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
    const fitTerminal = () => {
      if (!terminalHost.current || terminalHost.current.clientWidth === 0 || terminalHost.current.clientHeight === 0) return;
      try { fit.fit(); } catch { /* The host may be between resize frames. */ }
    };
    const observer = new ResizeObserver(fitTerminal);
    observer.observe(terminalHost.current);
    window.setTimeout(fitTerminal, 0);
    return () => {
      observer.disconnect();
      input.dispose();
      resize.dispose();
      socketRef.current?.close();
      socketRef.current = undefined;
      terminal.dispose();
      terminalRef.current = undefined;
      fitRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = terminalTheme(resolved);
  }, [resolved]);

  useEffect(() => {
    if (!terminalReady || (!item.connectOnMount && item.connectionRevision === 0)) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    let disposed = false;
    let opened = false;
    let socket: WebSocket;
    setWindowStatus(item.id, item.connectionRevision > 0 ? 'reconnecting' : 'connecting', item.connectionRevision > 0 ? '正在重新建立终端连接' : '正在建立终端连接');
    terminal.writeln(`\r\n\x1b[90m正在连接 ${item.namespace}/${item.resourceName}${item.container ? `/${item.container}` : ''}...\x1b[0m`);
    try {
      socket = new WebSocket(api.shellUrl(item.clusterId, item.namespace, item.resourceName, item.container));
    } catch (error) {
      setWindowStatus(item.id, 'error', error instanceof Error ? error.message : '无法创建终端连接');
      return;
    }
    socketRef.current = socket;
    socket.onopen = () => {
      if (disposed) return;
      opened = true;
      setWindowStatus(item.id, 'connected', '终端已连接');
      const fit = fitRef.current;
      try { fit?.fit(); } catch { /* The window may be minimized. */ }
      if (terminal.cols && terminal.rows) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      terminal.focus();
    };
    socket.onmessage = async (event) => {
      if (disposed) return;
      if (typeof event.data === 'string') terminal.write(event.data);
      else if (event.data instanceof Blob) terminal.write(await event.data.text());
      else if (event.data instanceof ArrayBuffer) terminal.write(new TextDecoder().decode(event.data));
    };
    socket.onerror = () => {
      if (!disposed) terminal.writeln('\r\n\x1b[31m终端连接发生错误。\x1b[0m');
    };
    socket.onclose = () => {
      if (disposed) return;
      socketRef.current = undefined;
      void api.podExists(item.clusterId, item.namespace, item.resourceName)
        .then(() => setWindowStatus(item.id, opened ? 'disconnected' : 'error', opened ? '终端连接已断开' : '终端连接失败'))
        .catch((error) => setWindowStatus(
          item.id,
          error instanceof ApiError && error.status === 404 ? 'missing' : 'error',
          error instanceof ApiError && error.status === 404 ? 'Pod 已被删除' : '无法确认 Pod 状态',
        ));
    };
    return () => {
      disposed = true;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      if (socketRef.current === socket) socketRef.current = undefined;
    };
  }, [item.clusterId, item.connectOnMount, item.connectionRevision, item.container, item.id, item.namespace, item.resourceName, setWindowStatus, terminalReady]);

  return (
    <div className="workspace-tool workspace-shell">
      <div className="workspace-tool__toolbar">
        <span><i className="tool-dot" />{item.clusterName || item.clusterId}</span>
        <small>{item.namespace} / {item.resourceName}{item.container ? ` / ${item.container}` : ''}</small>
        <Button variant="ghost" icon={<Crosshair size={15} />} onClick={() => terminalRef.current?.focus()}>聚焦</Button>
      </div>
      <div className="xterm-host workspace-xterm-host" ref={terminalHost} />
    </div>
  );
}
