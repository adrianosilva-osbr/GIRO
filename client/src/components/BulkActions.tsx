import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { api, getToken, qs } from '../api';
import { PRIORITIES, PRIORITY_LABEL } from '../constants';
import { useInvalidateWork, useSprints } from '../hooks';
import type { Issue, Project, User } from '../types';
import { Icon } from './Icons';
import { useToast } from './Toast';

interface BulkResult {
  results: { key: string; ok: boolean; error?: string }[];
  updated: number;
  failed: number;
}

/** Toolbar shown while issues are selected in the search results. */
export function BulkBar({ issues, onDone, onClear }: { issues: Issue[]; onDone(): void; onClear(): void }) {
  const invalidate = useInvalidateWork();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<BulkResult['results']>([]);
  const projectKeys = [...new Set(issues.map((i) => i.project.key))];
  const projects = useQueries({
    queries: projectKeys.map((key) => ({
      queryKey: ['project', key],
      queryFn: () => api<{ project: Project }>(`/projects/${key}`).then((r) => r.project),
    })),
  }).map((q) => q.data).filter((p): p is Project => !!p);
  const single = projectKeys.length === 1 ? projectKeys[0] : undefined;
  const { data: sprints = [] } = useSprints(single);

  // Options valid in at least one of the involved projects; the server reports issues where they aren't.
  const statuses = new Map<string, string>();
  for (const p of projects) for (const s of p.statuses ?? []) if (!statuses.has(s.key)) statuses.set(s.key, s.name);
  const people = new Map<string, User>();
  for (const p of projects) for (const m of p.members ?? []) people.set(m.userId, m.user);

  const run = async (body: Record<string, unknown>, what: string) => {
    setBusy(true);
    setFailures([]);
    try {
      const r = await api<BulkResult>('/issues/bulk', { method: 'POST', body: { keys: issues.map((i) => i.key), ...body } });
      await invalidate();
      toast(r.failed ? `${what}: ${r.updated} ok, ${r.failed} com erro` : `${what}: ${r.updated} issue(s)`, r.failed ? 'error' : 'success');
      setFailures(r.results.filter((x) => !x.ok));
      if (!r.failed) onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const change = (changes: Record<string, unknown>, what: string) => run({ changes }, what);

  return (
    <div className="bulk-bar" role="toolbar" aria-label="Ações em massa">
      <b>{issues.length} selecionada(s)</b>
      <select disabled={busy} value="" onChange={(e) => e.target.value && change({ status: e.target.value }, 'Status alterado')}>
        <option value="">Mudar status…</option>
        {[...statuses].map(([key, name]) => <option key={key} value={key}>{name}</option>)}
      </select>
      <select
        disabled={busy}
        value=""
        onChange={(e) => e.target.value && change({ assigneeId: e.target.value === '__none' ? null : e.target.value }, 'Responsável alterado')}
      >
        <option value="">Atribuir a…</option>
        <option value="__none">Ninguém</option>
        {[...people.values()].map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
      <select disabled={busy} value="" onChange={(e) => e.target.value && change({ priority: e.target.value }, 'Prioridade alterada')}>
        <option value="">Prioridade…</option>
        {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
      </select>
      {single && (
        <select
          disabled={busy}
          value=""
          onChange={(e) => e.target.value && change({ sprintId: e.target.value === '__backlog' ? null : e.target.value }, 'Sprint alterada')}
        >
          <option value="">Mover para sprint…</option>
          <option value="__backlog">Backlog</option>
          {sprints.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
      <button
        className="btn btn-subtle"
        disabled={busy}
        onClick={() => {
          const label = prompt('Etiqueta para adicionar:');
          if (label?.trim()) change({ addLabels: [label.trim()] }, 'Etiqueta adicionada');
        }}
      >
        + Etiqueta
      </button>
      <button
        className="btn btn-subtle danger-text"
        disabled={busy}
        onClick={() => confirm(`Excluir ${issues.length} issue(s) e suas subtarefas? Esta ação não pode ser desfeita.`) && run({ delete: true }, 'Excluídas')}
      >
        <Icon name="trash" /> Excluir
      </button>
      <div className="spacer" />
      <button className="btn btn-subtle" onClick={onClear}>Limpar seleção</button>
      {failures.length > 0 && (
        <ul className="bulk-failures">
          {failures.map((f) => <li key={f.key}><b>{f.key}</b>: {f.error}</li>)}
        </ul>
      )}
    </div>
  );
}

/** Downloads the current search as CSV or Excel (the request needs the auth header, so it goes through fetch). */
export async function downloadExport(format: 'csv' | 'xlsx', query: Record<string, string | undefined>) {
  const res = await fetch(`/api/issues/export${qs({ ...query, format, tz: String(new Date().getTimezoneOffset()), limit: undefined })}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Erro ${res.status}`);
  }
  const blob = await res.blob();
  const name = res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ?? `giro-issues.${format}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportMenu({ query }: { query: Record<string, string | undefined> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const run = async (format: 'csv' | 'xlsx') => {
    setOpen(false);
    setBusy(true);
    try {
      await downloadExport(format, query);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="menu-wrap">
      <button className="btn" onClick={() => setOpen((o) => !o)} disabled={busy}>
        {busy ? 'Exportando…' : 'Exportar'} <Icon name="chevron" />
      </button>
      {open && (
        <div className="dropdown right" onMouseLeave={() => setOpen(false)}>
          <button onClick={() => run('xlsx')}>Excel (.xlsx)</button>
          <button onClick={() => run('csv')}>CSV</button>
        </div>
      )}
    </div>
  );
}
