import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { CATEGORIES, CATEGORY_LABEL } from '../../constants';
import type { Category, Project, ProjectStatus } from '../../types';
import { Icon } from '../../components/Icons';
import { ErrorText, Modal, StatusLozenge } from '../../components/ui';
import { useToast } from '../../components/Toast';

export function WorkflowSettings({ project, isAdmin }: { project: Project; isAdmin: boolean }) {
  const statuses = project.statuses ?? [];
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [category, setCategory] = useState<Category>('IN_PROGRESS');
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState<ProjectStatus | null>(null);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['project', project.key] }),
      qc.invalidateQueries({ queryKey: ['issues'] }),
      qc.invalidateQueries({ queryKey: ['reports'] }),
    ]);
  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setError(null);
    try {
      await fn();
      await refresh();
      if (success) toast(success);
      return true;
    } catch (err) {
      setError(err);
      return false;
    }
  };

  const base = `/projects/${project.key}/statuses`;
  const add = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api(base, { method: 'POST', body: { name, category } });
      setName('');
    }, 'Status adicionado');
  };
  const move = (index: number, delta: number) => {
    const ids = statuses.map((s) => s.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    run(() => api(`${base}/order`, { method: 'PUT', body: { ids } }));
  };

  return (
    <section className="settings-section">
      <h2>Fluxo de trabalho</h2>
      <p className="muted">
        Os status viram as colunas do quadro, nesta ordem. Qualquer status pode ir para qualquer outro. A <b>categoria</b> diz ao GIRO
        o que o status significa: issues em status da categoria <b>Concluído</b> contam como entregues nos relatórios e no encerramento das sprints.
      </p>
      <ErrorText error={error} />
      <table className="table workflow-table">
        <thead>
          <tr>
            <th style={{ width: 70 }}>Ordem</th>
            <th>Nome</th>
            <th>Categoria</th>
            <th style={{ width: 150 }}>Limite de WIP</th>
            <th>Prévia</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {statuses.map((s, i) => (
            <tr key={s.id}>
              <td>
                <div className="row">
                  <button className="btn-icon" disabled={!isAdmin || i === 0} onClick={() => move(i, -1)} aria-label="Mover para cima">↑</button>
                  <button className="btn-icon" disabled={!isAdmin || i === statuses.length - 1} onClick={() => move(i, 1)} aria-label="Mover para baixo">↓</button>
                </div>
              </td>
              <td>
                <BlurField
                  value={s.name}
                  disabled={!isAdmin}
                  onSave={(v) => run(() => api(`${base}/${s.id}`, { method: 'PATCH', body: { name: v } }), 'Status renomeado')}
                />
                <div className="muted small">chave: {s.key}</div>
              </td>
              <td>
                <select
                  value={s.category}
                  disabled={!isAdmin}
                  onChange={(e) => {
                    const next = e.target.value as Category;
                    if ((next === 'DONE') !== (s.category === 'DONE') &&
                      !confirm(next === 'DONE'
                        ? `As issues em "${s.name}" passarão a contar como concluídas. Continuar?`
                        : `As issues em "${s.name}" deixarão de contar como concluídas. Continuar?`)) return;
                    run(() => api(`${base}/${s.id}`, { method: 'PATCH', body: { category: next } }), 'Categoria alterada');
                  }}
                >
                  {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                </select>
              </td>
              <td>
                <BlurField
                  type="number"
                  value={s.wipLimit?.toString() ?? ''}
                  placeholder="Sem limite"
                  disabled={!isAdmin}
                  onSave={(v) => run(() => api(`${base}/${s.id}`, { method: 'PATCH', body: { wipLimit: v ? Number(v) : null } }), 'Limite atualizado')}
                />
              </td>
              <td><StatusLozenge status={s} /></td>
              <td className="right">
                {isAdmin && statuses.length > 1 && (
                  <button className="btn-icon" title="Excluir status" onClick={() => setRemoving(s)}><Icon name="trash" /></button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {isAdmin && (
        <form className="row gap-sm mt-sm" onSubmit={add}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do novo status (ex.: Em validação)" required />
          <select value={category} onChange={(e) => setCategory(e.target.value as Category)} style={{ width: 170 }}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </select>
          <button className="btn btn-primary">Adicionar status</button>
        </form>
      )}

      {removing && (
        <RemoveStatusModal
          status={removing}
          others={statuses.filter((s) => s.id !== removing.id)}
          onClose={() => setRemoving(null)}
          onConfirm={async (moveTo) => {
            const ok = await run(() => api(`${base}/${removing.id}?moveTo=${encodeURIComponent(moveTo)}`, { method: 'DELETE' }), 'Status excluído');
            if (ok) setRemoving(null);
          }}
        />
      )}
    </section>
  );
}

function RemoveStatusModal({
  status,
  others,
  onClose,
  onConfirm,
}: {
  status: ProjectStatus;
  others: ProjectStatus[];
  onClose(): void;
  onConfirm(moveTo: string): void;
}) {
  const [moveTo, setMoveTo] = useState(others.find((o) => o.category === status.category)?.key ?? others[0]?.key);
  return (
    <Modal
      title={`Excluir "${status.name}"`}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-subtle" onClick={onClose}>Cancelar</button>
          <button className="btn btn-danger" onClick={() => onConfirm(moveTo)}>Excluir status</button>
        </>
      }
    >
      <div className="form">
        <p>As issues que estiverem neste status serão movidas para:</p>
        <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
          {others.map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}
        </select>
        <p className="muted small">Regras de automação que usam este status deixarão de funcionar até serem ajustadas.</p>
      </div>
    </Modal>
  );
}

export function BlurField({
  value,
  onSave,
  type = 'text',
  placeholder,
  disabled,
}: {
  value: string;
  onSave(v: string): void;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    setDraft(value);
  }
  return (
    <input
      type={type}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      min={type === 'number' ? 1 : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft.trim() !== value && (type === 'number' || draft.trim()) && onSave(draft.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}
