import { LoaderCircle } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useData } from '../data-context';
import { useWorkspaceWindows } from '../workspace-windows-context';

export function WebFilePage() {
  const { clusterId = '', namespace = '', pod = '' } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { clusters } = useData();
  const { openWindow } = useWorkspaceWindows();
  const container = searchParams.get('container') || undefined;
  const clusterName = clusters.find((item) => item.id === clusterId)?.name;

  useEffect(() => {
    if (!clusterId || !namespace || !pod) return;
    openWindow({ type: 'files', clusterId, clusterName, namespace, resourceName: pod, container });
    navigate(`/cluster/${clusterId}/resources/pods`, { replace: true });
  }, [clusterId, clusterName, container, namespace, navigate, openWindow, pod]);

  return <div className="page"><div className="auth-loading"><LoaderCircle className="spin" size={20} /><span>正在打开文件窗口</span></div></div>;
}
