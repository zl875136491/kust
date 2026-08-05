import { ArrowDown, ArrowUp, ArrowUpDown, Boxes } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ResourceRow } from '../types';
import { EmptyState, Spinner, StatusPill } from './ui';
import { ResourceActionMenu, type ResourceAction } from './ResourceActionMenu';

function age(timestamp?: string) {
  if (!timestamp) return '-';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}小时`;
  return `${Math.floor(seconds / 86_400)}天`;
}

type SortKey = 'name' | 'namespace' | 'kind' | 'status' | 'createdAt';

export function ResourceTable({
  rows,
  loading,
  showKind = false,
  selectionMode = false,
  selected,
  onSelected,
  onOpen,
  canWriteResources = false,
  onAction,
}: {
  rows: ResourceRow[];
  loading?: boolean;
  showKind?: boolean;
  selectionMode?: boolean;
  selected?: Set<string>;
  onSelected?: (selected: Set<string>) => void;
  onOpen: (row: ResourceRow) => void;
  canWriteResources?: boolean;
  onAction?: (action: ResourceAction, row: ResourceRow) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'name', direction: 'asc' });
  const hasNamespace = rows.some((row) => row.namespace);
  const hasReady = rows.some((row) => row.ready !== undefined);
  const hasRestarts = rows.some((row) => row.restarts !== undefined);
  const hasNode = rows.some((row) => row.node);
  const sortedRows = useMemo(() => [...rows].sort((left, right) => {
    const leftValue = String(left[sort.key] || '');
    const rightValue = String(right[sort.key] || '');
    return leftValue.localeCompare(rightValue) * (sort.direction === 'asc' ? 1 : -1);
  }), [rows, sort]);

  const setSortKey = (key: SortKey) => setSort((current) => ({
    key,
    direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
  }));
  const SortIcon = ({ column }: { column: SortKey }) => sort.key !== column
    ? <ArrowUpDown size={13} />
    : sort.direction === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />;
  const toggleAll = () => {
    if (!onSelected || !selected) return;
    const allVisibleSelected = rows.length > 0 && rows.every((row) => selected.has(row.uid));
    const next = new Set(selected);
    rows.forEach((row) => allVisibleSelected ? next.delete(row.uid) : next.add(row.uid));
    onSelected(next);
  };
  const toggleRow = (uid: string) => {
    if (!onSelected || !selected) return;
    const next = new Set(selected);
    if (next.has(uid)) next.delete(uid); else next.add(uid);
    onSelected(next);
  };

  if (loading) return <Spinner label="正在读取集群资源" />;
  if (rows.length === 0) return <EmptyState icon={<Boxes size={24} />} title="没有资源" />;

  return (
    <div className="resource-table-wrap">
      <table className="resource-table">
        <thead><tr>
          {selectionMode && selected && <th className="check-cell"><input type="checkbox" aria-label="选择全部" checked={rows.length > 0 && rows.every((row) => selected.has(row.uid))} onChange={toggleAll} /></th>}
          <th><button onClick={() => setSortKey('name')}>名称 <SortIcon column="name" /></button></th>
          {showKind && <th><button onClick={() => setSortKey('kind')}>类型 <SortIcon column="kind" /></button></th>}
          {hasNamespace && <th><button onClick={() => setSortKey('namespace')}>命名空间 <SortIcon column="namespace" /></button></th>}
          <th><button onClick={() => setSortKey('status')}>状态 <SortIcon column="status" /></button></th>
          {hasReady && <th>就绪</th>}
          {hasRestarts && <th className="number-cell">重启</th>}
          {hasNode && <th>节点</th>}
          <th><button onClick={() => setSortKey('createdAt')}>存续时间 <SortIcon column="createdAt" /></button></th>
          {onAction && <th className="resource-actions-cell">操作</th>}
        </tr></thead>
        <tbody>{sortedRows.map((row) => (
          <tr key={row.uid} className={selectionMode && selected?.has(row.uid) ? 'is-selected' : ''} onClick={() => selectionMode ? toggleRow(row.uid) : onOpen(row)}>
            {selectionMode && selected && <td className="check-cell" onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`选择 ${row.name}`} checked={selected.has(row.uid)} onChange={() => toggleRow(row.uid)} /></td>}
            <td><button className="resource-name" onClick={(event) => { event.stopPropagation(); if (selectionMode) toggleRow(row.uid); else onOpen(row); }}>{row.name}</button></td>
            {showKind && <td><span className="kind-label">{row.kind}</span></td>}
            {hasNamespace && <td>{row.namespace || '-'}</td>}
            <td><StatusPill status={row.status} /></td>
            {hasReady && <td className="mono-cell">{row.ready || '-'}</td>}
            {hasRestarts && <td className="number-cell mono-cell">{row.restarts ?? '-'}</td>}
            {hasNode && <td>{row.node || '-'}</td>}
            <td className="muted-cell">{age(row.createdAt)}</td>
            {onAction && <td className="resource-actions-cell" onClick={(event) => event.stopPropagation()}><ResourceActionMenu row={row} canWriteResources={canWriteResources} onAction={onAction} /></td>}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
