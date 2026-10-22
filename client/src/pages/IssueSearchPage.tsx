import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PRIORITIES, PRIORITY_LABEL, STATUSES, STATUS_LABEL, TYPES, TYPE_LABEL, formatDate } from '../constants';
import { useIssues, useOpenIssue, useProject, useProjects, useSprints, useUsers } from '../hooks';
import type { Issue } from '../types';
import { Icon, IssueTypeIcon, PriorityIcon } from '../components/Icons';
import { Avatar, EmptyState, Spinner, StatusLozenge } from '../components/ui';

const FILTER_KEYS = ['q', 'project', 'type', 'status', 'priority', 'assignee', 'sprint', 'label', 'sort'] as const;

/** Issue search with URL-backed filters. Global at /filters, scoped at /projects/:key/issues. */
export function IssueSearchPage() {
  const { key: routeProject } = useParams();
  const [params, setParams] = useSearchParams();
  const filters: Record<string, string | undefined> = {};
  for (const k of FILTER_KEYS) filters[k] = params.get(k) || undefined;
  if (routeProject) filters.project = routeProject;
  filters.sort ??= 'updated';

  const [text, setText] = useState(filters.q ?? '');
  useEffect(() => setText(params.get('q') ?? ''), [params]);

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k === 'project') next.delete('sprint');
    setParams(next, { replace: true });
  };

  const { data: projects = [] } = useProjects();
  const { data: project } = useProject(filters.project);
  const { data: users = [] } = useUsers();
  const { data: sprints = [] } = useSprints(filters.project, true);
  const people = filters.project ? (project?.members?.map((m) => m.user) ?? []) : users;
  const { data: issues, isLoading, error } = useIssues(filters);
  const hasFilters = FILTER_KEYS.some((k) => k !== 'sort' && params.get(k));

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">{routeProject ? 'Issues' : 'Pesquisar issues'}</h1>
      </div>
      <div className="toolbar wrap">
        <form
          className="search-box"
          onSubmit={(e) => {
            e.preventDefault();
            set('q', text);
          }}
        >
          <Icon name="search" />
          <input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== (filters.q ?? '') && set('q', text)} placeholder="Texto ou chave (ex: LOJA-12)" />
        </form>
        {!routeProject && (
          <select value={filters.project ?? ''} onChange={(e) => set('project', e.target.value)}>
            <option value="">Todos os projetos</option>
            {projects.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
          </select>
        )}
        <select value={filters.type ?? ''} onChange={(e) => set('type', e.target.value)}>
          <option value="">Tipo: todos</option>
          {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <select value={filters.status ?? ''} onChange={(e) => set('status', e.target.value)}>
          <option value="">Status: todos</option>
          <option value="TODO,IN_PROGRESS,IN_REVIEW">Não concluídos</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <select value={filters.priority ?? ''} onChange={(e) => set('priority', e.target.value)}>
          <option value="">Prioridade: todas</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </select>
        <select value={filters.assignee ?? ''} onChange={(e) => set('assignee', e.target.value)}>
          <option value="">Responsável: todos</option>
          <option value="me">Eu</option>
          <option value="unassigned">Não atribuído</option>
          {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        {filters.project && (
          <select value={filters.sprint ?? ''} onChange={(e) => set('sprint', e.target.value)}>
            <option value="">Sprint: todas</option>
            <option value="active">Sprint ativa</option>
            <option value="backlog">Backlog (sem sprint)</option>
            {sprints.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <input className="label-filter" value={filters.label ?? ''} onChange={(e) => set('label', e.target.value)} placeholder="Etiqueta" />
        <select value={filters.sort} onChange={(e) => set('sort', e.target.value)}>
          <option value="updated">Ordenar: atualizadas</option>
          <option value="created">Ordenar: criadas</option>
          <option value="priority">Ordenar: prioridade</option>
          <option value="key">Ordenar: chave</option>
        </select>
        {hasFilters && (
          <button
            className="btn btn-subtle"
            onClick={() => {
              setText('');
              setParams(new URLSearchParams(), { replace: true });
            }}
          >
            Limpar filtros
          </button>
        )}
      </div>

      {isLoading ? (
        <Spinner />
      ) : error ? (
        <EmptyState title="Erro ao buscar">{error.message}</EmptyState>
      ) : issues?.length ? (
        <>
          <div className="muted small mb-sm">{issues.length} issue(s)</div>
          <IssueTable issues={issues} showProject={!filters.project} showSprint />
        </>
      ) : (
        <EmptyState title="Nenhuma issue encontrada">Tente ajustar os filtros.</EmptyState>
      )}
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
            <td className={`key ${i.status === 'DONE' ? 'done' : ''}`}>{i.key}</td>
            <td>
              {i.title}
              {i.labels.map((l) => <span key={l} className="label-chip">{l}</span>)}
            </td>
            {showProject && <td className="muted">{i.project.name}</td>}
            <td><StatusLozenge status={i.status} /></td>
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
