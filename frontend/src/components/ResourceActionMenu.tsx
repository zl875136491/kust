import { Download, Eye, FilePenLine, FolderOpen, Logs, MoreVertical, RotateCw, Scale, TerminalSquare, Trash2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAnimatedPresence, useEscapeLayer } from '../hooks/useEscapeLayer';
import { resourceKindKey } from '../resource-utils';
import type { ResourceRow } from '../types';

export type ResourceAction = 'restart' | 'scale' | 'edit' | 'download' | 'view-yaml' | 'delete' | 'logs' | 'shell' | 'files';

const restartable = new Set(['deployments', 'statefulsets', 'daemonsets']);
const scalable = new Set(['deployments', 'statefulsets', 'replicasets']);

export function ResourceActionMenu({ row, canWriteResources, onAction }: {
  row: ResourceRow;
  canWriteResources: boolean;
  onAction: (action: ResourceAction, row: ResourceRow) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { mounted, closing } = useAnimatedPresence(open, 170);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const kind = resourceKindKey(row.kind);

  const close = useCallback(() => setOpen(false), []);
  useEscapeLayer(open, close, 95);

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 205;
    const estimatedHeight = 310;
    const above = window.innerHeight - rect.bottom < Math.min(estimatedHeight, 220) && rect.top > window.innerHeight - rect.bottom;
    setPosition({
      left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width)),
      top: above ? Math.max(8, rect.top - estimatedHeight - 5) : rect.bottom + 5,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    document.addEventListener('mousedown', closeOnOutside);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [close, open, updatePosition]);

  const choose = (action: ResourceAction) => {
    setOpen(false);
    onAction(action, row);
  };
  const item = (action: ResourceAction, label: string, icon: React.ReactNode, danger = false) => <button type="button" className={danger ? 'is-danger' : ''} onClick={() => choose(action)}>{icon}<span>{label}</span></button>;

  return <>
    <button
      ref={triggerRef}
      type="button"
      className={`icon-button resource-action-trigger ${open ? 'is-active' : ''}`}
      aria-label={`${row.name} 操作`}
      title={`${row.name} 操作`}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
    ><MoreVertical size={17} /></button>
    {mounted && createPortal(<div
      ref={menuRef}
      className={`resource-action-menu glass-panel ${closing ? 'is-closing' : ''}`}
      role="menu"
      aria-label={`${row.name} 操作`}
      style={{ left: position.left, top: position.top }}
    >
      {kind === 'pods' && item('logs', '日志', <Logs size={16} />)}
      {kind === 'pods' && canWriteResources && item('shell', '终端', <TerminalSquare size={16} />)}
      {kind === 'pods' && canWriteResources && item('files', '文件', <FolderOpen size={16} />)}
      {canWriteResources && restartable.has(kind) && item('restart', '滚动重启', <RotateCw size={16} />)}
      {canWriteResources && scalable.has(kind) && item('scale', '扩缩容', <Scale size={16} />)}
      {canWriteResources && item('edit', '编辑', <FilePenLine size={16} />)}
      {item('download', '下载 YAML', <Download size={16} />)}
      {item('view-yaml', '查看 YAML', <Eye size={16} />)}
      {canWriteResources && <span className="resource-action-menu__separator" />}
      {canWriteResources && item('delete', '删除', <Trash2 size={16} />, true)}
    </div>, document.body)}
  </>;
}
