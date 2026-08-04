import { Download, Pause, Play, RefreshCw, WrapText } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../../api';
import { useWorkspaceWindows, type WorkspaceWindow } from '../../workspace-windows-context';
import { Button, IconButton, SelectMenu } from '../ui';

const tailOptions = [100, 500, 1000, 5000, 10000].map((value) => ({ value: String(value), label: `${value} 行` }));

export function LogsWindowContent({ item }: { item: WorkspaceWindow }) {
  const { setWindowStatus } = useWorkspaceWindows();
  const [logs, setLogs] = useState('');
  const [tailLines, setTailLines] = useState(500);
  const [paused, setPaused] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const firstLoadRef = useRef(true);

  const loadLogs = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await api.podLogs(item.clusterId, item.namespace, item.resourceName, item.container, tailLines);
      setLogs(response.logs);
      setWindowStatus(item.id, 'connected', paused ? '日志自动刷新已暂停' : `日志已同步 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
      if (firstLoadRef.current) {
        firstLoadRef.current = false;
        window.setTimeout(() => viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight }), 0);
      }
      return true;
    } catch (error) {
      setWindowStatus(
        item.id,
        error instanceof ApiError && error.status === 404 ? 'missing' : 'error',
        error instanceof ApiError && error.status === 404 ? 'Pod 已被删除' : error instanceof Error ? error.message : '日志连接失败',
      );
      return false;
    } finally {
      setRefreshing(false);
    }
  }, [item.clusterId, item.container, item.id, item.namespace, item.resourceName, paused, setWindowStatus, tailLines]);

  useEffect(() => {
    if ((!item.connectOnMount && item.connectionRevision === 0) || paused) return;
    let active = true;
    let timer: number | undefined;
    setWindowStatus(item.id, item.connectionRevision > 0 ? 'reconnecting' : 'connecting', '正在读取 Pod 日志');
    const poll = async () => {
      const connected = await loadLogs();
      if (active && connected) timer = window.setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [item.connectOnMount, item.connectionRevision, item.id, loadLogs, paused, setWindowStatus]);

  useEffect(() => {
    if (!paused || item.status !== 'connected') return;
    setWindowStatus(item.id, 'connected', '日志自动刷新已暂停');
  }, [item.id, item.status, paused, setWindowStatus]);

  const lines = useMemo(() => logs ? logs.split('\n').length : 0, [logs]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([logs], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${item.resourceName}-${item.container || 'pod'}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="workspace-tool workspace-logs">
      <div className="workspace-tool__toolbar logs-toolbar">
        <span><i className="tool-dot" />{item.namespace} / {item.resourceName}</span>
        <small>{lines.toLocaleString('zh-CN')} 行{item.container ? ` · ${item.container}` : ''}</small>
        <div className="logs-toolbar__actions">
          <SelectMenu aria-label="日志行数" value={String(tailLines)} options={tailOptions} onChange={(value) => { firstLoadRef.current = true; setTailLines(Number(value)); }} />
          <IconButton label={paused ? '继续自动刷新' : '暂停自动刷新'} active={paused} onClick={() => setPaused((current) => !current)}>{paused ? <Play size={16} /> : <Pause size={16} />}</IconButton>
          <IconButton label="切换自动换行" active={wrap} onClick={() => setWrap((current) => !current)}><WrapText size={16} /></IconButton>
          <IconButton label="立即刷新" onClick={() => void loadLogs()} disabled={refreshing}><RefreshCw className={refreshing ? 'spin' : ''} size={16} /></IconButton>
          <Button variant="ghost" icon={<Download size={15} />} onClick={download} disabled={!logs}>下载</Button>
        </div>
      </div>
      <div className={`logs-console ${wrap ? 'is-wrapped' : ''}`} ref={viewportRef}><pre>{logs || '暂无日志'}</pre></div>
    </div>
  );
}
