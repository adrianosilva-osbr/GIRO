import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useMe } from '../auth';
import {
  CREATABLE_TYPES,
  FIELD_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  STATUSES,
  STATUS_LABEL,
  TYPE_LABEL,
  displayValue,
  formatDateTime,
  timeAgo,
} from '../constants';
import { useInvalidateWork, useIssue, useIssues, useOpenIssue, useProject, useSprints, useUpdateIssue } from '../hooks';
import type { Activity, Comment, IssueDetail as IssueDetailT, IssueType, Priority, Status } from '../types';
import { Icon, IssueTypeIcon, PriorityIcon } from './Icons';
import { Avatar, ErrorText, Modal, Spinner, StatusLozenge } from './ui';
import { useCreateIssue } from './CreateIssue';
import { useToast } from './Toast';

export function IssueDetailModal({ issueKey }: { issueKey: string }) {
  const openIssue = useOpenIssue();
  const { data: issue, error, isLoading } = useIssue(issueKey);
  const close = () => openIssue(null);

  return (
    <Modal onClose={close} width={1080}>
      {isLoading && <Spinner />}
      {error && (
        <div className="issue-error">
          <ErrorText error={error} />
          <button className="btn" onClick={close}>Fechar</button>
        </div>
      )}
      {issue && <IssueDetailBody issue={issue} onClose={close} />}
    </Modal>
  );
}

function IssueDetailBody({ issue, onClose }: { issue: IssueDetailT; onClose(): void }) {
  const me = useMe();
  const toast = useToast();
  const openIssue = useOpenIssue();
  const update = useUpdateIssue();
  const invalidate = useInvalidateWork();
  const { data: project } = useProject(issue.project.key);
  const { data: sprints = [] } = useSprints(issue.project.key);
  const { data: epics = [] } = useIssues({ project: issue.project.key, type: 'EPIC' }, issue.type !== 'EPIC' && issue.type !== 'SUBTASK');

  const save = (data: Record<string, unknown>) =>
    update.mutate({ key: issue.key, data }, { onError: (e) => toast(e.message, 'error') });

  const remove = async () => {
    const extra = issue.children.length && issue.type !== 'EPIC' ? ` e suas ${issue.children.length} subtarefa(s)` : '';
    if (!confirm(`Excluir ${issue.key}${extra}? Esta ação não pode ser desfeita.`)) return;
    try {
      await api(`/issues/${issue.key}`, { method: 'DELETE' });
      onClose();
      await invalidate();
      toast(`${issue.key} excluída`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const isAdmin = project?.myRole === 'ADMIN';

  return (
    <div className="issue-detail">
      <div className="issue-detail-top">
        <nav className="breadcrumbs">
          <Link to={`/projects/${issue.project.key}/board`} onClick={onClose}>
            {issue.project.name}
          </Link>
          <span>/</span>
          {issue.parent && (
            <>
              <button className="link breadcrumb-issue" onClick={() => openIssue(issue.parent!.key)}>
                <IssueTypeIcon type={issue.parent.type} size={14} /> {issue.parent.key}
              </button>
              <span>/</span>
            </>
          )}
          <span className="breadcrumb-issue">
            <IssueTypeIcon type={issue.type} size={14} /> {issue.key}
          </span>
        </nav>
        <div className="issue-detail-actions">
          <button className="btn-icon" title="Excluir issue" onClick={remove}>
            <Icon name="trash" />
          </button>
          <button className="btn-icon" title="Fechar" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
      </div>

      <div className="issue-detail-grid">
        <div className="issue-main">
          <EditableTitle value={issue.title} onSave={(title) => save({ title })} />
          <Description key={issue.id + issue.updatedAt} value={issue.description} onSave={(description) => save({ description })} />
          {issue.type !== 'SUBTASK' && <ChildIssues issue={issue} />}
          <ActivitySection issue={issue} meId={me.id} isAdmin={isAdmin} />
        </div>

        <aside className="issue-side">
          <select
            className={`status-select status-${issue.status.toLowerCase()}`}
            value={issue.status}
            onChange={(e) => save({ status: e.target.value as Status })}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>

          <div className="details-box">
            <h4>Detalhes</h4>
            <Detail label="Responsável">
              <div className="inline-select">
                <Avatar user={issue.assignee} size={24} />
                <select value={issue.assigneeId ?? ''} onChange={(e) => save({ assigneeId: e.target.value || null })}>
                  <option value="">Não atribuído</option>
                  {project?.members?.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.user.name}
                    </option>
                  ))}
                </select>
              </div>
              {issue.assigneeId !== me.id && project?.members?.some((m) => m.userId === me.id) && (
                <button className="link small" onClick={() => save({ assigneeId: me.id })}>
                  Atribuir a mim
                </button>
              )}
            </Detail>
            <Detail label="Relator">
              <div className="inline-value">
                <Avatar user={issue.reporter} size={24} /> {issue.reporter.name}
              </div>
            </Detail>
            <Detail label="Tipo">
              <div className="inline-select">
                <IssueTypeIcon type={issue.type} />
                {issue.type === 'SUBTASK' ? (
                  <span>{TYPE_LABEL.SUBTASK}</span>
                ) : (
                  <select value={issue.type} onChange={(e) => save({ type: e.target.value as IssueType })}>
                    {CREATABLE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </Detail>
            <Detail label="Prioridade">
              <div className="inline-select">
                <PriorityIcon priority={issue.priority} />
                <select value={issue.priority} onChange={(e) => save({ priority: e.target.value as Priority })}>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </select>
              </div>
            </Detail>
            {issue.type !== 'EPIC' && issue.type !== 'SUBTASK' && (
              <Detail label="Épico">
                <select value={issue.parentId ?? ''} onChange={(e) => save({ parentId: e.target.value || null })}>
                  <option value="">Nenhum</option>
                  {epics.map((ep) => (
                    <option key={ep.id} value={ep.id}>
                      {ep.key} — {ep.title}
                    </option>
                  ))}
                </select>
              </Detail>
            )}
            {issue.type !== 'EPIC' && (
              <Detail label="Sprint">
                {issue.type === 'SUBTASK' ? (
                  <span className="muted">{issue.sprint?.name ?? 'Backlog'} (segue a issue pai)</span>
                ) : (
                  <select value={issue.sprintId ?? ''} onChange={(e) => save({ sprintId: e.target.value || null })}>
                    <option value="">Backlog</option>
                    {issue.sprint?.status === 'CLOSED' && <option value={issue.sprint.id}>{issue.sprint.name} (encerrada)</option>}
                    {sprints.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.status === 'ACTIVE' ? ' (ativa)' : ''}
                      </option>
                    ))}
                  </select>
                )}
              </Detail>
            )}
            <Detail label="Story points">
              <BlurInput
                type="number"
                value={issue.storyPoints?.toString() ?? ''}
                placeholder="Nenhum"
                onSave={(v) => save({ storyPoints: v === '' ? null : Number(v) })}
              />
            </Detail>
            <Detail label="Etiquetas">
              <BlurInput
                value={issue.labels.join(', ')}
                placeholder="Nenhuma"
                onSave={(v) => save({ labels: v.split(',').map((l) => l.trim()).filter(Boolean) })}
              />
              {issue.labels.length > 0 && (
                <div className="labels">
                  {issue.labels.map((l) => (
                    <span key={l} className="label-chip">{l}</span>
                  ))}
                </div>
              )}
            </Detail>
            <Detail label="Data limite">
              <input
                type="date"
                value={issue.dueDate?.slice(0, 10) ?? ''}
                onChange={(e) => save({ dueDate: e.target.value || null })}
              />
            </Detail>
          </div>
          <div className="meta-dates muted small">
            <div>Criado {formatDateTime(issue.createdAt)}</div>
            <div>Atualizado {formatDateTime(issue.updatedAt)}</div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="detail-row">
      <div className="detail-label">{label}</div>
      <div className="detail-value">{children}</div>
    </div>
  );
}

function BlurInput({
  value,
  onSave,
  ...rest
}: { value: string; onSave(v: string): void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value);
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    setDraft(value);
  }
  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onSave(draft)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function EditableTitle({ value, onSave }: { value: string; onSave(v: string): void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return (
      <h1 className="issue-title" onClick={() => { setDraft(value); setEditing(true); }} title="Clique para editar">
        {value}
      </h1>
    );
  }
  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== value) onSave(draft.trim());
  };
  return (
    <input
      className="issue-title-input"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); }
      }}
    />
  );
}

function Description({ value, onSave }: { value: string; onSave(v: string): void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <section className="issue-section">
      <h3>Descrição</h3>
      {editing ? (
        <div>
          <textarea autoFocus rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="row gap-sm mt-sm">
            <button className="btn btn-primary" onClick={() => { onSave(draft); setEditing(false); }}>
              Salvar
            </button>
            <button className="btn btn-subtle" onClick={() => { setDraft(value); setEditing(false); }}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div className={`description ${value ? '' : 'placeholder'}`} onClick={() => setEditing(true)}>
          {value || 'Adicionar uma descrição…'}
        </div>
      )}
    </section>
  );
}

function ChildIssues({ issue }: { issue: IssueDetailT }) {
  const openIssue = useOpenIssue();
  const openCreate = useCreateIssue();
  const invalidate = useInvalidateWork();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const isEpic = issue.type === 'EPIC';
  const done = issue.children.filter((c) => c.status === 'DONE').length;
  const total = issue.children.length;

  const addSubtask = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await api('/issues', {
        method: 'POST',
        body: { projectKey: issue.project.key, type: 'SUBTASK', title, parentId: issue.id },
      });
      setTitle('');
      await invalidate();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <section className="issue-section">
      <div className="row space-between">
        <h3>{isEpic ? 'Issues neste épico' : 'Subtarefas'}</h3>
        <button
          className="btn-icon"
          title={isEpic ? 'Adicionar issue ao épico' : 'Adicionar subtarefa'}
          onClick={() => (isEpic ? openCreate({ projectKey: issue.project.key, type: 'STORY', parentId: issue.id }) : setAdding(true))}
        >
          <Icon name="plus" />
        </button>
      </div>
      {total > 0 && (
        <div className="progress" title={`${done} de ${total} concluídas`}>
          <div className="progress-track">
            <div className="progress-bar" style={{ width: `${(done / total) * 100}%` }} />
          </div>
          <span className="small muted">{Math.round((done / total) * 100)}% concluído</span>
        </div>
      )}
      <ul className="child-list">
        {issue.children.map((c) => (
          <li key={c.id} onClick={() => openIssue(c.key)}>
            <IssueTypeIcon type={c.type} />
            <span className={`key ${c.status === 'DONE' ? 'done' : ''}`}>{c.key}</span>
            <span className="child-title">{c.title}</span>
            <PriorityIcon priority={c.priority} />
            <Avatar user={c.assignee} size={22} />
            <StatusLozenge status={c.status} />
          </li>
        ))}
      </ul>
      {total === 0 && !adding && (
        <p className="muted small">{isEpic ? 'Nenhuma issue vinculada a este épico.' : 'Nenhuma subtarefa.'}</p>
      )}
      {adding && (
        <form onSubmit={addSubtask} className="row gap-sm mt-sm">
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="O que precisa ser feito?" />
          <button className="btn btn-primary" type="submit">Criar</button>
          <button className="btn btn-subtle" type="button" onClick={() => setAdding(false)}>Cancelar</button>
        </form>
      )}
    </section>
  );
}

function ActivitySection({ issue, meId, isAdmin }: { issue: IssueDetailT; meId: string; isAdmin: boolean }) {
  const [tab, setTab] = useState<'comments' | 'history'>('comments');
  return (
    <section className="issue-section">
      <h3>Atividade</h3>
      <div className="tabs">
        <button className={tab === 'comments' ? 'active' : ''} onClick={() => setTab('comments')}>
          Comentários ({issue.comments.length})
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          Histórico
        </button>
      </div>
      {tab === 'comments' ? (
        <Comments issue={issue} meId={meId} isAdmin={isAdmin} />
      ) : (
        <ul className="history">
          {issue.activities.map((a) => (
            <HistoryItem key={a.id} activity={a} />
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryItem({ activity: a }: { activity: Activity }) {
  let text: ReactNode;
  if (a.action === 'created') text = 'criou a issue';
  else if (a.action === 'commented') text = 'adicionou um comentário';
  else if (a.field === 'description') text = 'atualizou a descrição';
  else {
    const field = a.field ?? '';
    text = (
      <>
        alterou <b>{FIELD_LABEL[field] ?? field}</b>:{' '}
        <span className="history-from">{displayValue(field, a.fromValue)}</span> →{' '}
        <span className="history-to">{displayValue(field, a.toValue)}</span>
      </>
    );
  }
  return (
    <li>
      <Avatar user={a.user} size={28} />
      <div>
        <div>
          <b>{a.user.name}</b> {text}
        </div>
        <div className="muted small" title={formatDateTime(a.createdAt)}>{timeAgo(a.createdAt)}</div>
      </div>
    </li>
  );
}

function Comments({ issue, meId, isAdmin }: { issue: IssueDetailT; meId: string; isAdmin: boolean }) {
  const [body, setBody] = useState('');
  const [focused, setFocused] = useState(false);
  const invalidate = useInvalidateWork();
  const toast = useToast();

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    try {
      await api(`/issues/${issue.key}/comments`, { method: 'POST', body: { body } });
      setBody('');
      setFocused(false);
      await invalidate();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div>
      <form onSubmit={add} className="comment-form">
        <textarea
          rows={focused ? 4 : 1}
          value={body}
          onFocus={() => setFocused(true)}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Adicionar um comentário…"
        />
        {focused && (
          <div className="row gap-sm mt-sm">
            <button className="btn btn-primary" type="submit" disabled={!body.trim()}>Salvar</button>
            <button className="btn btn-subtle" type="button" onClick={() => { setBody(''); setFocused(false); }}>Cancelar</button>
          </div>
        )}
      </form>
      <ul className="comments">
        {[...issue.comments].reverse().map((c) => (
          <CommentItem key={c.id} comment={c} canEdit={c.authorId === meId} canDelete={c.authorId === meId || isAdmin} />
        ))}
      </ul>
    </div>
  );
}

function CommentItem({ comment, canEdit, canDelete }: { comment: Comment; canEdit: boolean; canDelete: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const invalidate = useInvalidateWork();
  const toast = useToast();

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await invalidate();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <li>
      <Avatar user={comment.author} size={28} />
      <div className="comment-content">
        <div>
          <b>{comment.author.name}</b>{' '}
          <span className="muted small" title={formatDateTime(comment.createdAt)}>
            {timeAgo(comment.createdAt)}
            {comment.updatedAt !== comment.createdAt && ' (editado)'}
          </span>
        </div>
        {editing ? (
          <>
            <textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <div className="row gap-sm mt-sm">
              <button className="btn btn-primary" onClick={() => run(async () => {
                await api(`/comments/${comment.id}`, { method: 'PATCH', body: { body: draft } });
                setEditing(false);
              })}>Salvar</button>
              <button className="btn btn-subtle" onClick={() => setEditing(false)}>Cancelar</button>
            </div>
          </>
        ) : (
          <div className="comment-body">{comment.body}</div>
        )}
        {!editing && (canEdit || canDelete) && (
          <div className="comment-actions">
            {canEdit && <button className="link small" onClick={() => setEditing(true)}>Editar</button>}
            {canDelete && (
              <button className="link small" onClick={() => confirm('Excluir este comentário?') && run(() => api(`/comments/${comment.id}`, { method: 'DELETE' }))}>
                Excluir
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
