import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import zlib from 'node:zlib';
import { createApp } from '../src/app.js';
import { formatDuration, parseDuration } from '../src/duration.js';

const app = createApp();
let owner = { token: '', id: '' };
let other = { token: '', id: '' };
const as = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });

async function register(name: string, email: string) {
  const res = await request(app).post('/api/auth/register').send({ name, email, password: 'segredo1' });
  return { token: res.body.token as string, id: res.body.user.id as string };
}
async function issue(body: Record<string, unknown>, projectKey = 'PRD') {
  const res = await request(app).post('/api/issues').set(as(owner)).send({ projectKey, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.issue as { id: string; key: string };
}
const get = (key: string) => request(app).get(`/api/issues/${key}`).set(as(owner)).then((r) => r.body.issue);
const list = (q: Record<string, string>) => request(app).get('/api/issues').query(q).set(as(owner)).then((r) => r.body.issues);

/** Reads one entry out of a zip produced by buildXlsx (stored entries are raw-deflated). */
function unzipEntry(buf: Buffer, name: string) {
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extra = buf.readUInt16LE(p + 28);
    const entry = buf.toString('utf8', p + 30, p + 30 + nameLen);
    const start = p + 30 + nameLen + extra;
    if (entry === name) return zlib.inflateRawSync(buf.subarray(start, start + size)).toString('utf8');
    p = start + size;
  }
  return null;
}

beforeAll(async () => {
  owner = await register('Paula Produtiva', 'paula@prd.dev');
  other = await register('Otto Outro', 'otto@prd.dev');
  await request(app).post('/api/projects').set(as(owner)).send({ key: 'PRD', name: 'Produtividade' });
  await request(app).post('/api/projects').set(as(owner)).send({ key: 'DST', name: 'Destino' });
  await request(app).post('/api/projects').set(as(other)).send({ key: 'OTR', name: 'Projeto do Otto' });
});

describe('durations', () => {
  it('parses and formats Jira-style durations', () => {
    expect(parseDuration('1w 2d 3h 30m')).toBe(2400 + 960 + 180 + 30);
    expect(parseDuration('1,5')).toBe(90);
    expect(parseDuration('2h30m')).toBe(150);
    expect(parseDuration('2x')).toBeNull();
    expect(formatDuration(2400 + 960 + 180 + 30)).toBe('1w 2d 3h 30m');
    expect(formatDuration(0)).toBe('0m');
  });
});

describe('blocked issues', () => {
  it('flags issues blocked by unfinished work, in lists and JQL', async () => {
    const api = await issue({ title: 'API pronta' });
    const tela = await issue({ title: 'Tela' });
    await request(app).post(`/api/issues/${api.key}/links`).set(as(owner)).send({ targetKey: tela.key, type: 'BLOCKS' });

    const blocked = (await list({ project: 'PRD' })).find((i: { key: string }) => i.key === tela.key);
    expect(blocked.blockedBy).toBe(1);
    expect((await list({ jql: 'project = PRD AND blocked = true' })).map((i: { key: string }) => i.key)).toEqual([tela.key]);

    // Finishing the blocker unblocks it.
    await request(app).patch(`/api/issues/${api.key}`).set(as(owner)).send({ status: 'DONE' });
    expect((await list({ jql: 'project = PRD AND blocked = true' }))).toEqual([]);
  });
});

describe('time tracking', () => {
  it('keeps original, spent and remaining estimates consistent', async () => {
    const i = await issue({ title: 'Estimada' });
    await request(app).patch(`/api/issues/${i.key}`).set(as(owner)).send({ originalEstimate: 8 * 60 });
    expect(await get(i.key)).toMatchObject({ originalEstimate: 480, remainingEstimate: 480, timeSpent: 0 });

    const log = await request(app).post(`/api/issues/${i.key}/worklogs`).set(as(owner)).send({ minutes: 150, description: 'Implementação' });
    expect(log.status).toBe(201);
    expect(await get(i.key)).toMatchObject({ timeSpent: 150, remainingEstimate: 330 });

    // Explicit remaining estimate.
    await request(app).post(`/api/issues/${i.key}/worklogs`).set(as(owner)).send({ minutes: 60, remaining: 120 });
    const after = await get(i.key);
    expect(after).toMatchObject({ timeSpent: 210, remainingEstimate: 120 });
    expect(after.workLogs).toHaveLength(2);
    expect(after.activities.filter((a: { field: string }) => a.field === 'worklog')).toHaveLength(2);

    // Editing and deleting give time back.
    await request(app).patch(`/api/worklogs/${log.body.workLog.id}`).set(as(owner)).send({ minutes: 90 });
    expect(await get(i.key)).toMatchObject({ timeSpent: 150, remainingEstimate: 180 });
    await request(app).delete(`/api/worklogs/${log.body.workLog.id}`).set(as(owner));
    expect(await get(i.key)).toMatchObject({ timeSpent: 60, remainingEstimate: 270 });

    expect((await list({ jql: 'project = PRD AND timeSpent >= 1h' })).map((x: { key: string }) => x.key)).toEqual([i.key]);
    const bad = await request(app).get('/api/issues').query({ jql: 'timeSpent > 2x' }).set(as(owner));
    expect(bad.status).toBe(400);
  });
});

describe('clone and move', () => {
  it('clones with subtasks, custom fields and a CLONES link', async () => {
    const field = (await request(app).post('/api/projects/PRD/fields').set(as(owner)).send({ name: 'Cliente', type: 'TEXT' })).body.field;
    const story = await issue({ title: 'Original', type: 'STORY', priority: 'HIGH', labels: ['x'], customFields: { [field.id]: 'ACME' } });
    await issue({ title: 'Sub A', type: 'SUBTASK', parentId: story.id });

    const res = await request(app).post(`/api/issues/${story.key}/clone`).set(as(owner)).send({});
    expect(res.status).toBe(201);
    const clone = await get(res.body.issue.key);
    expect(clone).toMatchObject({ title: 'CLONE - Original', priority: 'HIGH', labels: ['x'], status: 'TODO' });
    expect(clone.children.map((c: { title: string }) => c.title)).toEqual(['Sub A']);
    expect(clone.customValues).toEqual([{ fieldId: field.id, value: 'ACME' }]);
    expect(clone.links).toMatchObject([{ type: 'CLONES', direction: 'outward', issue: { key: story.key } }]);
  });

  it('moves an issue with its subtasks to another project, keeping the old key working', async () => {
    await request(app).post('/api/projects/DST/fields').set(as(owner)).send({ name: 'cliente', type: 'TEXT' });
    const src = (await request(app).get('/api/projects/PRD').set(as(owner))).body.project.customFields[0];
    const sprint = (await request(app).post('/api/projects/PRD/sprints').set(as(owner)).send({})).body.sprint;
    const story = await issue({ title: 'Mudar de casa', type: 'STORY', sprintId: sprint.id, customFields: { [src.id]: 'Beta' } });
    await request(app).patch(`/api/issues/${story.key}`).set(as(owner)).send({ status: 'IN_REVIEW' });
    const sub = await issue({ title: 'Sub', type: 'SUBTASK', parentId: story.id });

    const res = await request(app).post(`/api/issues/${story.key}/move`).set(as(owner)).send({ projectKey: 'DST' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.issue.key).toMatch(/^DST-\d+$/);

    const moved = await get(story.key); // old key resolves through the alias
    expect(moved).toMatchObject({ key: res.body.issue.key, status: 'IN_REVIEW', sprintId: null, project: { key: 'DST' } });
    expect(moved.customValues).toHaveLength(1);
    expect(moved.children[0].key).toMatch(/^DST-/);
    expect((await get(sub.key)).project.key).toBe('DST');
    expect(moved.activities.find((a: { field: string }) => a.field === 'project').toValue).toContain(res.body.issue.key);

    // Can't move into a project you're not a member of.
    const denied = await request(app).post(`/api/issues/${moved.key}/move`).set(as(owner)).send({ projectKey: 'OTR' });
    expect(denied.status).toBe(403);
  });
});

describe('bulk changes', () => {
  it('applies a change to many issues and reports failures one by one', async () => {
    const a = await issue({ title: 'Lote A', labels: ['velha'] });
    const b = await issue({ title: 'Lote B' });
    const res = await request(app).post('/api/issues/bulk').set(as(owner)).send({
      keys: [a.key, b.key, 'PRD-9999', 'OTR-1'],
      changes: { status: 'IN_PROGRESS', priority: 'HIGHEST', assigneeId: owner.id, addLabels: ['nova'], removeLabels: ['velha'] },
    });
    expect(res.body).toMatchObject({ updated: 2, failed: 2 });
    expect(await get(a.key)).toMatchObject({ status: 'IN_PROGRESS', priority: 'HIGHEST', assigneeId: owner.id, labels: ['nova'] });

    const del = await request(app).post('/api/issues/bulk').set(as(owner)).send({ keys: [a.key, b.key], delete: true });
    expect(del.body.updated).toBe(2);
    expect((await request(app).get(`/api/issues/${a.key}`).set(as(owner))).status).toBe(404);
  });
});

describe('export', () => {
  it('exports the same search as CSV and XLSX', async () => {
    await issue({ title: '=SOMA(1;2) perigoso', type: 'BUG', storyPoints: 3 });
    const csv = await request(app).get('/api/issues/export').query({ format: 'csv', jql: 'project = PRD AND type = Bug' }).set(as(owner));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const text: string = csv.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const [header, row] = text.slice(1).trim().split('\r\n');
    expect(header.split(',').slice(0, 4)).toEqual(['Chave', 'Resumo', 'Tipo', 'Status']);
    expect(row).toContain("'=SOMA(1;2) perigoso"); // formula injection neutralised
    expect(row).toContain('Bug');

    const xlsx = await request(app).get('/api/issues/export').query({ format: 'xlsx', jql: 'project = PRD AND type = Bug' })
      .set(as(owner)).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const buf = xlsx.body as Buffer;
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const sheet = unzipEntry(buf, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('=SOMA(1;2) perigoso');
    expect(sheet).toContain('<autoFilter');
    expect(unzipEntry(buf, '[Content_Types].xml')).toContain('spreadsheetml');
  });
});
