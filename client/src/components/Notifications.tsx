import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { STATUS_LABEL, timeAgo } from '../constants';
import { useOpenIssue } from '../hooks';
import type { AppNotification } from '../types';
import { IssueTypeIcon } from './Icons';
import { Avatar } from './ui';

function describe(n: AppNotification) {
  switch (n.type) {
    case 'assigned':
      return <>atribuiu <b>{n.issue.key}</b> a você</>;
    case 'mentioned':
      return <>mencionou você em <b>{n.issue.key}</b></>;
    case 'commented':
      return <>comentou em <b>{n.issue.key}</b></>;
    case 'status':
      return <>mudou <b>{n.issue.key}</b> para <b>{STATUS_LABEL[n.detail] ?? n.detail}</b></>;
  }
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const openIssue = useOpenIssue();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ notifications: AppNotification[]; unread: number }>('/notifications'),
  });
  const unread = data?.unread ?? 0;
  const list = (data?.notifications ?? []).filter((n) => !onlyUnread || !n.read);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => {
    document.title = unread ? `(${unread}) GIRO` : 'GIRO';
  }, [unread]);

  const markRead = async (ids?: string[]) => {
    await api('/notifications/read', { method: 'POST', body: ids ? { ids } : {} });
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };

  return (
    <div className="user-menu" ref={ref}>
      <button className="btn-icon bell" onClick={() => setOpen((o) => !o)} aria-label={`Notificações${unread ? `, ${unread} não lidas` : ''}`}>
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M4 11.5V7a4 4 0 1 1 8 0v4.5l1.2 1.2H2.8zM6.5 13.5a1.5 1.5 0 0 0 3 0" strokeLinejoin="round" />
        </svg>
        {unread > 0 && <span className="badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="dropdown notifications-panel">
          <div className="notifications-header">
            <b>Notificações</b>
            <label className="checkbox small">
              <input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} />
              Somente não lidas
            </label>
          </div>
          {unread > 0 && (
            <button className="link small mark-all" onClick={() => markRead()}>
              Marcar todas como lidas
            </button>
          )}
          <ul className="notifications-list">
            {list.map((n) => (
              <li
                key={n.id}
                className={n.read ? '' : 'unread'}
                onClick={() => {
                  if (!n.read) markRead([n.id]);
                  setOpen(false);
                  openIssue(n.issue.key);
                }}
              >
                <Avatar user={n.actor} size={32} />
                <div className="notification-body">
                  <div>
                    <b>{n.actor.name}</b> {describe(n)}
                  </div>
                  <div className="notification-issue">
                    <IssueTypeIcon type={n.issue.type} size={14} /> {n.issue.title}
                  </div>
                  {(n.type === 'commented' || n.type === 'mentioned') && n.detail && (
                    <div className="notification-excerpt">“{n.detail}”</div>
                  )}
                  <div className="muted small">{timeAgo(n.createdAt)}</div>
                </div>
                {!n.read && <span className="unread-dot" aria-label="Não lida" />}
              </li>
            ))}
            {list.length === 0 && <li className="notifications-empty muted">Nenhuma notificação{onlyUnread ? ' não lida' : ''}.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
