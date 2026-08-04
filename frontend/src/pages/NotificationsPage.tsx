import { Bell, CheckCheck, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { useData } from '../data-context';
import type { Cluster } from '../types';
import { Button, EmptyState, Spinner, StatusPill } from '../components/ui';

export function NotificationsPage() {
  const { clusters, getResources } = useData();
  const { cluster: contextualCluster } = useOutletContext<{ cluster?: Cluster }>();
  const cluster = contextualCluster || clusters.find((item) => item.status === 'connected') || clusters[0];
  const [read, setRead] = useState<Set<string>>(new Set());
  const [unreadOnly, setUnreadOnly] = useState(false);
  const query = useQuery({
    queryKey: ['notifications', cluster?.id],
    queryFn: () => getResources(cluster!.id, 'events'),
    enabled: Boolean(cluster),
  });
  const events = (query.data?.items || []).filter((event) => !unreadOnly || !read.has(event.uid));

  return (
    <div className="page notifications-page">
      <header className="page-header"><div><span className="eyebrow">activity</span><h2>通知</h2></div><Button icon={<CheckCheck size={17} />} onClick={() => setRead(new Set((query.data?.items || []).map((event) => event.uid)))}>全部标为已读</Button></header>
      <div className="view-tabs compact-tabs"><button className={!unreadOnly ? 'is-active' : ''} onClick={() => setUnreadOnly(false)}>全部</button><button className={unreadOnly ? 'is-active' : ''} onClick={() => setUnreadOnly(true)}>未读</button></div>
      <section className="notification-list glass-card">
        {query.isLoading ? <Spinner label="正在加载通知" /> : events.length === 0 ? <EmptyState icon={<Bell size={24} />} title="没有通知" /> : events.map((event) => {
          const unread = !read.has(event.uid);
          return <button key={event.uid} className={`notification-item ${unread ? 'is-unread' : ''}`} onClick={() => setRead((current) => new Set(current).add(event.uid))}><span className={`notification-icon notification-icon--${event.status.toLowerCase()}`}>{event.status === 'Warning' ? <TriangleAlert size={18} /> : <Bell size={18} />}</span><div><div><strong>{String(event.details.reason || event.name)}</strong><StatusPill status={event.status} /></div><p>{String(event.details.message || '-')}</p><small>{event.namespace || 'cluster'} · {event.createdAt ? new Date(event.createdAt).toLocaleString('zh-CN') : '-'}</small></div>{unread && <i className="unread-dot" />}</button>;
        })}
      </section>
    </div>
  );
}
