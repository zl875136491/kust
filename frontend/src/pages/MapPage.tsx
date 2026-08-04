import { Boxes, Container, GitBranch, HardDrive, LoaderCircle, Network, RefreshCw, Route, ServerCog, Waypoints, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { EmptyState, IconButton, StatusPill } from '../components/ui';
import { motionDuration, useEscapeLayer } from '../hooks/useEscapeLayer';
import type { ResourceMapEdge, ResourceMapNode, ResourceMapResponse } from '../types';

const STAGE_WIDTH = 1340;
const groupX: Record<string, number> = { entry: 100, network: 330, workload: 560, pod: 790, node: 1020, storage: 1240, other: 560 };
const groupTone: Record<string, string> = { entry: '#8a63b8', network: '#3578c4', workload: '#2e8b72', pod: '#4f8894', node: '#c07a3d', storage: '#a95e68', other: '#65717d' };
const groupIcon = { entry: Route, network: Waypoints, workload: Boxes, pod: Container, node: ServerCog, storage: HardDrive, other: GitBranch } as const;

interface PositionedNode extends ResourceMapNode { x: number; y: number; tone: string }

function positionNodes(nodes: ResourceMapNode[]): PositionedNode[] {
  const groups = new Map<string, ResourceMapNode[]>();
  nodes.forEach((node) => groups.set(node.group, [...(groups.get(node.group) || []), node]));
  return nodes.map((node) => {
    const items = groups.get(node.group) || [node];
    const index = items.findIndex((item) => item.id === node.id);
    const y = 54 + index * 72;
    return { ...node, x: groupX[node.group] ?? groupX.other, y, tone: groupTone[node.group] ?? groupTone.other };
  });
}

export function MapPage() {
  const { clusterId = '' } = useParams();
  const [data, setData] = useState<ResourceMapResponse>({ nodes: [], edges: [] });
  const [selected, setSelected] = useState<PositionedNode | null>(null);
  const [inspectorClosing, setInspectorClosing] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const inspectorTimer = useRef<number | undefined>(undefined);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await api.resourceMap(clusterId)); } catch (reason) { setError(reason instanceof Error ? reason.message : '资源地图加载失败'); } finally { setLoading(false); }
  }, [clusterId]);
  useEffect(() => { void load(); }, [load]);

  const nodes = useMemo(() => positionNodes(data.nodes), [data.nodes]);
  const stageHeight = useMemo(() => Math.max(520, ...nodes.map((node) => node.y + 70)), [nodes]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const related = useMemo(() => selected ? data.edges.filter((edge) => edge.source === selected.id || edge.target === selected.id) : [], [data.edges, selected]);
  const closeInspector = () => {
    if (!selected || inspectorClosing) return;
    setInspectorClosing(true);
    inspectorTimer.current = window.setTimeout(() => { setSelected(null); setInspectorClosing(false); }, motionDuration(210));
  };
  const inspectNode = (node: PositionedNode) => {
    if (inspectorTimer.current !== undefined) window.clearTimeout(inspectorTimer.current);
    setInspectorClosing(false); setSelected(node);
  };
  useEscapeLayer(Boolean(selected) && !inspectorClosing, closeInspector, 60);
  useEffect(() => () => { if (inspectorTimer.current !== undefined) window.clearTimeout(inspectorTimer.current); }, []);

  return <div className="page map-page">
    <header className="page-header compact-page-header"><div><span className="eyebrow">cluster / {clusterId}</span><h2>资源地图</h2>{data.syncedAt && <p className="page-subtitle">数据同步于 {new Date(data.syncedAt).toLocaleString()}</p>}</div><div className="page-actions"><div className="segmented zoom-control"><button aria-label="缩小" onClick={() => setZoom((value) => Math.max(.65, value - .1))}>−</button><span>{Math.round(zoom * 100)}%</span><button aria-label="放大" onClick={() => setZoom((value) => Math.min(1.5, value + .1))}>+</button></div><IconButton label="刷新地图" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={18} /></IconButton></div></header>
    <section className="map-canvas glass-card">
      <div className="map-legend"><span><i className="legend-line" />依赖关系</span><span><i className="legend-dot" />已同步资源</span></div>
      {loading && !nodes.length ? <div className="map-state"><LoaderCircle className="spin" size={24} /><span>正在从 MongoDB 组织资源关系</span></div> : error ? <EmptyState icon={<Network size={23} />} title={error} action={<button onClick={() => void load()}>重新加载</button>} /> : !nodes.length ? <EmptyState icon={<Network size={23} />} title="暂时没有可绘制的资源关系" /> : <div className="map-scroll"><div className="map-stage" style={{ width: STAGE_WIDTH, height: stageHeight, transform: `scale(${zoom})` }}>
        <svg className="map-edges" viewBox={`0 0 ${STAGE_WIDTH} ${stageHeight}`} preserveAspectRatio="none" aria-hidden="true">{data.edges.map((edge: ResourceMapEdge) => { const source = byId.get(edge.source); const target = byId.get(edge.target); if (!source || !target) return null; const middle = (source.x + target.x) / 2; return <path key={edge.id} d={`M ${source.x} ${source.y} C ${middle} ${source.y}, ${middle} ${target.y}, ${target.x} ${target.y}`} />; })}</svg>
        {nodes.map((node) => { const Icon = groupIcon[node.group as keyof typeof groupIcon] || groupIcon.other; return <button key={node.id} className={`map-node ${selected?.id === node.id ? 'is-selected' : ''}`} style={{ left: node.x, top: node.y, '--node-tone': node.tone } as React.CSSProperties} onClick={() => inspectNode(node)}><span className="map-node__icon"><Icon size={20} strokeWidth={1.65} /></span><strong title={node.label}>{node.label}</strong><small>{node.kind}</small></button>; })}
      </div></div>}
      {selected && <aside className={`map-inspector glass-panel ${inspectorClosing ? 'is-closing' : ''}`}><header><div><small>{selected.kind}</small><h3>{selected.label}</h3></div><IconButton label="关闭资源信息" onClick={closeInspector}><X size={16} /></IconButton></header><StatusPill status={selected.status} /><dl><div><dt>命名空间</dt><dd>{selected.namespace || '-'}</dd></div><div><dt>资源组</dt><dd>{selected.group}</dd></div></dl><div className="map-relations"><strong>资源关系</strong>{related.length ? related.slice(0, 12).map((edge) => { const peer = byId.get(edge.source === selected.id ? edge.target : edge.source); return <span key={edge.id}>{edge.relation} · {peer?.label || '未知资源'}</span>; }) : <span>未发现已同步关系</span>}</div></aside>}
    </section>
  </div>;
}
