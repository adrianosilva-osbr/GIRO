import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { formatDateTime } from '../constants';
import { formatDuration, parseDuration } from '../duration';
import { useInvalidateWork, useOpenIssue, useProject, useProjects } from '../hooks';
import type { Issue, IssueDetail, WorkLog } from '../types';
import { Avatar, ErrorText, Field, Modal } from './ui';
import { useToast } from './Toast';

/** Red badge for issues blocked by unfinished work (icon + text, never colour alone). */
export function BlockedBadge({ issue, compact }: { issue: Pick<Issue, 'blockedBy'>; compact?: boolean }) {
  if (!issue.blockedBy) return null;
  const text = issue.blockedBy === 1 ? 'Bloqueada' : `Bloqueada (${issue.blockedBy})`;
  return (
    <span className="blocked-badge" title={`Bloqueada por ${issue.blockedBy} issue(s) ainda não concluída(s)`}>
      ⛔{!compact && ` ${text}`}
    </span>
  );
}

// ---------------------------------------------------------------- time tracking

export function TimeTracking({ issue, onEdit }: { issue: IssueDetail; onEdit(data: Record<string, unknown>): void }) {
  const [logging, setLogging] = useState(false);
  const spent = issue.timeSpent;
  const remaining = issue.remainingEstimate ?? 0;
  const total = Math.max(spent + remaining, issue.originalEstimate ?? 0, 1);
  const over = issue.originalEstimate != null && spent + remaining > issue.originalEstimate;

  return (
    <div className="details-box">
      <h4 className="row space-between">
        Controle de tempo
        <button className="btn btn-subtle small" onClick={() => setLogging(true)}>+ Registrar horas</button>
      </h4>
      <div className="time-box">
        <div className="time-bar" title={`${formatDuration(spent) || '0m'} registrado(s), ${formatDuration(remaining) || '0m'} restante(s)`}>
          <div className={`time-spent ${over ? 'over' : ''}`} style={{ width: `${(spent / total) * 100}%` }} />
        </div>
        <div className="row space-between small">
          <span><b>{formatDuration(spent) || '0m'}</b> registrado</span>
          <span><b>{issue.remainingEstimate == null ? '—' : formatDuration(remaining) || '0m'}</b> restante</span>
        </div>
        {over && <div className="small time-over">⚠ Acima da estimativa original</div>}
        <div className="time-fields">
          <label>
            <span className="detail-label">Estimativa original</span>
            <DurationInput value={issue.originalEstimate} onSave={(m) => onEdit({ originalEstimate: m })} />
          </label>
          <label>
            <span className="detail-label">Restante</span>
            <DurationInput value={issue.remainingEstimate} onSave={(m) => onEdit({ remainingEstimate: m })} />
          </label>
        </div>
      </div>
      {logging && <LogWorkModal issue={issue} onClose={() => setLogging(false)} />}
    </div>
  );
}

function DurationInput({ value, onSave }: { value: number | null; onSave(minutes: number | null): void }) {
  const shown = formatDuration(value);
  const [draft, setDraft] = useState(shown);
  const [prev, setPrev] = useState(shown);
  const [invalid, setInvalid] = useState(false);
  if (shown !== prev) {
    setPrev(shown);
    setDraft(shown);
  }
  const commit = () => {
    if (draft.trim() === shown) return;
    const minutes = draft.trim() ? parseDuration(draft) : null;
    if (draft.trim() && minutes === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onSave(minutes);
  };
  return (
    <input
      className={invalid ? 'invalid' : ''}
      value={draft}
      placeholder="ex.: 2d 4h"
      title={invalid ? 'Use o formato 1w 2d 3h 30m' : 'Semanas (w), dias (d = 8h), horas (h), minutos (m)'}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

const nowLocal = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export function LogWorkModal({ issue, log, onClose }: { issue: IssueDetail; log?: WorkLog; onClose(): void }) {
  const [time, setTime] = useState(log ? formatDuration(log.minutes) : '');
  const [startedAt, setStartedAt] = useState(
    log ? new Date(new Date(log.startedAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : nowLocal(),
  );
  const [description, setDescription] = useState(log?.description ?? '');
  const [remainingMode, setRemainingMode] = useState<'auto' | 'manual'>('auto');
  const [remaining, setRemaining] = useState('');
  const [error, setError] = useState<unknown>(null);
  const invalidate = useInvalidateWork();
  const toast = useToast();
  const minutes = parseDuration(time);
  const autoRemaining = Math.max(0, (issue.remainingEstimate ?? issue.originalEstimate ?? 0) - (minutes ?? 0));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!minutes) {
      setError(new Error('Informe o tempo no formato 2h 30m, 1d, 45m…'));
      return;
    }
    const remainingMinutes = remainingMode === 'manual' ? parseDuration(remaining) : null;
    if (remainingMode === 'manual' && remaining.trim() && remainingMinutes === null) {
      setError(new Error('Tempo restante inválido'));
      return;
    }
    try {
      const body = { minutes, startedAt: new Date(startedAt).toISOString(), description };
      if (log) await api(`/worklogs/${log.id}`, { method: 'PATCH', body });
      else await api(`/issues/${issue.key}/worklogs`, { method: 'POST', body: { ...body, remaining: remainingMode === 'auto' ? 'auto' : (remainingMinutes ?? 0) } });
      await invalidate();
      toast(log ? 'Registro atualizado' : `${formatDuration(minutes)} registrado(s) em ${issue.key}`);
      onClose();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Modal
      title={log ? 'Editar registro de trabalho' : `Registrar horas em ${issue.key}`}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-subtle" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" form="log-work">Salvar</button>
        </>
      }
    >
      <form id="log-work" className="form" onSubmit={submit}>
        <div className="form-row">
          <Field label="Tempo gasto *" hint="Ex.: 2h 30m, 1d (8h), 45m">
            <input autoFocus value={time} onChange={(e) => setTime(e.target.value)} placeholder="2h 30m" />
          </Field>
          <Field label="Quando">
            <input type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} />
          </Field>
        </div>
        {!log && (issue.remainingEstimate != null || issue.originalEstimate != null) && (
          <div className="field">
            <span className="field-label">Tempo restante</span>
            <label className="checkbox">
              <input type="radio" checked={remainingMode === 'auto'} onChange={() => setRemainingMode('auto')} />
              Ajustar automaticamente ({formatDuration(autoRemaining) || '0m'} restante)
            </label>
            <label className="checkbox">
              <input type="radio" checked={remainingMode === 'manual'} onChange={() => setRemainingMode('manual')} />
              Definir manualmente
              {remainingMode === 'manual' && (
                <input style={{ width: 120 }} value={remaining} onChange={(e) => setRemaining(e.target.value)} placeholder="ex.: 4h" />
              )}
            </label>
          </div>
        )}
        <Field label="Descrição do trabalho">
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <ErrorText error={error} />
      </form>
    </Modal>
  );
}

export function WorkLogList({ issue, meId, isAdmin }: { issue: IssueDetail; meId: string; isAdmin: boolean }) {
  const [editing, setEditing] = useState<WorkLog | null>(null);
  const invalidate = useInvalidateWork();
  const toast = useToast();
  if (!issue.workLogs.length) return <p className="muted small">Nenhum registro de trabalho ainda.</p>;
  return (
    <>
      <ul className="history">
        {issue.workLogs.map((w) => (
          <li key={w.id}>
            <Avatar user={w.user} size={28} />
            <div className="comment-content">
              <div>
                <b>{w.user.name}</b> registrou <b>{formatDuration(w.minutes)}</b>{' '}
                <span className="muted small">em {formatDateTime(w.startedAt)}</span>
              </div>
              {w.description && <div className="comment-body">{w.description}</div>}
              {(w.userId === meId || isAdmin) && (
                <div className="comment-actions">
                  <button className="link small" onClick={() => setEditing(w)}>Editar</button>
                  <button
                    className="link small"
                    onClick={async () => {
                      if (!confirm('Excluir este registro? O tempo volta para o restante.')) return;
                      try {
                        await api(`/worklogs/${w.id}`, { method: 'DELETE' });
                        await invalidate();
                      } catch (e) {
                        toast((e as Error).message, 'error');
                      }
                    }}
                  >
                    Excluir
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {editing && <LogWorkModal issue={issue} log={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- clone / move

export function CloneModal({ issue, onClose }: { issue: IssueDetail; onClose(): void }) {
  const [title, setTitle] = useState(`CLONE - ${issue.title}`);
  const [subtasks, setSubtasks] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const invalidate = useInvalidateWork();
  const openIssue = useOpenIssue();
  const toast = useToast();
  const hasSubtasks = issue.type !== 'SUBTASK' && issue.type !== 'EPIC' && issue.children.length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { issue: clone } = await api<{ issue: Issue }>(`/issues/${issue.key}/clone`, { method: 'POST', body: { title, includeSubtasks: subtasks } });
      await invalidate();
      toast(`${clone.key} criada como clone de ${issue.key}`);
      openIssue(clone.key);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Modal
      title={`Clonar ${issue.key}`}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-subtle" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" form="clone-issue">Clonar</button>
        </>
      }
    >
      <form id="clone-issue" className="form" onSubmit={submit}>
        <Field label="Resumo da nova issue">
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} required />
        </Field>
        {hasSubtasks && (
          <label className="checkbox">
            <input type="checkbox" checked={subtasks} onChange={(e) => setSubtasks(e.target.checked)} />
            Clonar também as {issue.children.length} subtarefa(s)
          </label>
        )}
        <p className="muted small">
          São copiados descrição, tipo, prioridade, responsável, etiquetas, story points, datas, épico, sprint em aberto e campos personalizados.
          Comentários, anexos e histórico não são copiados. A nova issue fica vinculada como “clona {issue.key}”.
        </p>
        <ErrorText error={error} />
      </form>
    </Modal>
  );
}

export function MoveModal({ issue, onClose }: { issue: IssueDetail; onClose(): void }) {
  const { data: projects = [] } = useProjects();
  const targets = projects.filter((p) => p.key !== issue.project.key);
  const [projectKey, setProjectKey] = useState(targets[0]?.key ?? '');
  const { data: target } = useProject(projectKey || undefined);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<unknown>(null);
  const invalidate = useInvalidateWork();
  const openIssue = useOpenIssue();
  const toast = useToast();

  // Default status: same key, else first one in the same category.
  const statuses = target?.statuses ?? [];
  const suggested =
    statuses.find((s) => s.key === issue.status)?.key ??
    statuses.find((s) => s.category === issue.statusRef?.category)?.key ??
    statuses[0]?.key ??
    '';
  const chosen = status && statuses.some((s) => s.key === status) ? status : suggested;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { issue: moved } = await api<{ issue: Issue }>(`/issues/${issue.key}/move`, { method: 'POST', body: { projectKey, status: chosen } });
      await invalidate();
      toast(`${issue.key} agora é ${moved.key}`);
      openIssue(moved.key);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Modal
      title={`Mover ${issue.key} para outro projeto`}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-subtle" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" form="move-issue" disabled={!projectKey}>Mover</button>
        </>
      }
    >
      {targets.length === 0 ? (
        <p>Você não participa de nenhum outro projeto.</p>
      ) : (
        <form id="move-issue" className="form" onSubmit={submit}>
          <div className="form-row">
            <Field label="Projeto de destino">
              <select value={projectKey} onChange={(e) => { setProjectKey(e.target.value); setStatus(''); }}>
                {targets.map((p) => <option key={p.key} value={p.key}>{p.name} ({p.key})</option>)}
              </select>
            </Field>
            <Field label="Status no destino">
              <select value={chosen} onChange={(e) => setStatus(e.target.value)}>
                {statuses.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
              </select>
            </Field>
          </div>
          <ul className="move-notes muted small">
            <li>A issue recebe uma chave nova; links para <b>{issue.key}</b> continuam funcionando.</li>
            {issue.children.length > 0 && issue.type !== 'EPIC' && <li>As {issue.children.length} subtarefa(s) vão junto.</li>}
            {issue.type === 'EPIC' && issue.children.length > 0 && <li>As issues deste épico ficam no projeto atual, sem épico.</li>}
            {issue.sprint && <li>Ela sai da sprint “{issue.sprint.name}”.</li>}
            {issue.parent && issue.type !== 'SUBTASK' && <li>O vínculo com o épico {issue.parent.key} é removido.</li>}
            <li>Campos personalizados só são mantidos se o destino tiver um campo com o mesmo nome e tipo.</li>
          </ul>
          <ErrorText error={error} />
        </form>
      )}
    </Modal>
  );
}
