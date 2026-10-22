import { useMemo, useState } from 'react';
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
import { STATUSES, STATUS_LABEL, daysLeft, formatDate } from '../constants';
import { issuesKey, useIssues, useMoveIssue, useOpenIssue, useSprints } from '../hooks';
import { collision, dropTarget, issueDropId, listDropId, rankForDrop, type DropTarget } from '../dnd';
import type { Issue, Project, Status } from '../types';
import { IssueTypeIcon, PriorityIcon } from '../components/Icons';
import { Avatar, Spinner } from '../components/ui';
import { QuickFilters, useQuickFilters } from '../components/QuickFilters';
import { CompleteSprintModal } from '../components/SprintModals';
import { useToast } from '../components/Toast';

export function BoardPage() {
  const project = useOutletContext<Project>();
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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const visible = quick.apply(issues);
  const columns = useMemo(() => {
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, [] as Issue[]])) as Record<Status, Issue[]>;
    for (const i of visible) byStatus[i.status].push(i);
    return byStatus;
  }, [visible]);

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
    const status = t.listId as Status;
    const list = columns[status].filter((i) => i.id !== issue.id);
    const rank = rankForDrop(list, t);
    const data: Partial<Issue> = { rank };
    if (status !== issue.status) data.status = status;
    move.mutate({ issue, data }, { onError: (err) => toast(err.message, 'error') });
  };

  if (loadingSprints || isLoading) return <div className="page-center"><Spinner /></div>;

  const remaining = daysLeft(active?.endDate ?? null);

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
      <QuickFilters members={project.members ?? []} epics={epics} filters={quick} />

      <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={() => { setDragging(null); setTarget(null); }}>
        <div className="board">
          {STATUSES.map((status) => (
            <Column key={status} status={status} issues={columns[status]} target={target} draggingId={dragging?.id} />
          ))}
        </div>
        <DragOverlay>{dragging && <CardView issue={dragging} overlay />}</DragOverlay>
      </DndContext>

      {completing && active && <CompleteSprintModal sprint={active} projectKey={project.key} onClose={() => setCompleting(false)} />}
    </div>
  );
}

function Column({ status, issues, target, draggingId }: { status: Status; issues: Issue[]; target: DropTarget | null; draggingId?: string }) {
  const { setNodeRef } = useDroppable({ id: listDropId(status), data: { listId: status } });
  const isTarget = target?.listId === status;
  return (
    <div className={`board-column ${isTarget ? 'drop-active' : ''}`}>
      <div className="board-column-header">
        {STATUS_LABEL[status]} <span className="count">{issues.length}</span>
        {status === 'DONE' && <span className="done-check">✓</span>}
      </div>
      <div ref={setNodeRef} className="board-column-body">
        {issues.map((i) => (
          <Card
            key={i.id}
            issue={i}
            status={status}
            indicator={isTarget && target?.overIssueId === i.id && draggingId !== i.id ? (target.after ? 'after' : 'before') : null}
          />
        ))}
        {isTarget && !target?.overIssueId && <div className="drop-line" />}
      </div>
    </div>
  );
}

function Card({ issue, status, indicator }: { issue: Issue; status: Status; indicator: 'before' | 'after' | null }) {
  const openIssue = useOpenIssue();
  const drag = useDraggable({ id: issue.id });
  const drop = useDroppable({ id: issueDropId(issue.id), data: { listId: status, issueId: issue.id } });
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
        <span className={`key ${issue.status === 'DONE' ? 'done' : ''}`}>{issue.key}</span>
        <div className="spacer" />
        {issue.storyPoints != null && <span className="points">{issue.storyPoints}</span>}
        <PriorityIcon priority={issue.priority} />
        <Avatar user={issue.assignee} size={24} />
      </div>
    </div>
  );
}
