import { Boxes, Container, HardDrive, RefreshCw, Route, ServerCog, Waypoints, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { IconButton, StatusPill } from '../components/ui';
import { motionDuration, useEscapeLayer } from '../hooks/useEscapeLayer';

const nodes = [
  { id: 'ingress', label: 'commerce-public', kind: 'Ingress', x: 11, y: 47, tone: '#8a63b8', icon: Route, status: 'Ready', namespace: 'commerce' },
  { id: 'gateway-svc', label: 'api-gateway', kind: 'Service', x: 30, y: 47, tone: '#3578c4', icon: Waypoints, status: 'Active', namespace: 'commerce' },
  { id: 'gateway', label: 'api-gateway', kind: 'Deployment', x: 49, y: 25, tone: '#2e8b72', icon: Boxes, status: 'Ready', namespace: 'commerce' },
  { id: 'checkout', label: 'checkout', kind: 'Deployment', x: 49, y: 67, tone: '#2e8b72', icon: Boxes, status: 'Ready', namespace: 'commerce' },
  { id: 'gateway-pod', label: 'api-gateway-7d6c8b', kind: 'Pod', x: 69, y: 20, tone: '#4f8894', icon: Container, status: 'Running', namespace: 'commerce' },
  { id: 'checkout-pod', label: 'checkout-6b9f79d8', kind: 'Pod', x: 69, y: 67, tone: '#4f8894', icon: Container, status: 'Running', namespace: 'commerce' },
  { id: 'node-1', label: 'worker-cn-01', kind: 'Node', x: 88, y: 20, tone: '#c07a3d', icon: ServerCog, status: 'Ready', namespace: '' },
  { id: 'node-2', label: 'worker-cn-02', kind: 'Node', x: 88, y: 67, tone: '#c07a3d', icon: ServerCog, status: 'Ready', namespace: '' },
  { id: 'pvc', label: 'checkout-data', kind: 'PVC', x: 69, y: 86, tone: '#a95e68', icon: HardDrive, status: 'Bound', namespace: 'commerce' },
];
const edges = [
  [11, 47, 30, 47], [30, 47, 49, 25], [30, 47, 49, 67], [49, 25, 69, 20],
  [49, 67, 69, 67], [69, 20, 88, 20], [69, 67, 88, 67], [69, 67, 69, 86],
];

export function MapPage() {
  const { clusterId } = useParams();
  const [selected, setSelected] = useState<(typeof nodes)[number] | null>(nodes[2]);
  const [inspectorClosing, setInspectorClosing] = useState(false);
  const [zoom, setZoom] = useState(1);
  const inspectorTimer = useRef<number | undefined>(undefined);

  const closeInspector = () => {
    if (!selected || inspectorClosing) return;
    setInspectorClosing(true);
    inspectorTimer.current = window.setTimeout(() => {
      setSelected(null);
      setInspectorClosing(false);
    }, motionDuration(210));
  };
  const inspectNode = (node: (typeof nodes)[number]) => {
    if (inspectorTimer.current !== undefined) window.clearTimeout(inspectorTimer.current);
    setInspectorClosing(false);
    setSelected(node);
  };

  useEscapeLayer(Boolean(selected) && !inspectorClosing, closeInspector, 60);

  useEffect(() => () => {
    if (inspectorTimer.current !== undefined) window.clearTimeout(inspectorTimer.current);
  }, []);

  return (
    <div className="page map-page">
      <header className="page-header compact-page-header"><div><span className="eyebrow">cluster / {clusterId}</span><h2>资源地图</h2></div><div className="page-actions"><div className="segmented zoom-control"><button onClick={() => setZoom((value) => Math.max(.75, value - .1))}>−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom((value) => Math.min(1.35, value + .1))}>+</button></div><IconButton label="重置地图" onClick={() => setZoom(1)}><RefreshCw size={18} /></IconButton></div></header>
      <section className="map-canvas glass-card">
        <div className="map-legend"><span><i className="legend-line" />依赖关系</span><span><i className="legend-dot" />健康资源</span></div>
        <div className="map-scroll">
          <div className="map-stage" style={{ transform: `scale(${zoom})` }}>
            <svg className="map-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{edges.map((edge, index) => <path key={index} d={`M ${edge[0]} ${edge[1]} C ${(edge[0] + edge[2]) / 2} ${edge[1]}, ${(edge[0] + edge[2]) / 2} ${edge[3]}, ${edge[2]} ${edge[3]}`} />)}</svg>
            {nodes.map((node) => { const Icon = node.icon; return <button key={node.id} className={`map-node ${selected?.id === node.id ? 'is-selected' : ''}`} style={{ left: `${node.x}%`, top: `${node.y}%`, '--node-tone': node.tone } as React.CSSProperties} onClick={() => inspectNode(node)}><span className="map-node__icon"><Icon size={20} strokeWidth={1.65} /></span><strong>{node.label}</strong><small>{node.kind}</small></button>; })}
          </div>
        </div>
        {selected && <aside className={`map-inspector glass-panel ${inspectorClosing ? 'is-closing' : ''}`}><header><div><small>{selected.kind}</small><h3>{selected.label}</h3></div><IconButton label="关闭资源信息" onClick={closeInspector}><X size={16} /></IconButton></header><StatusPill status={selected.status} /><dl><div><dt>命名空间</dt><dd>{selected.namespace || '-'}</dd></div><div><dt>关系</dt><dd>{selected.kind === 'Node' ? '运行目标' : '上游 / 下游'}</dd></div></dl></aside>}
      </section>
    </div>
  );
}
