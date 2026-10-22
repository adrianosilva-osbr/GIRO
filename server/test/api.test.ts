import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

const app = createApp();

async function register(name: string, email: string) {
  const res = await request(app).post('/api/auth/register').send({ name, email, password: 'segredo1' });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, user: res.body.user as { id: string } };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let owner: { token: string; user: { id: string } };
let outsider: { token: string; user: { id: string } };

beforeAll(async () => {
  owner = await register('Dona', 'dona@test.dev');
  outsider = await register('Fora', 'fora@test.dev');
  const res = await request(app)
    .post('/api/projects')
    .set(auth(owner.token))
    .send({ key: 'test', name: 'Projeto Teste' });
  expect(res.status).toBe(201);
  expect(res.body.project.key).toBe('TEST');
});

describe('auth', () => {
  it('rejects duplicate e-mails and wrong passwords', async () => {
    const dup = await request(app).post('/api/auth/register').send({ name: 'Xavier', email: 'dona@test.dev', password: 'segredo1' });
    expect(dup.status).toBe(409);
    const bad = await request(app).post('/api/auth/login').send({ email: 'dona@test.dev', password: 'errada' });
    expect(bad.status).toBe(401);
    const ok = await request(app).post('/api/auth/login').send({ email: 'DONA@test.dev', password: 'segredo1' });
    expect(ok.status).toBe(200);
  });

  it('requires a token on protected routes', async () => {
    expect((await request(app).get('/api/projects')).status).toBe(401);
  });
});

describe('issues', () => {
  it('assigns sequential keys per project', async () => {
    const a = await request(app).post('/api/issues').set(auth(owner.token)).send({ projectKey: 'TEST', title: 'Primeira' });
    const b = await request(app).post('/api/issues').set(auth(owner.token)).send({ projectKey: 'TEST', title: 'Segunda' });
    expect(a.body.issue.key).toBe('TEST-1');
    expect(b.body.issue.key).toBe('TEST-2');
    expect(b.body.issue.rank).toBeGreaterThan(a.body.issue.rank);
  });

  it('hides project issues from non-members', async () => {
    const res = await request(app).get('/api/issues/TEST-1').set(auth(outsider.token));
    expect(res.status).toBe(403);
    const list = await request(app).get('/api/issues?project=TEST').set(auth(outsider.token));
    expect(list.body.issues).toHaveLength(0);
  });

  it('enforces the epic > issue > subtask hierarchy', async () => {
    const epic = await request(app).post('/api/issues').set(auth(owner.token)).send({ projectKey: 'TEST', title: 'Épico', type: 'EPIC' });
    const story = await request(app).post('/api/issues').set(auth(owner.token))
      .send({ projectKey: 'TEST', title: 'História', type: 'STORY', parentId: epic.body.issue.id });
    expect(story.status).toBe(201);

    const orphan = await request(app).post('/api/issues').set(auth(owner.token)).send({ projectKey: 'TEST', title: 'Sub', type: 'SUBTASK' });
    expect(orphan.status).toBe(400);
    const underEpic = await request(app).post('/api/issues').set(auth(owner.token))
      .send({ projectKey: 'TEST', title: 'Sub', type: 'SUBTASK', parentId: epic.body.issue.id });
    expect(underEpic.status).toBe(400);
    const sub = await request(app).post('/api/issues').set(auth(owner.token))
      .send({ projectKey: 'TEST', title: 'Sub', type: 'SUBTASK', parentId: story.body.issue.id });
    expect(sub.status).toBe(201);

    const detail = await request(app).get(`/api/issues/${story.body.issue.key}`).set(auth(owner.token));
    expect(detail.body.issue.children.map((c: { key: string }) => c.key)).toEqual([sub.body.issue.key]);
  });

  it('records field changes in the activity log and filters by text/status/label', async () => {
    const created = await request(app).post('/api/issues').set(auth(owner.token))
      .send({ projectKey: 'TEST', title: 'Corrigir login', type: 'BUG', labels: ['Auth Flow'] });
    const key = created.body.issue.key;
    expect(created.body.issue.labels).toEqual(['auth-flow']);

    const patched = await request(app).patch(`/api/issues/${key}`).set(auth(owner.token))
      .send({ status: 'IN_PROGRESS', assigneeId: owner.user.id });
    expect(patched.status).toBe(200);

    const detail = await request(app).get(`/api/issues/${key}`).set(auth(owner.token));
    const fields = detail.body.issue.activities.map((a: { field: string | null }) => a.field);
    expect(fields).toEqual(expect.arrayContaining(['status', 'assignee']));

    const found = await request(app).get('/api/issues?project=TEST&q=login&status=IN_PROGRESS&label=auth-flow').set(auth(owner.token));
    expect(found.body.issues.map((i: { key: string }) => i.key)).toEqual([key]);
    const mine = await request(app).get('/api/issues?assignee=me').set(auth(owner.token));
    expect(mine.body.issues.map((i: { key: string }) => i.key)).toContain(key);
  });

  it('rejects assigning to someone outside the project', async () => {
    const res = await request(app).patch('/api/issues/TEST-1').set(auth(owner.token)).send({ assigneeId: outsider.user.id });
    expect(res.status).toBe(400);
  });
});

describe('sprints', () => {
  it('runs a full sprint lifecycle and carries unfinished work over', async () => {
    const s1 = await request(app).post('/api/projects/TEST/sprints').set(auth(owner.token)).send({});
    const s2 = await request(app).post('/api/projects/TEST/sprints').set(auth(owner.token)).send({});
    expect(s1.body.sprint.name).toBe('TEST Sprint 1');

    const empty = await request(app).post(`/api/sprints/${s1.body.sprint.id}/start`).set(auth(owner.token)).send({});
    expect(empty.status).toBe(400);

    const story = await request(app).post('/api/issues').set(auth(owner.token)).send({ projectKey: 'TEST', title: 'Com sub', type: 'STORY' });
    const sub = await request(app).post('/api/issues').set(auth(owner.token))
      .send({ projectKey: 'TEST', title: 'Sub', type: 'SUBTASK', parentId: story.body.issue.id });
    const done = await request(app).post('/api/issues').set(auth(owner.token)).send({ projectKey: 'TEST', title: 'Pronta' });

    // Moving a parent into a sprint drags its subtasks along.
    await request(app).patch(`/api/issues/${story.body.issue.key}`).set(auth(owner.token)).send({ sprintId: s1.body.sprint.id });
    await request(app).patch(`/api/issues/${done.body.issue.key}`).set(auth(owner.token)).send({ sprintId: s1.body.sprint.id, status: 'DONE' });
    const subNow = await request(app).get(`/api/issues/${sub.body.issue.key}`).set(auth(owner.token));
    expect(subNow.body.issue.sprintId).toBe(s1.body.sprint.id);

    const start = await request(app).post(`/api/sprints/${s1.body.sprint.id}/start`).set(auth(owner.token)).send({});
    expect(start.status).toBe(200);
    expect(start.body.sprint.status).toBe('ACTIVE');
    const second = await request(app).post(`/api/sprints/${s2.body.sprint.id}/start`).set(auth(owner.token)).send({});
    expect(second.status).toBe(409);

    const board = await request(app).get('/api/issues?project=TEST&sprint=active').set(auth(owner.token));
    expect(board.body.issues).toHaveLength(3);

    // A finished subtask of an unfinished parent still moves along with the parent.
    await request(app).patch(`/api/issues/${sub.body.issue.key}`).set(auth(owner.token)).send({ status: 'DONE' });

    const complete = await request(app).post(`/api/sprints/${s1.body.sprint.id}/complete`).set(auth(owner.token))
      .send({ moveTo: s2.body.sprint.id });
    expect(complete.body).toMatchObject({ completed: 1, moved: 2 });

    const next = await request(app).get(`/api/issues?project=TEST&sprint=${s2.body.sprint.id}`).set(auth(owner.token));
    expect(next.body.issues).toHaveLength(2);
    const listed = await request(app).get('/api/projects/TEST/sprints').set(auth(owner.token));
    expect(listed.body.sprints.map((s: { id: string }) => s.id)).toEqual([s2.body.sprint.id]);
  });
});

describe('members', () => {
  it('lets admins add members and keeps at least one admin', async () => {
    const added = await request(app).post('/api/projects/TEST/members').set(auth(owner.token)).send({ email: 'fora@test.dev' });
    expect(added.status).toBe(201);
    const visible = await request(app).get('/api/issues/TEST-1').set(auth(outsider.token));
    expect(visible.status).toBe(200);

    const forbidden = await request(app).post('/api/projects/TEST/members').set(auth(outsider.token)).send({ email: 'dona@test.dev', role: 'ADMIN' });
    expect(forbidden.status).toBe(403);
    const demote = await request(app).patch(`/api/projects/TEST/members/${owner.user.id}`).set(auth(owner.token)).send({ role: 'MEMBER' });
    expect(demote.status).toBe(400);
  });
});
