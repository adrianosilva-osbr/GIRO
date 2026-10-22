import { useEffect, useState, type FormEvent } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useMe } from '../auth';
import { CATEGORY_LABEL, PRIORITIES, PRIORITY_LABEL, TYPES, TYPE_LABEL, formatDate, isDone } from '../constants';
import { useIssues, useOpenIssue, useProject, useProjects, useSprints, useUsers } from '../hooks';
import type { Issue, SavedFilter, Sprint, User } from '../types';
import { Icon, IssueTypeIcon, PriorityIcon } from '../components/Icons';
import { Avatar, EmptyState, ErrorText, Field, Modal, Spinner, StatusLozenge } from '../components/ui';
import { useToast } from '../components/Toast';

const BASIC_KEYS = ['q', 'project', 'type', 'status', 'category', 'priority', 'assignee', 'sprint', 'label', 'sort'] as const;

const BUILT_IN: { id: string; name: string; jql: string }[] = [
  { id: 'mine', name: 'Minhas issues em aberto', jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC' },
  { id: 'reported', name: 'Relatadas por mim', jql: 'reporter = currentUser() ORDER BY created DESC' },
  { id: 'all', name: 'Todas as issues', jql: 'ORDER BY updated DESC' },
  { id: 'done', name: 'Concluídas nos últimos 7 dias', jql: 'resolved >= -7d ORDER BY resolved DESC' },
  { id: 'created', name: 'Criadas nos últimos 7 dias', jql: 'created >= -7d ORDER BY created DESC' },
];

const quote = (s: string) => (/^[\w.@-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/** Translates the basic filter form into the equivalent JQL, so switching modes keeps the search. */
function basicToJql(f: Record<string, string | undefined>, users: User[], sprints: Sprint[]) {
  const parts: string[] = [];
  if (f.project) parts.push(`project = ${f.project}`);
  if (f.q) parts.push(`text ~ ${quote(f.q)}`);
  if (f.type) parts.push(`type = ${f.type}`);
  if (f.status) parts.push(`status = ${quote(f.status)}`);
  if (f.category) {
    const cats = f.category.split(',');
    parts.push(cats.length === 1 ? `statusCategory = ${cats[0]}` : `statusCategory IN (${cats.join(', ')})`);
  }
  if (f.priority) parts.push(`priority = ${f.priority}`);
  if (f.assignee === 'me') parts.push('assignee = currentUser()');
  else if (f.assignee === 'unassigned') parts.push('assignee IS EMPTY');
  else if (f.assignee) parts.push(`assignee = ${quote(users.find((u) => u.id === f.assignee)?.email ?? f.assignee)}`);
  if (f.sprint === 'backlog') parts.push('sprint IS EMPTY');
  else if (f.sprint === 'active') parts.push('sprint = activeSprint()');
  else if (f.sprint) parts.push(`sprint = ${quote(sprints.find((s) => s.id === f.sprint)?.name ?? f.sprint)}`);
  if (f.label) parts.push(`labels = ${quote(f.label)}`);
  const order = { updated: 'updated DESC', created: 'created DESC', priority: 'priority DESC', key: 'key DESC' }[f.sort ?? 'updated'] ?? 'updated DESC';
  return `${parts.join(' AND ')}${parts.length ? ' ' : ''}ORDER BY ${order}`;
}

/** On a project's issue page every JQL search is scoped to that project. */
function scopeToProject(jql: string, projectKey: string | undefined) {
  if (!projectKey) return jql;
  const m = jql.match(/^(.*?)(\s*\bORDER\s+BY\b[\s\S]*)?$/i);
  const where = m?.[1]?.trim() ?? '';
  const order = m?.[2] ?? '';
  return `project = ${projectKey}${where ? ` AND (${where})` : ''}${order}`;
}

function useSavedFilters() {
  return useQuery({
    queryKey: ['filters'],
    queryFn: () => api<{ filters: SavedFilter[] }>('/filters').then((r) => r.filters),
  });
}

/** Issue search: basic filters or JQL, URL-backed. Global at /filters, scoped at /projects/:key/issues. */
export function IssueSearchPage() {
  const { key: routeProject } = useParams();
  const [params, setParams] = useSearchParams();
  const me = useMe();
  const toast = useToast();
  const qc = useQueryClient();
  const mode = params.has('jql') ? 'jql' : 'basic';
  const jql = params.get('jql') ?? '';
  const filterId = params.get('filter');

  const basic: Record<string, string | undefined> = {};
  for (const k of BASIC_KEYS) basic[k] = params.get(k) || undefined;
  if (routeProject) basic.project = routeProject;
  basic.sort ??= 'updated';

  const [text, setText] = useState(basic.q ?? '');
  const [draft, setDraft] = useState(jql);
  const [showHelp, setShowHelp] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => setText(params.get('q') ?? ''), [params]);
  useEffect(() => setDraft(params.get('jql') ?? ''), [params]);

  const { data: projects = [] } = useProjects();
  const { data: project } = useProject(basic.project);
  const { data: users = [] } = useUsers();
  const { data: sprints = [] } = useSprints(basic.project, true);
  const { data: saved = [] } = useSavedFilters();
  const people = basic.project ? (project?.members?.map((m) => m.user) ?? []) : users;

  const query = mode === 'jql' ? { jql: scopeToProject(jql, routeProject), limit: '500' } : basic;
  const { data: issues, isLoading, error, isFetching } = useIssues(query);
  const current = saved.find((f) => f.id === filterId);
  const builtIn = BUILT_IN.find((f) => f.id === filterId);
  const hasBasicFilters = BASIC_KEYS.some((k) => k !== 'sort' && params.get(k));

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k === 'project') next.delete('sprint');
    if (k === 'status') next.delete('category');
    next.delete('filter');
    setParams(next, { replace: true });
  };
  const runJql = (value: string, filter?: string) => {
    const next = new URLSearchParams(params.get('issue') ? { issue: params.get('issue')! } : {});
    next.set('jql', value);
    if (filter) next.set('filter', filter);
    setParams(next);
  };
  const toBasic = () => {
    const next = new URLSearchParams();
    if (params.get('issue')) next.set('issue', params.get('issue')!);
    setParams(next);
  };

  const effectiveJql = mode === 'jql' ? jql : basicToJql(routeProject ? { ...basic, project: undefined } : basic, users, sprints);
  const saveAs = async (name: string, shared: boolean) => {
    const { filter } = await api<{ filter: SavedFilter }>('/filters', { method: 'POST', body: { name, jql: effectiveJql, shared } });
    await qc.invalidateQueries({ queryKey: ['filters'] });
    runJql(filter.jql, filter.id);
    toast(`Filtro "${filter.name}" salvo`);
  };
  const updateCurrent = async (patch: Partial<SavedFilter>) => {
    if (!current) return;
    try {
      await api(`/filters/${current.id}`, { method: 'PATCH', body: patch });
      await qc.invalidateQueries({ queryKey: ['filters'] });
      toast('Filtro atualizado');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const deleteCurrent = async () => {
    if (!current || !confirm(`Excluir o filtro "${current.name}"?`)) return;
    await api(`/filters/${current.id}`, { method: 'DELETE' });
    await qc.invalidateQueries({ queryKey: ['filters'] });
    toBasic();
  };

  const title = current?.name ?? builtIn?.name ?? (routeProject ? 'Issues' : 'Pesquisar issues');
  const mine = saved.filter((f) => f.ownerId === me.id);
  const shared = saved.filter((f) => f.ownerId !== me.id);

  return (
    <div className={`search-layout ${routeProject ? 'scoped' : ''}`}>
      {!routeProject && (
        <aside className="filters-sidebar">
          <div className="sidebar-section">FILTROS PADRÃO</div>
          {BUILT_IN.map((f) => (
            <button key={f.id} className={filterId === f.id ? 'active' : ''} onClick={() => runJql(f.jql, f.id)}>{f.name}</button>
          ))}
          <div className="sidebar-section">MEUS FILTROS</div>
          {mine.length === 0 && <p className="muted small sidebar-hint">Monte uma busca e clique em “Salvar filtro”.</p>}
          {mine.map((f) => (
            <button key={f.id} className={filterId === f.id ? 'active' : ''} onClick={() => runJql(f.jql, f.id)}>
              {f.name} {f.shared && <span className="tag">compartilhado</span>}
            </button>
          ))}
          {shared.length > 0 && <div className="sidebar-section">COMPARTILHADOS COMIGO</div>}
          {shared.map((f) => (
            <button key={f.id} className={filterId === f.id ? 'active' : ''} onClick={() => runJql(f.jql, f.id)} title={`De ${f.owner.name}`}>
              {f.name} <span className="muted small">· {f.owner.name.split(' ')[0]}</span>
            </button>
          ))}
        </aside>
      )}

      <div className="page search-main">
        <div className="page-header">
          <h1 className="page-title">{title}</h1>
          <div className="row gap-sm">
            {current && current.ownerId === me.id && (
              <>
                {mode === 'jql' && jql !== current.jql && <button className="btn btn-primary" onClick={() => updateCurrent({ jql })}>Salvar alterações</button>}
                <label className="checkbox small">
                  <input type="checkbox" checked={current.shared} onChange={(e) => updateCurrent({ shared: e.target.checked })} /> Compartilhar
                </label>
                <button className="btn btn-subtle" onClick={deleteCurrent}><Icon name="trash" /> Excluir</button>
              </>
            )}
            <button className="btn" onClick={() => setSaving(true)}>Salvar filtro</button>
          </div>
        </div>

        <div className="toolbar">
          <div className="segmented" role="group" aria-label="Modo de busca">
            <button className={mode === 'basic' ? 'active' : ''} onClick={toBasic}>Básico</button>
            <button className={mode === 'jql' ? 'active' : ''} onClick={() => mode === 'basic' && runJql(effectiveJql)}>JQL</button>
          </div>
          {mode === 'jql' && <button className="link small" onClick={() => setShowHelp((h) => !h)}>{showHelp ? 'Ocultar ajuda' : 'Ajuda da sintaxe'}</button>}
          {mode === 'basic' && hasBasicFilters && (
            <button className="btn btn-subtle" onClick={() => { setText(''); toBasic(); }}>Limpar filtros</button>
          )}
        </div>

        {mode === 'jql' ? (
          <form
            className="jql-bar"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              runJql(draft, filterId ?? undefined);
            }}
          >
            <textarea
              className="jql-input"
              value={draft}
              rows={Math.min(4, Math.max(1, Math.ceil(draft.length / 110)))}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  runJql(draft, filterId ?? undefined);
                }
              }}
              placeholder='Ex.: type = Bug AND statusCategory != Done ORDER BY priority DESC'
              aria-label="Consulta JQL"
            />
            <button className="btn btn-primary" type="submit"><Icon name="search" /> Pesquisar</button>
          </form>
        ) : (
          <BasicFilters
            basic={basic}
            routeProject={routeProject}
            projects={projects}
            statuses={project?.statuses}
            people={people}
            sprints={sprints}
            text={text}
            setText={setText}
            set={set}
          />
        )}
        {mode === 'jql' && showHelp && <JqlHelp />}
        {routeProject && mode === 'jql' && <p className="muted small">A busca é limitada ao projeto {routeProject}.</p>}

        {isLoading ? (
          <Spinner />
        ) : error ? (
          <div className="jql-error"><ErrorText error={error} /></div>
        ) : issues?.length ? (
          <div className={isFetching ? 'refreshing' : ''}>
            <div className="muted small mb-sm">{issues.length} issue(s){issues.length === 500 ? ' (limite de 500 resultados)' : ''}</div>
            <IssueTable issues={issues} showProject={!basic.project && !routeProject} showSprint />
          </div>
        ) : (
          <EmptyState title="Nenhuma issue encontrada">Tente ajustar os filtros.</EmptyState>
        )}
      </div>

      {saving && <SaveFilterModal jql={effectiveJql} onClose={() => setSaving(false)} onSave={saveAs} />}
    </div>
  );
}

function BasicFilters({
  basic,
  routeProject,
  projects,
  statuses,
  people,
  sprints,
  text,
  setText,
  set,
}: {
  basic: Record<string, string | undefined>;
  routeProject?: string;
  projects: { key: string; name: string }[];
  statuses?: { key: string; name: string }[];
  people: User[];
  sprints: Sprint[];
  text: string;
  setText(v: string): void;
  set(k: string, v: string): void;
}) {
  // Status options: the project's own workflow, or the three categories across projects.
  const statusValue = basic.status ? `s:${basic.status}` : basic.category ? `c:${basic.category}` : '';
  return (
    <div className="toolbar wrap">
      <form className="search-box" onSubmit={(e) => { e.preventDefault(); set('q', text); }}>
        <Icon name="search" />
        <input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== (basic.q ?? '') && set('q', text)} placeholder="Texto ou chave (ex: LOJA-12)" />
      </form>
      {!routeProject && (
        <select value={basic.project ?? ''} onChange={(e) => set('project', e.target.value)}>
          <option value="">Todos os projetos</option>
          {projects.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
        </select>
      )}
      <select value={basic.type ?? ''} onChange={(e) => set('type', e.target.value)}>
        <option value="">Tipo: todos</option>
        {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
      </select>
      <select
        value={statusValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v.startsWith('s:')) set('status', v.slice(2));
          else {
            set('status', '');
            set('category', v.slice(2));
          }
        }}
      >
        <option value="">Status: todos</option>
        <option value="c:TODO,IN_PROGRESS">Não concluídos</option>
        {statuses
          ? statuses.map((s) => <option key={s.key} value={`s:${s.key}`}>{s.name}</option>)
          : (['TODO', 'IN_PROGRESS', 'DONE'] as const).map((c) => <option key={c} value={`c:${c}`}>{CATEGORY_LABEL[c]}</option>)}
      </select>
      <select value={basic.priority ?? ''} onChange={(e) => set('priority', e.target.value)}>
        <option value="">Prioridade: todas</option>
        {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
      </select>
      <select value={basic.assignee ?? ''} onChange={(e) => set('assignee', e.target.value)}>
        <option value="">Responsável: todos</option>
        <option value="me">Eu</option>
        <option value="unassigned">Não atribuído</option>
        {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
      {basic.project && (
        <select value={basic.sprint ?? ''} onChange={(e) => set('sprint', e.target.value)}>
          <option value="">Sprint: todas</option>
          <option value="active">Sprint ativa</option>
          <option value="backlog">Backlog (sem sprint)</option>
          {sprints.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
      <input className="label-filter" value={basic.label ?? ''} onChange={(e) => set('label', e.target.value)} placeholder="Etiqueta" />
      <select value={basic.sort} onChange={(e) => set('sort', e.target.value)}>
        <option value="updated">Ordenar: atualizadas</option>
        <option value="created">Ordenar: criadas</option>
        <option value="priority">Ordenar: prioridade</option>
        <option value="key">Ordenar: chave</option>
      </select>
    </div>
  );
}

function SaveFilterModal({ jql, onClose, onSave }: { jql: string; onClose(): void; onSave(name: string, shared: boolean): Promise<void> }) {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal
      title="Salvar filtro"
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-subtle" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" form="save-filter" disabled={!name.trim()}>Salvar</button>
        </>
      }
    >
      <form
        id="save-filter"
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await onSave(name, shared);
            onClose();
          } catch (err) {
            setError(err);
          }
        }}
      >
        <Field label="Nome *">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Bugs críticos do time" />
        </Field>
        <div className="field">
          <span className="field-label">Consulta</span>
          <code className="jql-preview">{jql}</code>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          Compartilhar com todos (cada pessoa só vê as issues dos projetos de que participa)
        </label>
        <ErrorText error={error} />
      </form>
    </Modal>
  );
}

const HELP_FIELDS: [string, string][] = [
  ['project', 'LOJA'],
  ['type', 'Bug, História, Tarefa, Épico, Subtarefa'],
  ['status', '"Em andamento" (nome ou chave do status)'],
  ['statusCategory', 'Done, "A fazer", "Em andamento"'],
  ['priority', 'Alta (aceita >, >=, <, <=)'],
  ['assignee / reporter', 'currentUser(), e-mail, nome ou EMPTY'],
  ['sprint', 'openSprints(), activeSprint(), closedSprints(), "LOJA Sprint 4"'],
  ['epic', 'LOJA-2'],
  ['labels', 'frontend'],
  ['text / summary / description', '~ "texto"'],
  ['created / updated / resolved / due / start', '-7d, -2w, 2026-10-01, startOfDay()'],
  ['storyPoints', '> 3'],
  ['"Nome do campo"', 'campos personalizados, ex.: "Ambiente" = Produção'],
];

function JqlHelp() {
  return (
    <div className="jql-help">
      <div>
        <b>Operadores:</b> <code>=</code> <code>!=</code> <code>&gt;</code> <code>&gt;=</code> <code>&lt;</code> <code>&lt;=</code> <code>~</code> (contém){' '}
        <code>IN (a, b)</code> <code>NOT IN</code> <code>IS EMPTY</code> <code>IS NOT EMPTY</code> · combine com <code>AND</code>, <code>OR</code>,{' '}
        <code>NOT</code> e parênteses · ordene com <code>ORDER BY campo DESC</code>
      </div>
      <table className="table">
        <thead><tr><th>Campo</th><th>Valores de exemplo</th></tr></thead>
        <tbody>{HELP_FIELDS.map(([f, v]) => <tr key={f}><td><code>{f}</code></td><td>{v}</td></tr>)}</tbody>
      </table>
      <div className="muted small">
        Exemplo: <code>project = LOJA AND type = Bug AND statusCategory != Done AND priority &gt;= Alta ORDER BY created DESC</code>
      </div>
    </div>
  );
}

export function IssueTable({ issues, showProject, showSprint }: { issues: Issue[]; showProject?: boolean; showSprint?: boolean }) {
  const openIssue = useOpenIssue();
  return (
    <table className="table issue-table">
      <thead>
        <tr>
          <th style={{ width: 36 }}>Tipo</th>
          <th style={{ width: 90 }}>Chave</th>
          <th>Resumo</th>
          {showProject && <th>Projeto</th>}
          <th>Status</th>
          <th style={{ width: 40 }}>P</th>
          <th>Responsável</th>
          {showSprint && <th>Sprint</th>}
          <th>Atualizado</th>
        </tr>
      </thead>
      <tbody>
        {issues.map((i) => (
          <tr key={i.id} className="clickable" onClick={() => openIssue(i.key)}>
            <td><IssueTypeIcon type={i.type} /></td>
            <td className={`key ${isDone(i) ? 'done' : ''}`}>{i.key}</td>
            <td>
              {i.title}
              {i.labels.map((l) => <span key={l} className="label-chip">{l}</span>)}
            </td>
            {showProject && <td className="muted">{i.project.name}</td>}
            <td><StatusLozenge status={i.statusRef} /></td>
            <td><PriorityIcon priority={i.priority} /></td>
            <td>
              <span className="row gap-sm">
                <Avatar user={i.assignee} size={22} />
                {i.assignee?.name ?? <span className="muted">Não atribuído</span>}
              </span>
            </td>
            {showSprint && <td className="muted">{i.sprint?.name ?? '—'}</td>}
            <td className="muted nowrap">{formatDate(i.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
