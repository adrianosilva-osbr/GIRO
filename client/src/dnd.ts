import {
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
} from '@dnd-kit/core';
import { rankBetween } from './constants';
import type { Issue } from './types';

// Droppable ids: "issue:<id>" for rows/cards and "list:<id>" for the containers holding them.
export const issueDropId = (id: string) => `issue:${id}`;
export const listDropId = (id: string) => `list:${id}`;

/** Prefer the card under the pointer over the column that contains it. */
export const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const card = hits.find((h) => String(h.id).startsWith('issue:'));
  if (card) return [card];
  return hits.length ? hits : rectIntersection(args);
};

export interface DropTarget {
  listId: string;
  overIssueId: string | null;
  after: boolean;
}

/** Where the dragged item would land: which list, next to which issue, and on which side. */
export function dropTarget(event: DragMoveEvent | DragEndEvent): DropTarget | null {
  const { over, active } = event;
  if (!over) return null;
  const data = over.data.current as { listId: string; issueId?: string } | undefined;
  if (!data) return null;
  const rect = active.rect.current.translated;
  const after = rect ? rect.top + rect.height / 2 > over.rect.top + over.rect.height / 2 : false;
  return { listId: data.listId, overIssueId: data.issueId ?? null, after };
}

/** Rank for the dragged issue inside `list` (ordered by rank, dragged issue excluded). */
export function rankForDrop(list: Issue[], target: DropTarget): number {
  const idx = target.overIssueId ? list.findIndex((i) => i.id === target.overIssueId) : -1;
  if (idx < 0) return rankBetween(list[list.length - 1]?.rank, undefined);
  return target.after
    ? rankBetween(list[idx].rank, list[idx + 1]?.rank)
    : rankBetween(list[idx - 1]?.rank, list[idx].rank);
}
