import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { replaySprint } from '../src/sprintlog.js';

const app = createApp();
let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });

async function issue(body: Record<string, unknown>) {
  const res = await request(app).post('/api/issues').set(auth()).send({ projectKey: 'RPT', ...body });
  expect(res.status).toBe(201);
  return res.body.issue as { id: string; key: string };
}
const patch = (key: string, body: Record<string, unknown>) => request(app).patch(`/api/issues/${key}`).set(auth()).send(body);

beforeAll(async () => {
  const reg = await request(app).post('/api/auth/register').send({ name: 'Rita Relatórios', email: 'rita@rpt.dev', password: 'segredo1' });
  token = reg.body.token;
  await request(app).post('/api/projects').set(auth()).send({ key: 'RPT', name: 'Relatórios' });
});

describe('replaySprint', () => {
  it('separates commitment from later scope changes and tracks remaining work', () => {
    const t = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min));
    const ev = (type: string, id: string, min: number, points: number | null = null, done = false) =>
      ({ type, issueId: id, issueKey: id, points, done, at: t(min) });
    const r = replaySprint(
      [
        ev('committed', 'A', 0, 3),
        ev('committed', 'B', 0, 5),
        ev('done', 'A', 10),
        ev('added', 'C', 20, 4),
        ev('points', 'B', 30, 8),
        ev('removed', 'C', 40),
        ev('reopened', 'A', 50),
        ev('done', 'A', 60),
        ev('done', 'B', 999), // after finish: ignored
      ],
      t(0),
      t(100),
    );
    expect(r.committed).toEqual({ scopePoints: 8, remainingPoints: 8, scopeCount: 2, remainingCount: 2 });
    expect(r.series.map((p) => p.remainingPoints)).toEqual([8, 5, 9, 12, 8, 11, 8, 8]);
    expect(r.series.map((p) => p.scopePoints)).toEqual([8, 8, 12, 15, 11, 11, 11, 11]);
    expect(r.final).toEqual({ scopePoints: 11, remainingPoints: 8, scopeCount: 2, remainingCount: 1 });
    expect(r.states.get('C')).toMatchObject({ in: false, wasIn: true, addedLater: true });
  });
});

describe('sprint report, velocity and resolution dates', () => {
  it('tracks an active sprint end to end', async () => {
    const sprint = (await request(app).post('/api/projects/RPT/sprints').set(auth()).send({})).body.sprint;
    const planned = await request(app).get(`/api/sprints/${sprint.id}/report`).set(auth());
    expect(planned.status).toBe(400);

    const a = await issue({ title: 'A', type: 'STORY', storyPoints: 3, sprintId: sprint.id });
    const b = await issue({ title: 'B', type: 'STORY', storyPoints: 5, sprintId: sprint.id });
    const c = await issue({ title: 'C', type: 'TASK', storyPoints: 2, sprintId: sprint.id });
    await request(app).post(`/api/sprints/${sprint.id}/start`).set(auth()).send({});

    await patch(a.key, { status: 'DONE' });
    const d = await issue({ title: 'D', type: 'BUG', storyPoints: 4, sprintId: sprint.id }); // scope added
    await patch(c.key, { sprintId: null }); // scope removed
    await patch(b.key, { storyPoints: 8 }); // re-estimated
    await issue({ title: 'sub', type: 'SUBTASK', parentId: b.id }); // subtasks don't count

    const report = (await request(app).get(`/api/sprints/${sprint.id}/report`).set(auth())).body;
    expect(report.committed.scopePoints).toBe(10);
    expect(report.final).toEqual({ scopePoints: 15, remainingPoints: 12, scopeCount: 3, remainingCount: 2 });
    expect(report.series.length).toBe(2 + 4);
    const keys = (rows: { key: string }[]) => rows.map((r) => r.key).sort();
    expect(keys(report.issues.completed)).toEqual([a.key]);
    expect(keys(report.issues.notCompleted)).toEqual([b.key, d.key].sort());
    expect(keys(report.issues.removed)).toEqual([c.key]);
    expect(report.issues.notCompleted.find((r: { key: string }) => r.key === d.key).addedAfterStart).toBe(true);

    // Deleting an issue keeps the history (shown as removed, by key).
    await request(app).delete(`/api/issues/${d.key}`).set(auth());
    const after = (await request(app).get(`/api/sprints/${sprint.id}/report`).set(auth())).body;
    expect(after.issues.removed.find((r: { key: string }) => r.key === d.key)).toMatchObject({ deleted: true });

    // Completing moves B out without rewriting history: velocity sees 10 committed, 3 done.
    await request(app).post(`/api/sprints/${sprint.id}/complete`).set(auth()).send({ moveTo: 'backlog' });
    const velocity = (await request(app).get('/api/projects/RPT/velocity').set(auth())).body;
    expect(velocity.sprints).toHaveLength(1);
    expect(velocity.sprints[0]).toMatchObject({ committedPoints: 10, completedPoints: 3, status: 'CLOSED' });
    expect(velocity.averagePoints).toBe(3);
  });

  it('sets resolvedAt when an issue is done and clears it on reopen', async () => {
    const x = await issue({ title: 'X' });
    const done = await patch(x.key, { status: 'DONE' });
    expect(done.body.issue.resolvedAt).toBeTruthy();
    const reopened = await patch(x.key, { status: 'IN_PROGRESS' });
    expect(reopened.body.issue.resolvedAt).toBeNull();
  });
});

describe('summary and epics', () => {
  it('aggregates the project', async () => {
    const epic = await issue({ title: 'Épico', type: 'EPIC', startDate: '2026-11-05', dueDate: '2027-01-20' });
    const s1 = await issue({ title: 'E1', type: 'STORY', parentId: epic.id, storyPoints: 5 });
    await issue({ title: 'E2', type: 'STORY', parentId: epic.id, storyPoints: 3 });
    await patch(s1.key, { status: 'DONE' });
    await issue({ title: 'Atrasada', dueDate: '2020-01-01' });

    const summary = (await request(app).get('/api/projects/RPT/summary?tz=180').set(auth())).body;
    expect(summary.byStatus.map((s: { key: string }) => s.key)).toEqual(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE']);
    expect(summary.totals.all).toBe(summary.byStatus.reduce((n: number, s: { count: number }) => n + s.count, 0));
    expect(summary.totals.overdue).toBe(1);
    expect(summary.createdVsResolved).toHaveLength(30);
    const today = summary.createdVsResolved[29];
    expect(today.created).toBe(summary.totals.createdLast7);
    expect(summary.workload.find((w: { user: null }) => w.user === null).open).toBe(summary.totals.open);

    const epics = (await request(app).get('/api/projects/RPT/epics').set(auth())).body.epics;
    expect(epics[0]).toMatchObject({ key: epic.key, total: 2, done: 1, points: 8, donePoints: 5 });
    expect(epics[0].startDate.slice(0, 10)).toBe('2026-11-05');
  });
});
