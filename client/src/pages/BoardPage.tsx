import { useMemo, useState, type ReactNode } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { daysLeft, formatDate, isDone } from '../constants';
import { issuesKey, useIssues, useMoveIssue, useOpenIssue, useSprints } from '../hooks';
import { collision, dropTarget, issueDropId, rankForDrop, type DropTarget } from '../dnd';
import type { Issue, Project, ProjectStatus } from '../types';
import { Icon, IssueTypeIcon, PriorityIcon } from '../components/Icons';
import { Avatar, Spinner } from '../components/ui';
import { QuickFilters, useQuickFilters } from '../components/QuickFilters';
import { CompleteSprintModal } from '../components/SprintModals';
import { useToast } from '../components/Toast';

type GroupBy = 'none' | 'assignee' | 'epic';

interface Lane {
  id: string;
  title: ReactNode;
  issues: Issue[];
}

const groupKey = (project: string) => `giro:board-group:${project}`;
function loadGroup(project: string): GroupBy {
  try {
    const v = localStorage.getItem(groupKey(project));
    return v === 'assignee' || v === 'epic' ? v : 'none';
  } catch {
    return 'none';
  }
}

/** Epic an issue rolls up to: its parent epic, or — for subtasks — the parent's epic. */
function epicOf(i: Issue) {
  if (!i.parent) return null;
  if (i.parent.type === 'EPIC') return i.parent.id;
  return i.type === 'SUBTASK' ? i.parent.parentId : null;
}

export function BoardPage() {
  const project = useOutletContext<Project>();
  const statuses = project.statuses ?? [];
  const { data: sprints, isLoading: loadingSprints } = useSprints(project.key);
  const active = sprints?.find((s) => s.status === 'ACTIVE');
  // Without an active sprint the board works as a plain Kanban over all open work.
  const filters = { project: project.key, sprint: active ? 'active' : 'open', excludeType: 'EPIC' };
  const listKey = issuesKey(filters);
  const { data: issues = [], isLoading } = useIssues(filters, !loadingSprints);
  const { data: epics = [] } = useIssues({ project: project.key, type: 'EPIC' });
  const quick = useQuickFilters();
  const move = useMoveIssue(listKey);
  const toast = useToast();
  const [dragging, setDragging] = useState<Issue | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [completing, setCompleting] = useState(false);
  const [groupBy, setGroupByState] = useState<GroupBy>(() => loadGroup(project.key));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const setGroupBy = (g: GroupBy) => {
    setGroupByState(g);
    try {
      localStorage.setItem(groupKey(project.key), g);
    } catch {
      // preference just won't persist
    }
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const visible = quick.apply(issues);

  // WIP counts use the whole column, not just what the quick filters show.
  const columnCount = useMemo(() => {
    const out: Record<string, number> = {};
    for (const i of issues) out[i.status] = (out[i.status] ?? 0) + 1;
    return out;
  }, [issues]);

  const lanes: Lane[] = useMemo(() => {
    if (groupBy === 'assignee') {
      const people = (project.members ?? []).map((m) => m.user);
      const lanesOut = people.map((u) => ({
        id: u.id,
        title: <span className="row gap-sm"><Avatar user={u} size={22} /> {u.name}</span>,
        issues: visible.filter((i) => i.assigneeId === u.id),
      }));
      lanesOut.push({ id: 'none', title: <span className="row gap-sm"><Avatar user={null} size={22} /> Não atribuído</span>, issues: visible.filter((i) => !i.assigneeId) });
      return lanesOut.filter((l) => l.issues.length);
    }
    if (groupBy === 'epic') {
      const lanesOut = epics.map((e) => ({
        id: e.id,
        title: <span className="row gap-sm"><IssueTypeIcon type="EPIC" /> {e.title} <span className="key">{e.key}</span></span>,
        issues: visible.filter((i) => epicOf(i) === e.id),
      }));
      lanesOut.push({ id: 'none', title: <span className="muted">Sem épico</span>, issues: visible.filter((i) => !epicOf(i)) });
      return lanesOut.filter((l) => l.issues.length);
    }
    return [{ id: 'all', title: null, issues: visible }];
  }, [groupBy, visible, epics, project.members]);

  const onDragStart = (e: DragStartEvent) => setDragging(issues.find((i) => i.id === e.active.id) ?? null);
  const onDragMove = (e: DragMoveEvent) => {
    const t = dropTarget(e);
    if (t?.overIssueId !== target?.overIssueId || t?.after !== target?.after || t?.listId !== target?.listId) setTarget(t);
  };
  const onDragEnd = (e: DragEndEvent) => {
    const t = dropTarget(e);
    setDragging(null);
    setTarget(null);
    const issue = issues.find((i) => i.id === e.active.id);
    if (!t || !issue || t.overIssueId === issue.id) return;
    // listId is "<lane>|<status>"; dropping into another lane only changes the status.
    const [lane, status] = t.listId.split('|');
    const laneIssues = lanes.find((l) => l.id === lane)?.issues ?? visible;
    const list = laneIssues.filter((i) => i.status === status && i.id !== issue.id);
    const rank = rankForDrop(list, t);
    const data: Partial<Issue> = { rank };
    if (status !== issue.status) {
      data.status = status;
      const next = statuses.find((s) => s.key === status);
      if (next) data.statusRef = { key: next.key, name: next.name, category: next.category };
    }
    move.mutate({ issue, data }, { onError: (err) => toast(err.message, 'error') });
  };

  if (loadingSprints || isLoading) return <div className="page-center"><Spinner /></div>;

  const remaining = daysLeft(active?.endDate ?? null);
  const columns = { gridTemplateColumns: `repeat(${statuses.length}, minmax(240px, 1fr))` };

  return (
    <div className="page board-page">
      <div className="page-header">
        <div>
          <div className="breadcrumbs muted small">Projetos / {project.name}</div>
          <h1 className="page-title">{active ? active.name : `Quadro ${project.key}`}</h1>
          {active?.goal && <div className="muted">{active.goal}</div>}
        </div>
        {active && (
          <div className="row gap-sm">
            {remaining != null && (
              <span className="muted small" title={`${formatDate(active.startDate)} – ${formatDate(active.endDate)}`}>
                {remaining >= 0 ? `${remaining} dia(s) restante(s)` : `Atrasada há ${-remaining} dia(s)`}
              </span>
            )}
            <button className="btn" onClick={() => setCompleting(true)}>Concluir sprint</button>
          </div>
        )}
      </div>
      {!active && (
        <div className="notice">
          Nenhuma sprint ativa — o quadro mostra todas as issues em aberto. <Link to="../backlog">Planeje uma sprint no backlog</Link>.
        </div>
      )}
      <div className="board-toolbar">
        <QuickFilters members={project.members ?? []} epics={epics} filters={quick} />
        <label className="row gap-sm group-by">
          <span className="muted small nowrap">Agrupar por</span>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            <option value="none">Nenhum</option>
            <option value="assignee">Responsável</option>
            <option value="epic">Épico</option>
          </select>
        </label>
      </div>

      <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={() => { setDragging(null); setTarget(null); }}>
        <div className="board-scroll">
          <div className="board-grid board-head" style={columns}>
            {statuses.map((s) => (
              <ColumnHeader key={s.key} status={s} count={columnCount[s.key] ?? 0} />
            ))}
          </div>
          {lanes.map((lane) => {
            const isCollapsed = collapsed.has(lane.id);
            return (
              <div key={lane.id} className={`lane ${lane.title ? 'has-title' : ''}`}>
                {lane.title && (
                  <button
                    className="lane-header"
                    onClick={() => setCollapsed((c) => {
                      const next = new Set(c);
                      if (next.has(lane.id)) next.delete(lane.id);
                      else next.add(lane.id);
                      return next;
                    })}
                  >
                    <span className={`chevron ${isCollapsed ? 'collapsed' : ''}`}><Icon name="chevron" /></span>
                    {lane.title}
                    <span className="muted small">{lane.issues.length} issue(s)</span>
                  </button>
                )}
                {!isCollapsed && (
                  <div className="board-grid" style={columns}>
                    {statuses.map((s) => (
                      <Column
                        key={s.key}
                        laneId={lane.id}
                        status={s}
                        issues={lane.issues.filter((i) => i.status === s.key)}
                        target={target}
                        draggingId={dragging?.id}
                        overLimit={!!s.wipLimit && (columnCount[s.key] ?? 0) > s.wipLimit}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {lanes.length === 0 && <p className="muted board-empty">Nenhuma issue corresponde aos filtros.</p>}
        </div>
        <DragOverlay>{dragging && <CardView issue={dragging} overlay />}</DragOverlay>
      </DndContext>

      {completing && active && <CompleteSprintModal sprint={active} projectKey={project.key} onClose={() => setCompleting(false)} />}
    </div>
  );
}

function ColumnHeader({ status, count }: { status: ProjectStatus; count: number }) {
  const over = !!status.wipLimit && count > status.wipLimit;
  return (
    <div
      className={`board-column-header ${over ? 'over-limit' : ''}`}
      title={status.wipLimit ? `${count} issue(s) · limite de WIP: ${status.wipLimit}${over ? ' — acima do limite' : ''}` : undefined}
    >
      <span className="col-name">{status.name}</span>
      <span className="count">
        {count}
        {status.wipLimit ? ` / ${status.wipLimit}` : ''}
      </span>
      {over && <span className="wip-flag" role="img" aria-label="Acima do limite de WIP">⚠</span>}
      {status.category === 'DONE' && !over && <span className="done-check">✓</span>}
    </div>
  );
}

function Column({
  laneId,
  status,
  issues,
  target,
  draggingId,
  overLimit,
}: {
  laneId: string;
  status: ProjectStatus;
  issues: Issue[];
  target: DropTarget | null;
  draggingId?: string;
  overLimit: boolean;
}) {
  const listId = `${laneId}|${status.key}`;
  const { setNodeRef } = useDroppable({ id: `list:${listId}`, data: { listId } });
  const isTarget = target?.listId === listId;
  return (
    <div ref={setNodeRef} className={`board-column-body ${isTarget ? 'drop-active' : ''} ${overLimit ? 'over-limit' : ''}`}>
      {issues.map((i) => (
        <Card
          key={i.id}
          issue={i}
          listId={listId}
          indicator={isTarget && target?.overIssueId === i.id && draggingId !== i.id ? (target.after ? 'after' : 'before') : null}
        />
      ))}
      {isTarget && !target?.overIssueId && <div className="drop-line" />}
    </div>
  );
}

function Card({ issue, listId, indicator }: { issue: Issue; listId: string; indicator: 'before' | 'after' | null }) {
  const openIssue = useOpenIssue();
  const drag = useDraggable({ id: issue.id });
  const drop = useDroppable({ id: issueDropId(issue.id), data: { listId, issueId: issue.id } });
  return (
    <div
      ref={(node) => {
        drag.setNodeRef(node);
        drop.setNodeRef(node);
      }}
      {...drag.attributes}
      {...drag.listeners}
      className={`card-wrap ${drag.isDragging ? 'dragging' : ''} ${indicator ? `indicator-${indicator}` : ''}`}
      onClick={() => openIssue(issue.key)}
    >
      <CardView issue={issue} />
    </div>
  );
}

function CardView({ issue, overlay }: { issue: Issue; overlay?: boolean }) {
  return (
    <div className={`card ${overlay ? 'card-overlay' : ''}`}>
      <div className="card-title">{issue.title}</div>
      {(issue.labels.length > 0 || issue.parent) && (
        <div className="card-tags">
          {issue.parent?.type === 'EPIC' && <span className="epic-chip">{issue.parent.title}</span>}
          {issue.type === 'SUBTASK' && issue.parent && <span className="parent-chip">{issue.parent.key}</span>}
          {issue.labels.map((l) => <span key={l} className="label-chip">{l}</span>)}
        </div>
      )}
      <div className="card-footer">
        <IssueTypeIcon type={issue.type} />
        <span className={`key ${isDone(issue) ? 'done' : ''}`}>{issue.key}</span>
        <div className="spacer" />
        {issue.storyPoints != null && <span className="points">{issue.storyPoints}</span>}
        <PriorityIcon priority={issue.priority} />
        <Avatar user={issue.assignee} size={24} />
      </div>
    </div>
  );
}
