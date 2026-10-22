import { Router } from 'express';
import type { Sprint, SprintEvent } from '@prisma/client';
import { prisma } from '../db.js';
import { ah, HttpError } from '../errors.js';
import { currentUser, userSelect } from '../auth.js';
import { loadProject, loadSprint } from '../access.js';
import { replaySprint } from '../sprintlog.js';
import { isDone, projectStatuses } from '../workflow.js';

type EventLike = Pick<SprintEvent, 'issueId' | 'issueKey' | 'type' | 'points' | 'done' | 'at'>;

/**
 * Sprint events, or — for sprints started before event logging existed — an approximation
 * built from the issues still in the sprint and when they were resolved.
 */
async function eventsFor(sprint: Sprint): Promise<{ events: EventLike[]; synthetic: boolean }> {
  const events = await prisma.sprintEvent.findMany({ where: { sprintId: sprint.id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
  if (events.length || !sprint.startDate) return { events, synthetic: false };
  const start = sprint.startDate;
  const issues = await prisma.issue.findMany({
    where: { sprintId: sprint.id, type: { not: 'SUBTASK' } },
    include: { statusRef: { select: { category: true } } },
  });
  const synthetic: EventLike[] = [];
  for (const i of issues) {
    const doneAtStart = isDone(i) && (!i.resolvedAt || i.resolvedAt <= start);
    synthetic.push({ issueId: i.id, issueKey: i.key, type: 'committed', points: i.storyPoints, done: doneAtStart, at: start });
    if (isDone(i) && !doneAtStart) {
      synthetic.push({ issueId: i.id, issueKey: i.key, type: 'done', points: null, done: true, at: i.resolvedAt! });
    }
  }
  return { events: synthetic, synthetic: true };
}

function finishOf(sprint: Sprint) {
  const end = sprint.completedAt ?? new Date();
  return sprint.startDate && end < sprint.startDate ? sprint.startDate : end;
}

/** Mounted at /api/sprints */
export const sprintReportsRouter = Router();

sprintReportsRouter.get(
  '/:id/report',
  ah(async (req, res) => {
    const user = currentUser(req);
    const sprint = await loadSprint(req.params.id, user.id);
    if (sprint.status === 'PLANNED' || !sprint.startDate) throw new HttpError(400, 'Esta sprint ainda não foi iniciada');
    const { events, synthetic } = await eventsFor(sprint);
    const replay = replaySprint(events, sprint.startDate, finishOf(sprint));

    const current = await prisma.issue.findMany({
      where: { id: { in: [...replay.states.keys()] } },
      select: {
        id: true, key: true, title: true, type: true, status: true, priority: true,
        assignee: { select: userSelect }, statusRef: { select: { key: true, name: true, category: true } },
      },
    });
    const byId = new Map(current.map((i) => [i.id, i]));
    const row = (id: string, s: { key: string; points: number; addedLater: boolean }) => ({
      ...(byId.get(id) ?? { id, key: s.key, title: '(issue excluída)', type: 'TASK', status: 'TODO', statusRef: null, priority: 'MEDIUM', assignee: null, deleted: true }),
      points: s.points,
      addedAfterStart: s.addedLater,
    });
    const completed = [], notCompleted = [], removed = [];
    for (const [id, s] of replay.states) {
      if (s.in && s.done) completed.push(row(id, s));
      else if (s.in) notCompleted.push(row(id, s));
      else if (s.wasIn) removed.push(row(id, s));
    }

    const { project, ...sprintData } = sprint;
    res.json({
      sprint: { ...sprintData, projectKey: project.key },
      synthetic,
      start: replay.start,
      end: sprint.endDate,
      finish: replay.finish,
      committed: replay.committed,
      final: replay.final,
      series: replay.series,
      issues: { completed, notCompleted, removed },
    });
  }),
);

/** Mounted at /api/projects/:key */
export const projectReportsRouter = Router({ mergeParams: true });

projectReportsRouter.get(
  '/velocity',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { project } = await loadProject((req.params as { key: string }).key, user.id);
    const closed = await prisma.sprint.findMany({
      where: { projectId: project.id, status: 'CLOSED', startDate: { not: null } },
      orderBy: { completedAt: 'desc' },
      take: 7,
    });
    const active = await prisma.sprint.findFirst({ where: { projectId: project.id, status: 'ACTIVE' } });
    const sprints = [...closed.reverse(), ...(active?.startDate ? [active] : [])];

    const rows: {
      id: string;
      name: string;
      status: string;
      startDate: Date | null;
      completedAt: Date | null;
      committedPoints: number;
      completedPoints: number;
      committedCount: number;
      completedCount: number;
    }[] = [];
    for (const s of sprints) {
      const { events } = await eventsFor(s);
      const r = replaySprint(events, s.startDate!, finishOf(s));
      rows.push({
        id: s.id,
        name: s.name,
        status: s.status,
        startDate: s.startDate,
        completedAt: s.completedAt,
        committedPoints: r.committed.scopePoints,
        completedPoints: r.final.scopePoints - r.final.remainingPoints,
        committedCount: r.committed.scopeCount,
        completedCount: r.final.scopeCount - r.final.remainingCount,
      });
    }
    const done = rows.filter((r) => r.status === 'CLOSED');
    const avg = (f: (r: (typeof rows)[number]) => number) =>
      done.length ? Math.round((done.reduce((sum, r) => sum + f(r), 0) / done.length) * 10) / 10 : null;
    res.json({
      sprints: rows,
      averagePoints: avg((r) => r.completedPoints),
      averageCount: avg((r) => r.completedCount),
    });
  }),
);

/** Epics with progress of the issues inside them; feeds the summary and the timeline. */
async function epicProgress(projectId: string) {
  const epics = await prisma.issue.findMany({
    where: { projectId, type: 'EPIC' },
    include: {
      assignee: { select: userSelect },
      children: { where: { type: { not: 'SUBTASK' } }, select: { storyPoints: true, statusRef: { select: { category: true } } } },
      statusRef: { select: { key: true, name: true, category: true } },
    },
    orderBy: { rank: 'asc' },
  });
  return epics.map(({ children, labels: _labels, ...e }) => ({
    ...e,
    total: children.length,
    done: children.filter(isDone).length,
    points: children.reduce((s, c) => s + (c.storyPoints ?? 0), 0),
    donePoints: children.filter(isDone).reduce((s, c) => s + (c.storyPoints ?? 0), 0),
  }));
}

projectReportsRouter.get(
  '/epics',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { project } = await loadProject((req.params as { key: string }).key, user.id);
    res.json({ epics: await epicProgress(project.id) });
  }),
);

const DAY = 86_400_000;

projectReportsRouter.get(
  '/summary',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { project } = await loadProject((req.params as { key: string }).key, user.id);
    // Client's UTC offset in minutes (Date#getTimezoneOffset), so "days" match the viewer's calendar.
    const tz = Math.max(-840, Math.min(840, Number(req.query.tz) || 0));
    const dayKey = (d: Date) => new Date(d.getTime() - tz * 60_000).toISOString().slice(0, 10);

    const issues = await prisma.issue.findMany({
      where: { projectId: project.id },
      select: {
        status: true, type: true, priority: true, assigneeId: true, statusRef: { select: { category: true } },
        createdAt: true, updatedAt: true, resolvedAt: true, dueDate: true,
      },
    });
    const now = Date.now();
    const weekAgo = new Date(now - 7 * DAY);
    const count = <K extends string>(key: (i: (typeof issues)[number]) => K) => {
      const out: Record<string, number> = {};
      for (const i of issues) out[key(i)] = (out[key(i)] ?? 0) + 1;
      return out;
    };
    const open = issues.filter((i) => !isDone(i));
    const today = dayKey(new Date());

    const workload: Record<string, number> = {};
    for (const i of open) workload[i.assigneeId ?? 'unassigned'] = (workload[i.assigneeId ?? 'unassigned'] ?? 0) + 1;
    const members = await prisma.projectMember.findMany({ where: { projectId: project.id }, include: { user: { select: userSelect } } });

    // Created vs resolved, one bucket per day for the last 30 days (oldest first).
    const days: { day: string; created: number; resolved: number }[] = [];
    for (let d = 29; d >= 0; d--) days.push({ day: dayKey(new Date(now - d * DAY)), created: 0, resolved: 0 });
    const index = new Map(days.map((d, i) => [d.day, i]));
    for (const i of issues) {
      const c = index.get(dayKey(i.createdAt));
      if (c !== undefined) days[c].created++;
      if (i.resolvedAt) {
        const r = index.get(dayKey(i.resolvedAt));
        if (r !== undefined) days[r].resolved++;
      }
    }

    const recent = await prisma.activity.findMany({
      where: { issue: { projectId: project.id } },
      include: { user: { select: userSelect }, issue: { select: { key: true, title: true, type: true } } },
      orderBy: { createdAt: 'desc' },
      take: 12,
    });

    res.json({
      totals: {
        all: issues.length,
        open: open.length,
        createdLast7: issues.filter((i) => i.createdAt >= weekAgo).length,
        resolvedLast7: issues.filter((i) => i.resolvedAt && i.resolvedAt >= weekAgo).length,
        updatedLast7: issues.filter((i) => i.updatedAt >= weekAgo).length,
        overdue: open.filter((i) => i.dueDate && dayKey(i.dueDate) < today).length,
        dueSoon: open.filter((i) => i.dueDate && dayKey(i.dueDate) >= today && i.dueDate.getTime() <= now + 7 * DAY).length,
      },
      // One row per workflow column, in board order.
      byStatus: (await projectStatuses(project.id)).map((s) => ({
        key: s.key, name: s.name, category: s.category,
        count: issues.filter((i) => i.status === s.key).length,
      })),
      byType: count((i) => i.type),
      byPriority: count((i) => i.priority),
      workload: [
        ...members.map((m) => ({ user: m.user, open: workload[m.userId] ?? 0 })),
        { user: null, open: workload.unassigned ?? 0 },
      ].sort((a, b) => b.open - a.open),
      createdVsResolved: days,
      epics: await epicProgress(project.id),
      recent,
    });
  }),
);
