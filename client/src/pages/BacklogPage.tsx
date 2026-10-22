import { useState, type FormEvent, type ReactNode } from 'react';
import { useOutletContext } from 'react-router-dom';
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
} from '@dnd-kit/core';
import { api } from '../api';
import { CREATABLE_TYPES, TYPE_LABEL, formatDate, isDone } from '../constants';
import { issuesKey, useInvalidateWork, useIssues, useMoveIssue, useOpenIssue, useSprints } from '../hooks';
import { collision, dropTarget, issueDropId, listDropId, rankForDrop, type DropTarget } from '../dnd';
import type { Issue, IssueType, Project, Sprint } from '../types';
import { Icon, IssueTypeIcon, PriorityIcon } from '../components/Icons';
import { Avatar, Spinner, StatusLozenge } from '../components/ui';
import { QuickFilters, useQuickFilters } from '../components/QuickFilters';
import { CompleteSprintModal, EditSprintModal, StartSprintModal } from '../components/SprintModals';
import { useToast } from '../components/Toast';

const BACKLOG = 'backlog';

export function BacklogPage() {
  const project = useOutletContext<Project>();
  const filters = { project: project.key, sprint: 'open', excludeType: 'EPIC,SUBTASK' };
  const listKey = issuesKey(filters);
  const { data: issues = [], isLoading } = useIssues(filters);
  const { data: sprints = [], isLoading: loadingSprints } = useSprints(project.key);
  const { data: epics = [] } = useIssues({ project: project.key, type: 'EPIC' });
  const quick = useQuickFilters();
  const move = useMoveIssue(listKey);
  const invalidate = useInvalidateWork();
  const toast = useToast();
  const [dragging, setDragging] = useState<Issue | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const visible = quick.apply(issues);
  const listOf = (listId: string) => visible.filter((i) => (i.sprintId ?? BACKLOG) === listId);
  const hasActive = sprints.some((s) => s.status === 'ACTIVE');

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
    const rank = rankForDrop(listOf(t.listId).filter((i) => i.id !== issue.id), t);
    const sprintId = t.listId === BACKLOG ? null : t.listId;
    const data: Partial<Issue> = { rank };
    if (sprintId !== issue.sprintId) data.sprintId = sprintId;
    move.mutate({ issue, data }, { onError: (err) => toast(err.message, 'error') });
  };

  const createSprint = async () => {
    try {
      await api(`/projects/${project.key}/sprints`, { method: 'POST', body: {} });
      await invalidate();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  if (isLoading || loadingSprints) return <div className="page-center"><Spinner /></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumbs muted small">Projetos / {project.name}</div>
          <h1 className="page-title">Backlog</h1>
        </div>
      </div>
      <QuickFilters members={project.members ?? []} epics={epics} filters={quick} />

      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={(e) => setDragging(issues.find((i) => i.id === e.active.id) ?? null)}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={() => { setDragging(null); setTarget(null); }}
      >
        {sprints.map((s) => (
          <IssueGroup
            key={s.id}
            listId={s.id}
            sprint={s}
            issues={listOf(s.id)}
            project={project}
            target={target}
            draggingId={dragging?.id}
            canStart={!hasActive}
          />
        ))}
        <IssueGroup
          listId={BACKLOG}
          issues={listOf(BACKLOG)}
          project={project}
          target={target}
          draggingId={dragging?.id}
          headerAction={<button className="btn" onClick={createSprint}>Criar sprint</button>}
        />
        <DragOverlay>{dragging && <div className="backlog-row overlay"><RowContent issue={dragging} /></div>}</DragOverlay>
      </DndContext>
    </div>
  );
}

function IssueGroup({
  listId,
  sprint,
  issues,
  project,
  target,
  draggingId,
  canStart,
  headerAction,
}: {
  listId: string;
  sprint?: Sprint;
  issues: Issue[];
  project: Project;
  target: DropTarget | null;
  draggingId?: string;
  canStart?: boolean;
  headerAction?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [modal, setModal] = useState<'start' | 'complete' | 'edit' | null>(null);
  const [menu, setMenu] = useState(false);
  const { setNodeRef } = useDroppable({ id: listDropId(listId), data: { listId } });
  const invalidate = useInvalidateWork();
  const toast = useToast();
  const isTarget = target?.listId === listId;
  const points = issues.reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);
  const byCategory = (c: string) => issues.filter((i) => i.statusRef?.category === c).length;

  const deleteSprint = async () => {
    setMenu(false);
    if (!sprint || !confirm(`Excluir ${sprint.name}? As issues voltarão para o backlog.`)) return;
    try {
      await api(`/sprints/${sprint.id}`, { method: 'DELETE' });
      await invalidate();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <section className={`backlog-group ${sprint ? 'is-sprint' : ''} ${isTarget ? 'drop-active' : ''}`}>
      <header className="backlog-group-header">
        <button className="btn-icon" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Expandir' : 'Recolher'}>
          <span className={`chevron ${collapsed ? 'collapsed' : ''}`}><Icon name="chevron" /></span>
        </button>
        <b>{sprint ? sprint.name : 'Backlog'}</b>
        {sprint?.status === 'ACTIVE' && <span className="tag tag-blue">Ativa</span>}
        {sprint?.startDate && (
          <span className="muted small">{formatDate(sprint.startDate)} – {formatDate(sprint.endDate)}</span>
        )}
        <span className="muted small">({issues.length} issue{issues.length === 1 ? '' : 's'})</span>
        <div className="spacer" />
        <span className="status-counts" title="A fazer / Em andamento / Concluído">
          <span className="sc sc-todo">{byCategory('TODO')}</span>
          <span className="sc sc-progress">{byCategory('IN_PROGRESS')}</span>
          <span className="sc sc-done">{byCategory('DONE')}</span>
        </span>
        {points > 0 && <span className="points" title="Story points">{points}</span>}
        {sprint?.status === 'PLANNED' && (
          <button
            className="btn"
            disabled={!canStart || issues.length === 0}
            title={!canStart ? 'Já existe uma sprint ativa' : issues.length === 0 ? 'Adicione issues à sprint' : ''}
            onClick={() => setModal('start')}
          >
            Iniciar sprint
          </button>
        )}
        {sprint?.status === 'ACTIVE' && <button className="btn" onClick={() => setModal('complete')}>Concluir sprint</button>}
        {headerAction}
        {sprint && (
          <div className="menu-wrap">
            <button className="btn-icon" onClick={() => setMenu((m) => !m)} aria-label="Mais ações"><Icon name="more" /></button>
            {menu && (
              <div className="dropdown right" onMouseLeave={() => setMenu(false)}>
                <button onClick={() => { setMenu(false); setModal('edit'); }}><Icon name="edit" /> Editar sprint</button>
                {sprint.status === 'PLANNED' && <button onClick={deleteSprint}><Icon name="trash" /> Excluir sprint</button>}
              </div>
            )}
          </div>
        )}
      </header>
      {sprint?.goal && !collapsed && <div className="sprint-goal muted small">{sprint.goal}</div>}

      {!collapsed && (
        <>
          <div ref={setNodeRef} className="backlog-list">
            {issues.map((i) => (
              <Row
                key={i.id}
                issue={i}
                listId={listId}
                indicator={isTarget && target?.overIssueId === i.id && draggingId !== i.id ? (target.after ? 'after' : 'before') : null}
              />
            ))}
            {issues.length === 0 && (
              <div className="backlog-empty">
                {sprint ? 'Arraste issues para cá para planejar esta sprint.' : 'O backlog está vazio.'}
              </div>
            )}
          </div>
          <InlineCreate projectKey={project.key} sprintId={sprint?.id ?? null} />
        </>
      )}

      {sprint && modal === 'start' && <StartSprintModal sprint={sprint} issueCount={issues.length} onClose={() => setModal(null)} />}
      {sprint && modal === 'complete' && <CompleteSprintModal sprint={sprint} projectKey={project.key} onClose={() => setModal(null)} />}
      {sprint && modal === 'edit' && <EditSprintModal sprint={sprint} onClose={() => setModal(null)} />}
    </section>
  );
}

function Row({ issue, listId, indicator }: { issue: Issue; listId: string; indicator: 'before' | 'after' | null }) {
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
      className={`backlog-row ${drag.isDragging ? 'dragging' : ''} ${indicator ? `indicator-${indicator}` : ''}`}
      onClick={() => openIssue(issue.key)}
    >
      <RowContent issue={issue} />
    </div>
  );
}

function RowContent({ issue }: { issue: Issue }) {
  return (
    <>
      <IssueTypeIcon type={issue.type} />
      <span className={`key ${isDone(issue) ? 'done' : ''}`}>{issue.key}</span>
      <span className="row-title">{issue.title}</span>
      {issue.parent?.type === 'EPIC' && <span className="epic-chip">{issue.parent.title}</span>}
      {issue._count.children > 0 && <span className="muted small" title="Subtarefas">⧉ {issue._count.children}</span>}
      <StatusLozenge status={issue.statusRef} />
      <span className="points" title="Story points">{issue.storyPoints ?? '-'}</span>
      <PriorityIcon priority={issue.priority} />
      <Avatar user={issue.assignee} size={24} />
    </>
  );
}

function InlineCreate({ projectKey, sprintId }: { projectKey: string; sprintId: string | null }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [type, setType] = useState<IssueType>('STORY');
  const invalidate = useInvalidateWork();
  const toast = useToast();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await api('/issues', { method: 'POST', body: { projectKey, type, title, sprintId } });
      setTitle('');
      await invalidate();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  if (!open) {
    return (
      <button className="inline-create-btn" onClick={() => setOpen(true)}>
        <Icon name="plus" /> Criar issue
      </button>
    );
  }
  return (
    <form className="inline-create" onSubmit={submit}>
      <select value={type} onChange={(e) => setType(e.target.value as IssueType)} aria-label="Tipo">
        {CREATABLE_TYPES.filter((t) => t !== 'EPIC').map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
      </select>
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="O que precisa ser feito? (Enter para criar, Esc para fechar)"
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      />
      <button className="btn btn-primary" type="submit" disabled={!title.trim()}>Criar</button>
      <button className="btn btn-subtle" type="button" onClick={() => setOpen(false)}>Cancelar</button>
    </form>
  );
}
