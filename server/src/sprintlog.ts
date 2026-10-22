import type { Prisma, PrismaClient, Sprint, SprintEvent } from '@prisma/client';
import { isDone } from './workflow.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** The issue fields that matter for sprint tracking. */
export interface TrackedIssue {
  id: string;
  key: string;
  type: string;
  statusRef: { category: string } | null;
  storyPoints: number | null;
  sprintId: string | null;
}

/**
 * Records how an issue change affects an ACTIVE sprint. Pass `before: null` for a new issue
 * and `after: null` for a deleted one. Subtasks are ignored: their effort counts on the parent.
 */
export async function logSprintChanges(db: Db, before: TrackedIssue | null, after: TrackedIssue | null, at = new Date()) {
  const issue = (after ?? before)!;
  if (issue.type === 'SUBTASK') return;
  const ids = [...new Set([before?.sprintId, after?.sprintId].filter((s): s is string => !!s))];
  if (!ids.length) return;
  const active = new Set(
    (await db.sprint.findMany({ where: { id: { in: ids }, status: 'ACTIVE' }, select: { id: true } })).map((s) => s.id),
  );
  if (!active.size) return;

  const events: Prisma.SprintEventCreateManyInput[] = [];
  const base = { issueId: issue.id, issueKey: issue.key, at };
  const from = before?.sprintId ?? null;
  const to = after?.sprintId ?? null;

  if (from !== to) {
    if (from && active.has(from)) events.push({ ...base, sprintId: from, type: 'removed' });
    if (to && active.has(to)) {
      events.push({ ...base, sprintId: to, type: 'added', points: after!.storyPoints, done: isDone(after!) });
    }
  } else if (before && after && to && active.has(to)) {
    const wasDone = isDone(before);
    const nowDone = isDone(after);
    if (wasDone !== nowDone) events.push({ ...base, sprintId: to, type: nowDone ? 'done' : 'reopened' });
    if (before.storyPoints !== after.storyPoints) events.push({ ...base, sprintId: to, type: 'points', points: after.storyPoints });
  }
  if (events.length) await db.sprintEvent.createMany({ data: events });
}

/** Commitment snapshot taken when a sprint starts. */
export async function logSprintStart(db: Db, sprint: Pick<Sprint, 'id'>, at: Date) {
  const issues = await db.issue.findMany({
    where: { sprintId: sprint.id, type: { not: 'SUBTASK' } },
    select: { id: true, key: true, storyPoints: true, statusRef: { select: { category: true } } },
  });
  await db.sprintEvent.createMany({
    data: issues.map((i) => ({
      sprintId: sprint.id,
      issueId: i.id,
      issueKey: i.key,
      type: 'committed',
      points: i.storyPoints,
      done: isDone(i),
      at,
    })),
  });
}

interface IssueState {
  key: string;
  in: boolean;
  done: boolean;
  points: number;
  /** Joined after the commitment snapshot. */
  addedLater: boolean;
  wasIn: boolean;
}

export interface Totals {
  scopePoints: number;
  remainingPoints: number;
  scopeCount: number;
  remainingCount: number;
}

export interface SeriesPoint extends Totals {
  at: string;
  /** What changed at this instant (absent for the start/end anchors). */
  change?: { type: string; issueKey: string };
}

function totals(state: Map<string, IssueState>): Totals {
  let scopePoints = 0, remainingPoints = 0, scopeCount = 0, remainingCount = 0;
  for (const s of state.values()) {
    if (!s.in) continue;
    scopePoints += s.points;
    scopeCount += 1;
    if (!s.done) {
      remainingPoints += s.points;
      remainingCount += 1;
    }
  }
  return { scopePoints, remainingPoints, scopeCount, remainingCount };
}

function apply(state: Map<string, IssueState>, e: Pick<SprintEvent, 'issueId' | 'issueKey' | 'type' | 'points' | 'done'>, committed: boolean) {
  const s = state.get(e.issueId) ?? { key: e.issueKey, in: false, done: false, points: 0, addedLater: false, wasIn: false };
  switch (e.type) {
    case 'committed':
    case 'added':
      s.in = true;
      s.wasIn = true;
      s.done = e.done;
      s.points = e.points ?? 0;
      if (committed && e.type === 'added') s.addedLater = true;
      break;
    case 'removed':
      s.in = false;
      break;
    case 'done':
      s.done = true;
      break;
    case 'reopened':
      s.done = false;
      break;
    case 'points':
      s.points = e.points ?? 0;
      break;
  }
  state.set(e.issueId, s);
}

export interface Replay {
  start: Date;
  finish: Date;
  committed: Totals;
  final: Totals;
  series: SeriesPoint[];
  states: Map<string, IssueState>;
}

/**
 * Replays a sprint's events from its start to `finish` (completion, or now while active).
 * The 'committed' snapshot (plus anything stamped before the start) forms the commitment;
 * everything after is scope change and progress.
 */
type EventLike = Pick<SprintEvent, 'issueId' | 'issueKey' | 'type' | 'points' | 'done' | 'at'>;

export function replaySprint(
  events: EventLike[],
  start: Date,
  finish: Date,
): Replay {
  const state = new Map<string, IssueState>();
  const initial = (e: EventLike) => e.type === 'committed' || e.at < start;
  const byTime = (a: EventLike, b: EventLike) => a.at.getTime() - b.at.getTime();
  for (const e of events.filter(initial).sort(byTime)) apply(state, e, false);
  const committed = totals(state);
  const series: SeriesPoint[] = [{ at: start.toISOString(), ...committed }];
  for (const e of events.filter((e) => !initial(e) && e.at <= finish).sort(byTime)) {
    apply(state, e, true);
    series.push({ at: e.at.toISOString(), ...totals(state), change: { type: e.type, issueKey: e.issueKey } });
  }
  const final = totals(state);
  series.push({ at: finish.toISOString(), ...final });
  return { start, finish, committed, final, series, states: state };
}
