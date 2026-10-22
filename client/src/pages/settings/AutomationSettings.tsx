import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../../api';
import { PRIORITIES, PRIORITY_LABEL, formatDateTime, timeAgo } from '../../constants';
import type { AutomationAction, AutomationRule, Issue, Priority, Project, Trigger } from '../../types';
import { Icon } from '../../components/Icons';
import { ErrorText, Field, Modal, Spinner } from '../../components/ui';
import { useToast } from '../../components/Toast';

const TRIGGER_LABEL: Record<Trigger, string> = {
  issue_created: 'Quando uma issue for criada',
  status_changed: 'Quando o status mudar',
  assignee_changed: 'Quando o responsável mudar',
  comment_added: 'Quando alguém comentar',
  subtasks_done: 'Quando todas as subtarefas forem concluídas (age na issue pai)',
};

const ACTION_LABEL: Record<AutomationAction['type'], string> = {
  set_status: 'Mudar o status para',
  assign: 'Atribuir a',
  set_priority: 'Mudar a prioridade para',
  add_label: 'Adicionar a etiqueta',
  add_comment: 'Comentar',
};

type Draft = Omit<AutomationRule, 'id' | 'runCount' | 'lastRunAt' | 'createdBy' | 'runs'>;

const TEMPLATES: { title: string; build(p: Project): Draft }[] = [
  {
    title: 'Concluir a issue pai quando todas as subtarefas terminarem',
    build: (p) => ({
      name: 'Concluir a issue pai quando todas as subtarefas terminarem',
      enabled: true,
      trigger: 'subtasks_done',
      triggerValue: null,
      condition: '',
      actions: [{ type: 'set_status', value: p.statuses?.find((s) => s.category === 'DONE')?.key ?? 'DONE' }],
    }),
  },
  {
    title: 'Bugs urgentes recebem prioridade alta e etiqueta',
    build: () => ({
      name: 'Bugs urgentes',
      enabled: true,
      trigger: 'issue_created',
      triggerValue: null,
      condition: 'type = Bug AND text ~ "urgente"',
      actions: [{ type: 'set_priority', value: 'HIGHEST' }, { type: 'add_label', value: 'urgente' }],
    }),
  },
  {
    title: 'Devolver ao relator quando a issue entrar em revisão',
    build: (p) => ({
      name: 'Devolver ao relator na revisão',
      enabled: true,
      trigger: 'status_changed',
      triggerValue: p.statuses?.find((s) => s.key === 'IN_REVIEW')?.key ?? p.statuses?.[1]?.key ?? null,
      condition: '',
      actions: [{ type: 'assign', value: 'reporter' }, { type: 'add_comment', value: '{{actor}} enviou {{key}} para revisão.' }],
    }),
  },
];

export function AutomationSettings({ project, isAdmin }: { project: Project; isAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['automations', project.key];
  const { data: rules = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api<{ rules: AutomationRule[] }>(`/projects/${project.key}/automations`).then((r) => r.rules),
  });
  const [editing, setEditing] = useState<{ id?: string; draft: Draft } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const toggle = async (r: AutomationRule) => {
    try {
      await api(`/projects/${project.key}/automations/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } });
      await refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async (r: AutomationRule) => {
    if (!confirm(`Excluir a regra "${r.name}"?`)) return;
    await api(`/projects/${project.key}/automations/${r.id}`, { method: 'DELETE' });
    await refresh();
  };

  const describe = (r: Draft) => {
    const status = (k: string | null) => project.statuses?.find((s) => s.key === k)?.name ?? k;
    const member = (id: string) => project.members?.find((m) => m.userId === id)?.user.name ?? 'usuário removido';
    const trigger = r.trigger === 'status_changed' && r.triggerValue ? `Quando o status mudar para "${status(r.triggerValue)}"` : TRIGGER_LABEL[r.trigger];
    const actions = r.actions.map((a) => {
      switch (a.type) {
        case 'set_status': return `mudar status para "${status(a.value)}"`;
        case 'assign': return a.value === 'reporter' ? 'atribuir ao relator' : a.value === 'unassigned' ? 'remover responsável' : `atribuir a ${member(a.value)}`;
        case 'set_priority': return `prioridade ${PRIORITY_LABEL[a.value].toLowerCase()}`;
        case 'add_label': return `etiqueta "${a.value}"`;
        case 'add_comment': return 'comentar';
      }
    });
    return `${trigger}${r.condition ? ` e a issue atender a "${r.condition}"` : ''} → ${actions.join(', ')}.`;
  };

  return (
    <section className="settings-section">
      <div className="row space-between">
        <h2>Automação</h2>
        {isAdmin && (
          <button
            className="btn btn-primary"
            onClick={() => setEditing({ draft: { name: '', enabled: true, trigger: 'issue_created', triggerValue: null, condition: '', actions: [] } })}
          >
            <Icon name="plus" /> Nova regra
          </button>
        )}
      </div>
      <p className="muted">
        Regras executam ações sozinhas quando algo acontece numa issue. As ações aparecem no histórico como feitas pelo usuário <b>Automação</b>.
      </p>

      {isLoading ? <Spinner /> : rules.length === 0 ? (
        <p className="muted">Nenhuma regra ainda.</p>
      ) : (
        <ul className="rule-list">
          {rules.map((r) => (
            <li key={r.id} className={r.enabled ? '' : 'disabled'}>
              <div className="rule-main">
                <label className="switch" title={r.enabled ? 'Ativa' : 'Desativada'}>
                  <input type="checkbox" checked={r.enabled} disabled={!isAdmin} onChange={() => toggle(r)} />
                  <span />
                </label>
                <div className="rule-text">
                  <b>{r.name}</b>
                  <div className="muted small">{describe(r)}</div>
                  <div className="muted small">
                    {r.runCount} execução(ões){r.lastRunAt && ` · última ${timeAgo(r.lastRunAt)}`}
                    {r.runs.some((x) => !x.success) && <span className="rule-error"> · ⚠ houve erros</span>}
                    {r.runs.length > 0 && (
                      <> · <button className="link small" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>{expanded === r.id ? 'ocultar histórico' : 'ver histórico'}</button></>
                    )}
                  </div>
                </div>
                {isAdmin && (
                  <div className="row">
                    <button className="btn-icon" title="Editar" onClick={() => setEditing({ id: r.id, draft: { name: r.name, enabled: r.enabled, trigger: r.trigger, triggerValue: r.triggerValue, condition: r.condition, actions: r.actions } })}>
                      <Icon name="edit" />
                    </button>
                    <button className="btn-icon" title="Excluir" onClick={() => remove(r)}><Icon name="trash" /></button>
                  </div>
                )}
              </div>
              {expanded === r.id && (
                <table className="table run-table">
                  <tbody>
                    {r.runs.map((x) => (
                      <tr key={x.id}>
                        <td className="nowrap">{formatDateTime(x.at)}</td>
                        <td className="key">{x.issueKey}</td>
                        <td>{x.success ? '✓' : '⚠'} {x.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          ))}
        </ul>
      )}

      {isAdmin && (
        <>
          <h3 className="mt-lg">Modelos prontos</h3>
          <div className="template-list">
            {TEMPLATES.map((t) => (
              <button key={t.title} className="template-card" onClick={() => setEditing({ draft: t.build(project) })}>
                <Icon name="plus" /> {t.title}
              </button>
            ))}
          </div>
        </>
      )}

      {editing && (
        <RuleEditor
          project={project}
          ruleId={editing.id}
          initial={editing.draft}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await refresh();
            setEditing(null);
            toast('Regra salva');
          }}
        />
      )}
    </section>
  );
}

function RuleEditor({
  project,
  ruleId,
  initial,
  onClose,
  onSaved,
}: {
  project: Project;
  ruleId?: string;
  initial: Draft;
  onClose(): void;
  onSaved(): void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState<unknown>(null);
  const [test, setTest] = useState<{ count: number; sample: Issue[] } | { error: string } | null>(null);
  const statuses = project.statuses ?? [];
  const members = project.members ?? [];
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setAction = (i: number, a: AutomationAction) => set({ actions: draft.actions.map((x, j) => (j === i ? a : x)) });

  const defaultValue = (type: AutomationAction['type']): AutomationAction => {
    switch (type) {
      case 'set_status': return { type, value: statuses[0]?.key ?? '' };
      case 'assign': return { type, value: 'reporter' };
      case 'set_priority': return { type, value: 'HIGH' };
      case 'add_label': return { type, value: '' };
      case 'add_comment': return { type, value: '' };
    }
  };

  const runTest = async () => {
    setTest(null);
    try {
      const jql = `project = ${project.key}${draft.condition.trim() ? ` AND (${draft.condition})` : ''}`;
      const { issues } = await api<{ issues: Issue[] }>(`/issues${qs({ jql, limit: '200' })}`);
      setTest({ count: issues.length, sample: issues.slice(0, 5) });
    } catch (e) {
      setTest({ error: (e as Error).message });
    }
  };

  const save = async () => {
    setError(null);
    try {
      const url = `/projects/${project.key}/automations${ruleId ? `/${ruleId}` : ''}`;
      await api(url, { method: ruleId ? 'PATCH' : 'POST', body: draft });
      onSaved();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Modal
      title={ruleId ? 'Editar regra' : 'Nova regra de automação'}
      onClose={onClose}
      width={720}
      footer={
        <>
          <label className="checkbox"><input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Ativa</label>
          <div className="spacer" />
          <button className="btn btn-subtle" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={save} disabled={!draft.name.trim() || !draft.actions.length}>Salvar regra</button>
        </>
      }
    >
      <div className="form">
        <Field label="Nome *">
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Ex.: Fechar pai quando subtarefas terminarem" />
        </Field>

        <div className="rule-step">
          <div className="rule-step-label">1. Quando</div>
          <div className="form-row">
            <select value={draft.trigger} onChange={(e) => set({ trigger: e.target.value as Trigger, triggerValue: null })}>
              {(Object.keys(TRIGGER_LABEL) as Trigger[]).map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>)}
            </select>
            {draft.trigger === 'status_changed' && (
              <select value={draft.triggerValue ?? ''} onChange={(e) => set({ triggerValue: e.target.value || null })}>
                <option value="">para qualquer status</option>
                {statuses.map((s) => <option key={s.key} value={s.key}>para “{s.name}”</option>)}
              </select>
            )}
          </div>
        </div>

        <div className="rule-step">
          <div className="rule-step-label">2. Se (opcional)</div>
          <div className="row gap-sm">
            <input
              className="jql-input"
              value={draft.condition}
              onChange={(e) => { set({ condition: e.target.value }); setTest(null); }}
              placeholder='Condição em JQL, ex.: type = Bug AND priority >= Alta'
              spellCheck={false}
            />
            <button className="btn" type="button" onClick={runTest}>Testar</button>
          </div>
          {test && ('error' in test ? (
            <div className="error-text small mt-sm">{test.error}</div>
          ) : (
            <div className="muted small mt-sm">
              {test.count} issue(s) do projeto atendem à condição agora
              {test.sample.length > 0 && `: ${test.sample.map((i) => i.key).join(', ')}${test.count > test.sample.length ? '…' : ''}`}
            </div>
          ))}
        </div>

        <div className="rule-step">
          <div className="rule-step-label">3. Então</div>
          {draft.actions.map((a, i) => (
            <div key={i} className="action-row">
              <select
                value={a.type}
                onChange={(e) => setAction(i, defaultValue(e.target.value as AutomationAction['type']))}
                style={{ width: 210 }}
              >
                {(Object.keys(ACTION_LABEL) as AutomationAction['type'][]).map((t) => <option key={t} value={t}>{ACTION_LABEL[t]}</option>)}
              </select>
              {a.type === 'set_status' && (
                <select value={a.value} onChange={(e) => setAction(i, { ...a, value: e.target.value })}>
                  {statuses.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
                </select>
              )}
              {a.type === 'assign' && (
                <select value={a.value} onChange={(e) => setAction(i, { ...a, value: e.target.value })}>
                  <option value="reporter">Relator da issue</option>
                  <option value="unassigned">Ninguém (remover responsável)</option>
                  {members.map((m) => <option key={m.userId} value={m.userId}>{m.user.name}</option>)}
                </select>
              )}
              {a.type === 'set_priority' && (
                <select value={a.value} onChange={(e) => setAction(i, { ...a, value: e.target.value as Priority })}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                </select>
              )}
              {a.type === 'add_label' && (
                <input value={a.value} onChange={(e) => setAction(i, { ...a, value: e.target.value })} placeholder="etiqueta" />
              )}
              {a.type === 'add_comment' && (
                <textarea
                  rows={2}
                  value={a.value}
                  onChange={(e) => setAction(i, { ...a, value: e.target.value })}
                  placeholder="Texto do comentário. Use {{key}}, {{title}} e {{actor}}."
                />
              )}
              <button className="btn-icon" type="button" title="Remover ação" onClick={() => set({ actions: draft.actions.filter((_, j) => j !== i) })}>
                <Icon name="close" />
              </button>
            </div>
          ))}
          <button className="btn btn-subtle" type="button" onClick={() => set({ actions: [...draft.actions, defaultValue('set_status')] })}>
            <Icon name="plus" /> Adicionar ação
          </button>
        </div>
        <ErrorText error={error} />
      </div>
    </Modal>
  );
}
