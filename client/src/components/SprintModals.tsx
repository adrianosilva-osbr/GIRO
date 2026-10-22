import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useInvalidateWork, useIssues, useSprints } from '../hooks';
import { isDone } from '../constants';
import type { Sprint } from '../types';
import { ErrorText, Field, Modal } from './ui';
import { useToast } from './Toast';

const DAY = 86400000;
const toInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const fromInput = (s: string) => new Date(`${s}T09:00:00`).toISOString();

function useSprintAction(onDone: () => void) {
  const invalidate = useInvalidateWork();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>, success: string) => {
    setError(null);
    try {
      await fn();
      await invalidate();
      toast(success);
      onDone();
    } catch (err) {
      setError(err);
    }
  };
  return { error, run };
}

export function StartSprintModal({ sprint, issueCount, onClose }: { sprint: Sprint; issueCount: number; onClose(): void }) {
  const [name, setName] = useState(sprint.name);
  const [goal, setGoal] = useState(sprint.goal);
  const [weeks, setWeeks] = useState('2');
  const [start, setStart] = useState(toInput(new Date()));
  const [end, setEnd] = useState(toInput(new Date(Date.now() + 14 * DAY)));
  const { error, run } = useSprintAction(onClose);

  const changeWeeks = (w: string) => {
    setWeeks(w);
    if (w !== 'custom') setEnd(toInput(new Date(new Date(`${start}T09:00:00`).getTime() + Number(w) * 7 * DAY)));
  };
  const changeStart = (s: string) => {
    setStart(s);
    if (weeks !== 'custom') setEnd(toInput(new Date(new Date(`${s}T09:00:00`).getTime() + Number(weeks) * 7 * DAY)));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(
      () => api(`/sprints/${sprint.id}/start`, { method: 'POST', body: { name, goal, startDate: fromInput(start), endDate: fromInput(end) } }),
      `${name} iniciada`,
    );
  };

  return (
    <Modal
      title="Iniciar sprint"
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-subtle" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" form="start-sprint">Iniciar</button>
        </>
      }
    >
      <form id="start-sprint" className="form" onSubmit={submit}>
        <p className="muted">{issueCount} issue(s) serão incluídas nesta sprint.</p>
        <Field label="Nome da sprint *">
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Duração">
          <select value={weeks} onChange={(e) => changeWeeks(e.target.value)}>
            <option value="1">1 semana</option>
            <option value="2">2 semanas</option>
            <option value="3">3 semanas</option>
            <option value="4">4 semanas</option>
            <option value="custom">Personalizada</option>
          </select>
        </Field>
        <div className="form-row">
          <Field label="Início">
            <input type="date" value={start} onChange={(e) => changeStart(e.target.value)} required />
          </Field>
          <Field label="Término">
            <input type="date" value={end} onChange={(e) => { setWeeks('custom'); setEnd(e.target.value); }} required />
          </Field>
        </div>
        <Field label="Objetivo da sprint">
          <textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
        </Field>
        <ErrorText error={error} />
      </form>
    </Modal>
  );
}

export function EditSprintModal({ sprint, onClose }: { sprint: Sprint; onClose(): void }) {
  const [name, setName] = useState(sprint.name);
  const [goal, setGoal] = useState(sprint.goal);
  const [start, setStart] = useState(sprint.startDate ? toInput(new Date(sprint.startDate)) : '');
  const [end, setEnd] = useState(sprint.endDate ? toInput(new Date(sprint.endDate)) : '');
  const { error, run } = useSprintAction(onClose);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(
      () =>
        api(`/sprints/${sprint.id}`, {
          method: 'PATCH',
          body: { name, goal, startDate: start ? fromInput(start) : null, endDate: end ? fromInput(end) : null },
        }),
      'Sprint atualizada',
    );
  };

  return (
    <Modal
      title="Editar sprint"
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-subtle" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" form="edit-sprint">Salvar</button>
        </>
      }
    >
      <form id="edit-sprint" className="form" onSubmit={submit}>
        <Field label="Nome da sprint *">
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <div className="form-row">
          <Field label="Início">
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Término">
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="Objetivo da sprint">
          <textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
        </Field>
        <ErrorText error={error} />
      </form>
    </Modal>
  );
}

export function CompleteSprintModal({ sprint, projectKey, onClose }: { sprint: Sprint; projectKey: string; onClose(): void }) {
  const { data: issues = [] } = useIssues({ project: projectKey, sprint: sprint.id, excludeType: 'SUBTASK' });
  const { data: sprints = [] } = useSprints(projectKey);
  const planned = sprints.filter((s) => s.status === 'PLANNED');
  const [moveTo, setMoveTo] = useState('backlog');
  const { error, run } = useSprintAction(onClose);
  const done = issues.filter(isDone).length;
  const open = issues.length - done;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(() => api(`/sprints/${sprint.id}/complete`, { method: 'POST', body: { moveTo } }), `${sprint.name} encerrada`);
  };

  return (
    <Modal
      title={`Concluir ${sprint.name}`}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-subtle" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" form="complete-sprint">Concluir sprint</button>
        </>
      }
    >
      <form id="complete-sprint" className="form" onSubmit={submit}>
        <div className="sprint-summary">
          <div><b className="big">{done}</b><span className="muted">issues concluídas</span></div>
          <div><b className="big">{open}</b><span className="muted">issues em aberto</span></div>
        </div>
        {open > 0 && (
          <Field label="Mover issues em aberto para">
            <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              <option value="backlog">Backlog</option>
              {planned.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        )}
        <ErrorText error={error} />
      </form>
    </Modal>
  );
}
