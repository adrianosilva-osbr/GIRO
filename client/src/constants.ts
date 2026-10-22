import type { IssueType, Priority, Status } from './types';

export const STATUSES: Status[] = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'];
export const STATUS_LABEL: Record<Status, string> = {
  TODO: 'A fazer',
  IN_PROGRESS: 'Em andamento',
  IN_REVIEW: 'Em revisão',
  DONE: 'Concluído',
};

export const TYPES: IssueType[] = ['EPIC', 'STORY', 'TASK', 'BUG', 'SUBTASK'];
export const CREATABLE_TYPES: IssueType[] = ['STORY', 'TASK', 'BUG', 'EPIC'];
export const TYPE_LABEL: Record<IssueType, string> = {
  EPIC: 'Épico',
  STORY: 'História',
  TASK: 'Tarefa',
  BUG: 'Bug',
  SUBTASK: 'Subtarefa',
};

export const PRIORITIES: Priority[] = ['HIGHEST', 'HIGH', 'MEDIUM', 'LOW', 'LOWEST'];
export const PRIORITY_LABEL: Record<Priority, string> = {
  HIGHEST: 'Muito alta',
  HIGH: 'Alta',
  MEDIUM: 'Média',
  LOW: 'Baixa',
  LOWEST: 'Muito baixa',
};

export const FIELD_LABEL: Record<string, string> = {
  title: 'resumo',
  description: 'descrição',
  type: 'tipo',
  status: 'status',
  priority: 'prioridade',
  storyPoints: 'story points',
  labels: 'etiquetas',
  dueDate: 'data limite',
  assignee: 'responsável',
  sprint: 'sprint',
  parent: 'issue pai',
};

/** Translates raw activity values (enum codes) into display text. */
export function displayValue(field: string, value: string | null): string {
  if (value == null || value === '') return 'Nenhum';
  if (field === 'status') return STATUS_LABEL[value as Status] ?? value;
  if (field === 'priority') return PRIORITY_LABEL[value as Priority] ?? value;
  if (field === 'type') return TYPE_LABEL[value as IssueType] ?? value;
  if (field === 'dueDate') return formatDate(value);
  if (field === 'labels') return value.split(',').join(', ');
  return value;
}

export function formatDate(value: string | null | undefined) {
  if (!value) return '';
  const d = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(value: string) {
  return new Date(value).toLocaleString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function timeAgo(value: string) {
  const diff = (Date.now() - new Date(value).getTime()) / 1000;
  if (diff < 60) return 'agora mesmo';
  if (diff < 3600) return `há ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `há ${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 7) return `há ${Math.floor(diff / 86400)} dia(s)`;
  return formatDate(value);
}

export function daysLeft(endDate: string | null) {
  if (!endDate) return null;
  return Math.ceil((new Date(endDate).getTime() - Date.now()) / 86400000);
}

/** Rank for an item placed between two neighbours (either may be missing). */
export function rankBetween(before?: number, after?: number) {
  if (before == null && after == null) return 1;
  if (before == null) return after! - 1;
  if (after == null) return before + 1;
  return (before + after) / 2;
}
