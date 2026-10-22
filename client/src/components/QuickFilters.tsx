import { useState } from 'react';
import type { Issue, Member } from '../types';
import { Icon } from './Icons';
import { Avatar } from './ui';

export interface QuickFilterState {
  text: string;
  assignees: string[]; // user ids, or 'unassigned'
  epicId: string;
}

export function useQuickFilters() {
  const [state, setState] = useState<QuickFilterState>({ text: '', assignees: [], epicId: '' });
  const apply = (issues: Issue[]) =>
    issues.filter((i) => {
      if (state.text) {
        const t = state.text.toLowerCase();
        if (!i.title.toLowerCase().includes(t) && !i.key.toLowerCase().includes(t)) return false;
      }
      if (state.assignees.length && !state.assignees.includes(i.assigneeId ?? 'unassigned')) return false;
      if (state.epicId && i.parentId !== state.epicId) return false;
      return true;
    });
  const active = !!(state.text || state.assignees.length || state.epicId);
  return { state, setState, apply, active };
}

export function QuickFilters({
  members,
  epics,
  filters,
}: {
  members: Member[];
  epics?: Issue[];
  filters: ReturnType<typeof useQuickFilters>;
}) {
  const { state, setState, active } = filters;
  const toggle = (id: string) =>
    setState((s) => ({
      ...s,
      assignees: s.assignees.includes(id) ? s.assignees.filter((a) => a !== id) : [...s.assignees, id],
    }));

  return (
    <div className="toolbar">
      <div className="search-box">
        <Icon name="search" />
        <input value={state.text} onChange={(e) => setState((s) => ({ ...s, text: e.target.value }))} placeholder="Pesquisar" />
      </div>
      <div className="avatar-filter">
        {members.map((m) => (
          <button
            key={m.userId}
            className={state.assignees.includes(m.userId) ? 'selected' : ''}
            onClick={() => toggle(m.userId)}
            title={m.user.name}
          >
            <Avatar user={m.user} size={30} />
          </button>
        ))}
        <button className={state.assignees.includes('unassigned') ? 'selected' : ''} onClick={() => toggle('unassigned')} title="Não atribuído">
          <Avatar user={null} size={30} />
        </button>
      </div>
      {epics && epics.length > 0 && (
        <select value={state.epicId} onChange={(e) => setState((s) => ({ ...s, epicId: e.target.value }))}>
          <option value="">Épico: todos</option>
          {epics.map((ep) => <option key={ep.id} value={ep.id}>{ep.title}</option>)}
        </select>
      )}
      {active && (
        <button className="btn btn-subtle" onClick={() => setState({ text: '', assignees: [], epicId: '' })}>
          Limpar filtros
        </button>
      )}
    </div>
  );
}
