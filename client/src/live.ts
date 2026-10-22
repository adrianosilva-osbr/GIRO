import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getToken } from './api';

const WORK_KEYS = [['issues'], ['issue'], ['sprints'], ['projects'], ['project'], ['reports']];

/**
 * Subscribes to /api/events and refetches whatever another person changed.
 * Uses fetch streaming rather than EventSource so the token travels in a header, not the URL.
 */
export function useLiveUpdates(userId: string | undefined) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!userId) return;
    let stopped = false;
    let ctrl: AbortController | null = null;
    let retry = 1000;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const pending = { work: false, notifications: false };

    // Bursts of events (e.g. a sprint completion) collapse into one refetch.
    const schedule = (kind: keyof typeof pending) => {
      pending[kind] = true;
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        if (pending.work) for (const queryKey of WORK_KEYS) qc.invalidateQueries({ queryKey });
        if (pending.notifications) qc.invalidateQueries({ queryKey: ['notifications'] });
        pending.work = pending.notifications = false;
      }, 250);
    };

    const connect = async (isReconnect: boolean) => {
      ctrl = new AbortController();
      try {
        const res = await fetch('/api/events', {
          headers: { Authorization: `Bearer ${getToken()}` },
          signal: ctrl.signal,
        });
        if (res.status === 401) {
          window.dispatchEvent(new Event('giro:unauthorized'));
          return;
        }
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        retry = 1000;
        // Anything could have changed while we were disconnected.
        if (isReconnect) {
          schedule('work');
          schedule('notifications');
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const message = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const data = message.split('\n').find((l) => l.startsWith('data: '));
            if (!data) continue;
            const event = JSON.parse(data.slice(6)) as { type: string };
            schedule(event.type === 'notifications' ? 'notifications' : 'work');
          }
        }
      } catch {
        // network error or abort; fall through to reconnect
      }
      if (!stopped) {
        setTimeout(() => !stopped && connect(true), retry);
        retry = Math.min(retry * 2, 30_000);
      }
    };

    connect(false);
    return () => {
      stopped = true;
      clearTimeout(flushTimer);
      ctrl?.abort();
    };
  }, [userId, qc]);
}
