import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useMe } from '../auth';
import {
  CREATABLE_TYPES,
  FIELD_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  TYPE_LABEL,
  displayValue,
  formatDateTime,
  isDone,
  timeAgo,
} from '../constants';
import { useInvalidateWork, useIssue, useIssues, useOpenIssue, useProject, useSprints, useUpdateIssue } from '../hooks';
import type { Activity, Comment, CustomField, IssueDetail as IssueDetailT, IssueType, Priority, User } from '../types';
import { Icon, IssueTypeIcon, PriorityIcon } from './Icons';
import { Avatar, ErrorText, Modal, Spinner, StatusLozenge } from './ui';
import { useCreateIssue } from './CreateIssue';
import { useToast } from './Toast';
import { Markdown } from './Markdown';
import { MarkdownEditor } from './MarkdownEditor';
import { AttachmentsSection, LinksSection, WatchButton, useUploadToIssue } from './IssueExtras';

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
  const members = project?.members?.map((m) => m.user) ?? [];

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
          <WatchButton issue={issue} me={me} />
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
          <Description issue={issue} members={members} onSave={(description) => save({ description })} />
          <AttachmentsSection issue={issue} meId={me.id} isAdmin={isAdmin} />
          {issue.type !== 'SUBTASK' && <ChildIssues issue={issue} />}
          <LinksSection issue={issue} />
          <ActivitySection issue={issue} members={members} meId={me.id} isAdmin={isAdmin} />
        </div>

        <aside className="issue-side">
          <select
            className={`status-select status-${(issue.statusRef?.category ?? 'TODO').toLowerCase()}`}
            value={issue.status}
            onChange={(e) => save({ status: e.target.value })}
            aria-label="Status"
          >
            {(project?.statuses ?? (issue.statusRef ? [issue.statusRef] : [])).map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
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
            <Detail label="Data de início">
              <input
                type="date"
                value={issue.startDate?.slice(0, 10) ?? ''}
                max={issue.dueDate?.slice(0, 10)}
                onChange={(e) => save({ startDate: e.target.value || null })}
              />
            </Detail>
            <Detail label="Data limite">
              <input
                type="date"
                value={issue.dueDate?.slice(0, 10) ?? ''}
                min={issue.startDate?.slice(0, 10)}
                onChange={(e) => save({ dueDate: e.target.value || null })}
              />
            </Detail>
          </div>
          {project?.customFields && project.customFields.length > 0 && (
            <div className="details-box">
              <h4>Campos personalizados</h4>
              {project.customFields.map((f) => (
                <Detail key={f.id} label={f.name}>
                  <CustomFieldInput
                    field={f}
                    value={issue.customValues.find((v) => v.fieldId === f.id)?.value ?? ''}
                    onSave={(value) => save({ customFields: { [f.id]: value === '' ? null : value } })}
                  />
                </Detail>
              ))}
            </div>
          )}
          <div className="meta-dates muted small">
            <div>Criado {formatDateTime(issue.createdAt)}</div>
            <div>Atualizado {formatDateTime(issue.updatedAt)}</div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function CustomFieldInput({ field, value, onSave }: { field: CustomField; value: string; onSave(v: string): void }) {
  if (field.type === 'SELECT') {
    return (
      <select value={value} onChange={(e) => onSave(e.target.value)}>
        <option value="">Nenhum</option>
        {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (field.type === 'DATE') {
    return <input type="date" value={value} onChange={(e) => onSave(e.target.value)} />;
  }
  return (
    <BlurInput
      type={field.type === 'NUMBER' ? 'number' : 'text'}
      step="any"
      value={value}
      placeholder="Nenhum"
      onSave={onSave}
    />
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

function Description({ issue, members, onSave }: { issue: IssueDetailT; members: User[]; onSave(v: string): void }) {
  const value = issue.description;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const upload = useUploadToIssue(issue.key);
  const save = () => {
    if (draft !== value) onSave(draft);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };
  return (
    <section className="issue-section">
      <h3>Descrição</h3>
      {editing ? (
        <div>
          <MarkdownEditor
            autoFocus
            rows={10}
            value={draft}
            onChange={setDraft}
            members={members}
            onUpload={upload}
            attachments={issue.attachments}
            onSubmit={save}
            onCancel={cancel}
            placeholder="Descreva a issue. Cole prints direto aqui."
          />
          <div className="row gap-sm mt-sm">
            <button className="btn btn-primary" onClick={save}>Salvar</button>
            <button className="btn btn-subtle" onClick={cancel}>Cancelar</button>
          </div>
        </div>
      ) : (
        <div
          className={`description ${value ? '' : 'placeholder'}`}
          onClick={(e) => {
            // Clicking a link or image inside the text shouldn't switch to edit mode.
            if ((e.target as HTMLElement).closest('a, img')) return;
            setDraft(value);
            setEditing(true);
          }}
        >
          {value ? <Markdown source={value} attachments={issue.attachments} /> : 'Adicionar uma descrição…'}
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
  const done = issue.children.filter(isDone).length;
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
            <span className={`key ${isDone(c) ? 'done' : ''}`}>{c.key}</span>
            <span className="child-title">{c.title}</span>
            <PriorityIcon priority={c.priority} />
            <Avatar user={c.assignee} size={22} />
            <StatusLozenge status={c.statusRef} />
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

function ActivitySection({ issue, members, meId, isAdmin }: { issue: IssueDetailT; members: User[]; meId: string; isAdmin: boolean }) {
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
        <Comments issue={issue} members={members} meId={meId} isAdmin={isAdmin} />
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
  else if (a.field === 'attachment') {
    text = a.toValue ? <>anexou <b>{a.toValue}</b></> : <>removeu o anexo <span className="history-from">{a.fromValue}</span></>;
  } else if (a.field === 'link') {
    text = a.toValue ? <>vinculou: esta issue <b>{a.toValue}</b></> : <>removeu o vínculo <span className="history-from">{a.fromValue}</span></>;
  } else {
    const field = a.field ?? '';
    text = (
      <>
        alterou <b>{field.startsWith('custom:') ? field.slice(7) : (FIELD_LABEL[field] ?? field)}</b>:{' '}
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

function Comments({ issue, members, meId, isAdmin }: { issue: IssueDetailT; members: User[]; meId: string; isAdmin: boolean }) {
  const [body, setBody] = useState('');
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const invalidate = useInvalidateWork();
  const upload = useUploadToIssue(issue.key);
  const toast = useToast();

  const add = async () => {
    if (!body.trim() || saving) return;
    setSaving(true);
    try {
      await api(`/issues/${issue.key}/comments`, { method: 'POST', body: { body } });
      setBody('');
      setOpen(false);
      await invalidate();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {open ? (
        <div className="comment-form">
          <MarkdownEditor
            autoFocus
            rows={4}
            value={body}
            onChange={setBody}
            members={members}
            onUpload={upload}
            attachments={issue.attachments}
            onSubmit={add}
            onCancel={() => setOpen(false)}
            placeholder="Adicionar um comentário… Use @ para mencionar alguém."
          />
          <div className="row gap-sm mt-sm">
            <button className="btn btn-primary" onClick={add} disabled={!body.trim() || saving}>Salvar</button>
            <button className="btn btn-subtle" onClick={() => { setBody(''); setOpen(false); }}>Cancelar</button>
          </div>
        </div>
      ) : (
        <button className="comment-placeholder" onClick={() => setOpen(true)}>
          Adicionar um comentário…
        </button>
      )}
      <ul className="comments">
        {[...issue.comments].reverse().map((c) => (
          <CommentItem
            key={c.id}
            comment={c}
            issue={issue}
            members={members}
            canEdit={c.authorId === meId}
            canDelete={c.authorId === meId || isAdmin}
          />
        ))}
      </ul>
    </div>
  );
}

function CommentItem({
  comment,
  issue,
  members,
  canEdit,
  canDelete,
}: {
  comment: Comment;
  issue: IssueDetailT;
  members: User[];
  canEdit: boolean;
  canDelete: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const invalidate = useInvalidateWork();
  const upload = useUploadToIssue(issue.key);
  const toast = useToast();

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await invalidate();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const save = () =>
    run(async () => {
      await api(`/comments/${comment.id}`, { method: 'PATCH', body: { body: draft } });
      setEditing(false);
    });

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
            <MarkdownEditor
              autoFocus
              rows={3}
              value={draft}
              onChange={setDraft}
              members={members}
              onUpload={upload}
              attachments={issue.attachments}
              onSubmit={save}
              onCancel={() => setEditing(false)}
            />
            <div className="row gap-sm mt-sm">
              <button className="btn btn-primary" onClick={save}>Salvar</button>
              <button className="btn btn-subtle" onClick={() => setEditing(false)}>Cancelar</button>
            </div>
          </>
        ) : (
          <Markdown className="comment-body" source={comment.body} attachments={issue.attachments} />
        )}
        {!editing && (canEdit || canDelete) && (
          <div className="comment-actions">
            {canEdit && <button className="link small" onClick={() => { setDraft(comment.body); setEditing(true); }}>Editar</button>}
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
