import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { ArrowLeft, CircleAlert, Maximize2, RotateCw, TerminalSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, EmptyState, IconButton, Spinner } from '../components/ui';
import { api } from '../api';
import { useData } from '../data-context';
import { useThemeMode } from '../theme-context';

export function WebShellPage() {
  const { clusterId = '', namespace = '', pod = '' } = useParams();
  const [searchParams] = useSearchParams();
  const container = searchParams.get('container') || undefined;
  const navigate = useNavigate();
  const { clusters } = useData();
  const { resolved } = useThemeMode();
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const [connection, setConnection] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [fitVersion, setFitVersion] = useState(0);
  const cluster = clusters.find((item) => item.id === clusterId);

  useEffect(() => {
    if (!terminalHost.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      theme: resolved === 'dark'
        ? { background: '#0b1013', foreground: '#e4ece8', cursor: '#55e7a1', selectionBackground: '#275944' }
        : { background: '#f7faf8', foreground: '#1d2923', cursor: '#08764b', selectionBackground: '#bfe8d3' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(terminalHost.current);
    fit.fit();
    terminal.writeln('\x1b[90mConnecting to ' + pod + '...\x1b[0m');
    const socket = new WebSocket(api.shellUrl(clusterId, namespace, pod, container));
    socketRef.current = socket;
    terminalRef.current = terminal;
    setConnection('connecting');
    socket.onopen = () => {
      setConnection('open');
      fit.fit();
      socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    };
    socket.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        terminal.write(event.data);
      } else if (event.data instanceof Blob) {
        terminal.write(await event.data.text());
      } else if (event.data instanceof ArrayBuffer) {
        terminal.write(new TextDecoder().decode(event.data));
      }
    };
    socket.onerror = () => {
      setConnection('error');
      terminal.writeln('\r\n\x1b[31mUnable to connect to the pod shell. Check pod permissions and that /bin/sh exists.\x1b[0m');
    };
    socket.onclose = () => setConnection('closed');
    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(terminalHost.current);
    return () => {
      observer.disconnect();
      input.dispose();
      resize.dispose();
      socket.close();
      terminal.dispose();
      socketRef.current = undefined;
      terminalRef.current = undefined;
    };
  }, [cluster?.id, clusterId, container, namespace, pod, resolved, fitVersion]);
  if (!cluster) {
    return <div className="page"><EmptyState icon={<CircleAlert size={24} />} title="集群不存在" /></div>;
  }

  return (
    <div className="page pod-tool-page">
      <header className="page-header compact-page-header">
        <div>
          <span className="eyebrow">{namespace} / Pod</span>
          <h2><TerminalSquare size={20} />{pod}</h2>
          <p className="page-subtitle">WebShell{container ? ' · ' + container : ''}</p>
        </div>
        <div className="page-actions">
          {connection === 'connecting' && <span className="tool-connection"><Spinner label="连接中" /></span>}
          {connection === 'open' && <span className="tool-connection is-connected"><i />已连接</span>}
          {connection === 'closed' && <span className="tool-connection">已断开</span>}
          {connection === 'error' && <span className="tool-connection is-error">连接失败</span>}
          <IconButton label="重新连接" onClick={() => setFitVersion((value) => value + 1)}><RotateCw size={17} /></IconButton>
          <IconButton label="返回资源详情" onClick={() => navigate('/cluster/' + clusterId + '/resources/pods')}><ArrowLeft size={17} /></IconButton>
        </div>
      </header>
      <section className="pod-tool-surface glass-card">
        <div className="pod-tool-toolbar">
          <span><i className="tool-dot" />{cluster.name}</span>
          <small>{namespace} / {pod}{container ? ' / ' + container : ''}</small>
          <Button variant="ghost" icon={<Maximize2 size={15} />} onClick={() => terminalRef.current?.focus()}>聚焦终端</Button>
        </div>
        <div className="xterm-host" ref={terminalHost} />
      </section>
    </div>
  );
}
