import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEpics, useOpenIssue, useUpdateIssue } from '../hooks';
import { isDone } from '../constants';
import type { EpicProgress, Project } from '../types';
import { useCreateIssue } from '../components/CreateIssue';
import { Icon, IssueTypeIcon } from '../components/Icons';
import { Avatar, EmptyState, Spinner, StatusLozenge } from '../components/ui';
import { useToast } from '../components/Toast';

const DAY = 86_400_000;
const ZOOM = { weeks: 26, months: 7, quarters: 2.4 } as const;
type Zoom = keyof typeof ZOOM;

/** Dates are calendar days: parse "YYYY-MM-DD…" as local midnight so time zones never shift them. */
const dayOf = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const toIso = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const today = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const fmt = (t: number) => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });

interface Drag {
  id: string;
  mode: 'move' | 'start' | 'end';
  originX: number;
  start: number;
  due: number;
  deltaDays: number;
}

export function TimelinePage() {
  const project = useOutletContext<Project>();
  const { data: epics = [], isLoading } = useEpics(project.key);
  const openIssue = useOpenIssue();
  const openCreate = useCreateIssue();
  const update = useUpdateIssue();
  const toast = useToast();
  const [zoom, setZoom] = useState<Zoom>('months');
  const [drag, setDrag] = useState<Drag | null>(null);
  // Dates saved but not yet refetched, so bars don't jump back while the request runs.
  const [pending, setPending] = useState<Record<string, { start: number; due: number }>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const px = ZOOM[zoom];

  useEffect(() => setPending({}), [epics]);

  const datesOf = (e: EpicProgress) => {
    if (drag?.id === e.id) return shifted(drag);
    if (pending[e.id]) return pending[e.id];
    if (e.startDate && e.dueDate) return { start: dayOf(e.startDate), due: dayOf(e.dueDate) };
    if (e.startDate) return { start: dayOf(e.startDate), due: dayOf(e.startDate) + 13 * DAY };
    if (e.dueDate) return { start: dayOf(e.dueDate) - 13 * DAY, due: dayOf(e.dueDate) };
    return null;
  };

  // Visible range: whole months around the scheduled epics and today, with some room ahead.
  const t0 = today();
  const scheduled = epics.map((e) => (e.startDate || e.dueDate ? datesOf(e) : null)).filter((d): d is { start: number; due: number } => !!d);
  const minT = Math.min(t0 - 30 * DAY, ...scheduled.map((d) => d.start));
  const maxT = Math.max(t0 + 90 * DAY, ...scheduled.map((d) => d.due + 30 * DAY));
  const rangeStart = new Date(new Date(minT).getFullYear(), new Date(minT).getMonth(), 1).getTime();
  const rangeEnd = new Date(new Date(maxT).getFullYear(), new Date(maxT).getMonth() + 1, 1).getTime();
  const x = (t: number) => Math.round((t - rangeStart) / DAY) * px;
  const width = x(rangeEnd);

  const months: { t: number; label: string }[] = [];
  for (let d = new Date(rangeStart); d.getTime() < rangeEnd; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const label = d.toLocaleDateString('pt-BR', zoom === 'quarters' ? { month: 'short' } : { month: 'long', year: 'numeric' });
    months.push({ t: d.getTime(), label: label.charAt(0).toUpperCase() + label.slice(1) });
  }
  const weeks: number[] = [];
  if (zoom === 'weeks') {
    const first = new Date(rangeStart);
    first.setDate(first.getDate() + ((8 - first.getDay()) % 7)); // first Monday
    for (let t = first.getTime(); t < rangeEnd; t += 7 * DAY) weeks.push(t);
  }

  // Start scrolled so that "today" sits near the left third.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && !isLoading) el.scrollLeft = Math.max(0, x(t0) - el.clientWidth / 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, zoom]);

  function shifted(d: Drag) {
    const delta = d.deltaDays * DAY;
    if (d.mode === 'move') return { start: d.start + delta, due: d.due + delta };
    if (d.mode === 'start') return { start: Math.min(d.start + delta, d.due), due: d.due };
    return { start: d.start, due: Math.max(d.due + delta, d.start) };
  }

  const save = (e: EpicProgress, dates: { start: number; due: number }) => {
    setPending((p) => ({ ...p, [e.id]: dates }));
    update.mutate(
      { key: e.key, data: { startDate: toIso(dates.start), dueDate: toIso(dates.due) } },
      {
        onError: (err) => {
          toast(err.message, 'error');
          setPending((p) => {
            const { [e.id]: _drop, ...rest } = p;
            return rest;
          });
        },
      },
    );
  };

  const beginDrag = (ev: ReactPointerEvent, e: EpicProgress, mode: Drag['mode']) => {
    const dates = datesOf(e);
    if (!dates) return;
    ev.stopPropagation();
    (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
    setDrag({ id: e.id, mode, originX: ev.clientX, start: dates.start, due: dates.due, deltaDays: 0 });
  };
  const moveDrag = (ev: ReactPointerEvent) => {
    if (!drag) return;
    const deltaDays = Math.round((ev.clientX - drag.originX) / px);
    if (deltaDays !== drag.deltaDays) setDrag({ ...drag, deltaDays });
  };
  const endDrag = (e: EpicProgress) => {
    if (!drag) return;
    const moved = drag.deltaDays !== 0;
    const dates = shifted(drag);
    setDrag(null);
    if (moved) save(e, dates);
    else openIssue(e.key);
  };

  if (isLoading) return <div className="page-center"><Spinner /></div>;

  return (
    <div className="page timeline-page">
      <div className="page-header">
        <div>
          <div className="breadcrumbs muted small">Projetos / {project.name}</div>
          <h1 className="page-title">Cronograma</h1>
          <div className="muted small">Arraste uma barra para mudar as datas do épico, ou puxe as pontas para alterar início e fim.</div>
        </div>
        <div className="row gap-sm">
          <div className="segmented" role="group" aria-label="Escala">
            <button className={zoom === 'weeks' ? 'active' : ''} onClick={() => setZoom('weeks')}>Semanas</button>
            <button className={zoom === 'months' ? 'active' : ''} onClick={() => setZoom('months')}>Meses</button>
            <button className={zoom === 'quarters' ? 'active' : ''} onClick={() => setZoom('quarters')}>Trimestres</button>
          </div>
          <button className="btn btn-primary" onClick={() => openCreate({ projectKey: project.key, type: 'EPIC' })}>
            <Icon name="plus" /> Criar épico
          </button>
        </div>
      </div>

      {epics.length === 0 ? (
        <EmptyState title="Nenhum épico ainda">Épicos agrupam as histórias de uma entrega maior e aparecem aqui numa linha do tempo.</EmptyState>
      ) : (
        <div className="timeline" ref={scroller}>
          <div className="timeline-grid" style={{ width: 320 + width }}>
            <div className="timeline-head">
              <div className="timeline-label-col timeline-corner">Épico</div>
              <div className="timeline-scale" style={{ width }}>
                {months.map((m) => (
                  <div key={m.t} className="timeline-month" style={{ left: x(m.t) }}>{m.label}</div>
                ))}
                {weeks.map((w) => (
                  <div key={w} className="timeline-week" style={{ left: x(w) }}>{new Date(w).getDate()}</div>
                ))}
              </div>
            </div>

            {epics.map((e) => {
              const dates = datesOf(e);
              const pct = e.total ? Math.round((e.done / e.total) * 100) : 0;
              const isDragging = drag?.id === e.id;
              return (
                <div key={e.id} className="timeline-row">
                  <div className="timeline-label-col" onClick={() => openIssue(e.key)}>
                    <IssueTypeIcon type="EPIC" />
                    <span className="key">{e.key}</span>
                    <span className="timeline-title">{e.title}</span>
                    <Avatar user={e.assignee} size={20} />
                    <StatusLozenge status={e.statusRef} />
                  </div>
                  <div className="timeline-track" style={{ width }}>
                    {months.map((m) => <div key={m.t} className="timeline-gridline" style={{ left: x(m.t) }} />)}
                    {dates ? (
                      <div
                        className={`timeline-bar ${isDragging ? 'dragging' : ''} ${isDone(e) ? 'done' : ''}`}
                        style={{ left: x(dates.start), width: Math.max(px, x(dates.due) - x(dates.start) + px) }}
                        title={`${e.key} ${e.title}\n${fmt(dates.start)} – ${fmt(dates.due)}\n${e.total ? `${pct}% concluído (${e.done} de ${e.total} issues)` : 'Sem issues'}`}
                        onPointerDown={(ev) => beginDrag(ev, e, 'move')}
                        onPointerMove={moveDrag}
                        onPointerUp={() => endDrag(e)}
                        onPointerCancel={() => setDrag(null)}
                      >
                        {/* Handles only start a resize; move/up bubble to the bar's handlers below. */}
                        <div className="timeline-progress" style={{ width: `${pct}%` }} />
                        <span className="timeline-bar-label">{e.total ? `${pct}%` : ''}</span>
                        <span className="timeline-handle start" onPointerDown={(ev) => beginDrag(ev, e, 'start')} />
                        <span className="timeline-handle end" onPointerDown={(ev) => beginDrag(ev, e, 'end')} />
                      </div>
                    ) : (
                      <button className="timeline-schedule" style={{ left: x(t0) }} onClick={() => save(e, { start: t0, due: t0 + 13 * DAY })}>
                        + Definir datas
                      </button>
                    )}
                    {isDragging && dates && (
                      <div className="timeline-drag-dates" style={{ left: x(dates.start) }}>
                        {fmt(dates.start)} – {fmt(dates.due)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div className="timeline-today" style={{ left: 320 + x(t0) + px / 2 }} title={`Hoje, ${fmt(t0)}`}>
              <span>Hoje</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
