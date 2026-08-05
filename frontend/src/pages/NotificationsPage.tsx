import { Bell, CheckCheck, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useData } from '../data-context';
import { api } from '../api';
import type { Cluster } from '../types';
import { Button, EmptyState, Modal, Spinner, StatusPill } from '../components/ui';

export function NotificationsModal({ open, onClose, cluster: contextualCluster }: {
  open: boolean;
  onClose: () => void;
  cluster?: Cluster;
}) {
  const { clusters, getResources } = useData();
  const cluster = contextualCluster || clusters.find((item) => item.status === 'connected') || clusters[0];
  const [read, setRead] = useState<Set<string>>(new Set());
  const persistentQuery = useQuery({ queryKey: ['persistent-notifications', cluster?.id], queryFn: () => api.notifications(cluster?.id), enabled: open });
  const [unreadOnly, setUnreadOnly] = useState(false);
  const query = useQuery({
    queryKey: ['notifications', cluster?.id],
    queryFn: () => getResources(cluster!.id, 'events'),
    enabled: open && Boolean(cluster),
  });
  const events = (query.data?.items || []).filter((event) => !unreadOnly || !read.has(event.uid));
  const markAllRead = async () => { setRead(new Set((query.data?.items || []).map((event) => event.uid))); await api.markAllNotificationsRead().catch(() => undefined); await persistentQuery.refetch(); };

  return <Modal
    open={open}
    onClose={onClose}
    title="通知"
    description={cluster ? `${cluster.name} 的集群事件` : '当前没有可用集群'}
    width="min(880px, calc(100vw - 36px))"
    className="modal--notifications"
  >
    <div className="notifications-modal__toolbar">
      <div className="view-tabs compact-tabs"><button className={!unreadOnly ? 'is-active' : ''} onClick={() => setUnreadOnly(false)}>全部</button><button className={unreadOnly ? 'is-active' : ''} onClick={() => setUnreadOnly(true)}>未读</button></div>
      <Button variant="ghost" icon={<CheckCheck size={17} />} onClick={markAllRead} disabled={!query.data?.items.length}>全部标为已读</Button>
    </div>
    <section className="notification-list notification-list--modal">
      {query.isLoading ? <Spinner label="正在加载通知" /> : events.length === 0 ? <EmptyState icon={<Bell size={24} />} title="没有通知" /> : events.map((event) => {
        const unread = !read.has(event.uid);
        return <button key={event.uid} className={`notification-item ${unread ? 'is-unread' : ''}`} onClick={() => setRead((current) => new Set(current).add(event.uid))}><span className={`notification-icon notification-icon--${event.status.toLowerCase()}`}>{event.status === 'Warning' ? <TriangleAlert size={18} /> : <Bell size={18} />}</span><div><div><strong>{String(event.details.reason || event.name)}</strong><StatusPill status={event.status} /></div><p>{String(event.details.message || '-')}</p><small>{event.namespace || 'cluster'} · {event.createdAt ? new Date(event.createdAt).toLocaleString('zh-CN') : '-'}</small></div>{unread && <i className="unread-dot" />}</button>;
      })}
    </section>
  </Modal>;
}

export function NotificationsPage() {
  const { cluster } = useOutletContext<{ cluster?: Cluster }>();
  const navigate = useNavigate();
  return <>
    <div className="page notifications-route-host" />
    <NotificationsModal open cluster={cluster} onClose={() => navigate(cluster ? `/cluster/${cluster.id}` : '/', { replace: true })} />
  </>;
}
