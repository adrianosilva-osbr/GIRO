import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { parseJql, JqlError } from '../src/jql.js';

const app = createApp();
let admin = { token: '', id: '' };
let member = { token: '', id: '' };
const as = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });

async function register(name: string, email: string) {
  const res = await request(app).post('/api/auth/register').send({ name, email, password: 'segredo1' });
  return { token: res.body.token as string, id: res.body.user.id as string };
}
async function issue(body: Record<string, unknown>, user = admin) {
  const res = await request(app).post('/api/issues').set(as(user)).send({ projectKey: 'CFG', ...body });
  expect(res.status).toBe(201);
  return res.body.issue as { id: string; key: string; status: string; statusRef: { name: string; category: string } };
}
const get = (key: string, user = admin) => request(app).get(`/api/issues/${key}`).set(as(user)).then((r) => r.body.issue);
const project = () => request(app).get('/api/projects/CFG').set(as(admin)).then((r) => r.body.project);
const jql = (q: string, user = admin) => request(app).get('/api/issues').query({ jql: q }).set(as(user));

beforeAll(async () => {
  admin = await register('Alice Admin', 'alice@cfg.dev');
  member = await register('Marcos Membro', 'marcos@cfg.dev');
  await request(app).post('/api/projects').set(as(admin)).send({ key: 'CFG', name: 'Configuração' });
  await request(app).post('/api/projects/CFG/members').set(as(admin)).send({ email: 'marcos@cfg.dev' });
});

describe('workflow', () => {
  it('starts with the default columns and lets admins add, rename, reorder and delete', async () => {
    const p = await project();
    expect(p.statuses.map((s: { key: string }) => s.key)).toEqual(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE']);

    const denied = await request(app).post('/api/projects/CFG/statuses').set(as(member)).send({ name: 'QA', category: 'IN_PROGRESS' });
    expect(denied.status).toBe(403);

    const qa = (await request(app).post('/api/projects/CFG/statuses').set(as(admin)).send({ name: 'Em validação', category: 'IN_PROGRESS' })).body.status;
    expect(qa.key).toBe('EM_VALIDACAO');
    const ids = (await project()).statuses.map((s: { id: string }) => s.id);
    const reordered = [ids[0], ids[1], ids[4], ids[2], ids[3]];
    const order = await request(app).put('/api/projects/CFG/statuses/order').set(as(admin)).send({ ids: reordered });
    expect(order.body.statuses.map((s: { key: string }) => s.key)).toEqual(['TODO', 'IN_PROGRESS', 'EM_VALIDACAO', 'IN_REVIEW', 'DONE']);

    // Issues reference the key, so renaming is free.
    const i = await issue({ title: 'Validar', status: 'EM_VALIDACAO' });
    await request(app).patch(`/api/projects/CFG/statuses/${qa.id}`).set(as(admin)).send({ name: 'Homologação', wipLimit: 2 });
    expect((await get(i.key)).statusRef.name).toBe('Homologação');

    // Deleting a status in use requires a destination.
    const blocked = await request(app).delete(`/api/projects/CFG/statuses/${qa.id}`).set(as(admin));
    expect(blocked.status).toBe(400);
    const moved = await request(app).delete(`/api/projects/CFG/statuses/${qa.id}?moveTo=DONE`).set(as(admin));
    expect(moved.status).toBe(204);
    const after = await get(i.key);
    expect(after.status).toBe('DONE');
    expect(after.resolvedAt).toBeTruthy();
  });

  it('treats any status in the DONE category as done', async () => {
    const shipped = (await request(app).post('/api/projects/CFG/statuses').set(as(admin)).send({ name: 'Publicado', category: 'DONE' })).body.status;
    const i = await issue({ title: 'Publicar' });
    const res = await request(app).patch(`/api/issues/${i.key}`).set(as(admin)).send({ status: shipped.key });
    expect(res.body.issue.resolvedAt).toBeTruthy();
    expect(res.body.issue.statusRef.category).toBe('DONE');
    const bad = await request(app).patch(`/api/issues/${i.key}`).set(as(admin)).send({ status: 'NAO_EXISTE' });
    expect(bad.status).toBe(400);
  });
});

describe('custom fields', () => {
  it('validates values by type and records history', async () => {
    const env = (await request(app).post('/api/projects/CFG/fields').set(as(admin))
      .send({ name: 'Ambiente', type: 'SELECT', options: ['Produção', 'Homologação'] })).body.field;
    const hours = (await request(app).post('/api/projects/CFG/fields').set(as(admin)).send({ name: 'Horas', type: 'NUMBER' })).body.field;
    const i = await issue({ title: 'Com campos' });

    const bad = await request(app).patch(`/api/issues/${i.key}`).set(as(admin)).send({ customFields: { [env.id]: 'Teste' } });
    expect(bad.status).toBe(400);
    const ok = await request(app).patch(`/api/issues/${i.key}`).set(as(admin)).send({ customFields: { [env.id]: 'Produção', [hours.id]: '2,5' } });
    expect(ok.status).toBe(200);

    const detail = await get(i.key);
    const values = Object.fromEntries(detail.customValues.map((v: { fieldId: string; value: string }) => [v.fieldId, v.value]));
    expect(values).toEqual({ [env.id]: 'Produção', [hours.id]: '2.5' });
    expect(detail.activities.map((a: { field: string }) => a.field)).toEqual(expect.arrayContaining(['custom:Ambiente', 'custom:Horas']));

    // In use: the option can't be removed.
    const remove = await request(app).patch(`/api/projects/CFG/fields/${env.id}`).set(as(admin)).send({ options: ['Homologação'] });
    expect(remove.status).toBe(400);

    // Clearing a value.
    await request(app).patch(`/api/issues/${i.key}`).set(as(admin)).send({ customFields: { [hours.id]: null } });
    expect((await get(i.key)).customValues).toHaveLength(1);
  });
});

describe('JQL', () => {
  it('parses precedence, lists, EMPTY and ORDER BY, and reports positions on errors', () => {
    const p = parseJql('a = 1 OR b = 2 AND NOT c IN (x, "y z") ORDER BY created DESC, key');
    expect(p.where).toMatchObject({ kind: 'or', items: [{ kind: 'clause' }, { kind: 'and' }] });
    expect(p.orderBy).toEqual([
      { field: 'created', dir: 'desc', pos: expect.any(Number) },
      { field: 'key', dir: 'asc', pos: expect.any(Number) },
    ]);
    expect(parseJql('labels IS EMPTY').where).toMatchObject({ op: 'is empty' });
    expect(() => parseJql('status = ')).toThrow(JqlError);
    try {
      parseJql('status = A status = B');
    } catch (e) {
      expect((e as JqlError).position).toBe(11);
    }
  });

  it('filters issues across fields, names and functions', async () => {
    const env = (await project()).customFields.find((f: { name: string }) => f.name === 'Ambiente');
    const bug = await issue({ title: 'Erro no login', type: 'BUG', priority: 'HIGHEST', assigneeId: member.id, labels: ['auth'], storyPoints: 3 });
    await request(app).patch(`/api/issues/${bug.key}`).set(as(admin)).send({ status: 'IN_PROGRESS', customFields: { [env.id]: 'Homologação' } });
    await issue({ title: 'Tarefa qualquer', type: 'TASK', priority: 'LOW' });

    const keys = async (q: string, user = admin) => {
      const res = await jql(q, user);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body.issues.map((i: { key: string }) => i.key);
    };
    expect(await keys('type = Bug AND status = "Em andamento"')).toEqual([bug.key]);
    expect(await keys('tipo = bug AND prioridade >= alta')).toEqual([bug.key]);
    expect(await keys('assignee = currentUser()', member)).toEqual([bug.key]);
    expect(await keys('assignee = "marcos@cfg.dev" AND labels IN (auth) AND storyPoints > 2')).toEqual([bug.key]);
    expect(await keys('Ambiente = Homologação')).toEqual([bug.key]);
    expect(await keys('text ~ "login" AND created >= -1d AND statusCategory != Done')).toEqual([bug.key]);
    expect(await keys(`project = CFG AND key = ${bug.key}`)).toEqual([bug.key]);
    const sorted = await keys('project = CFG ORDER BY priority DESC');
    expect(sorted[0]).toBe(bug.key);

    const err = await jql('status = Inexistente');
    expect(err.status).toBe(400);
    expect(err.body.error).toMatch(/Status desconhecido/);
  });

  it('never returns issues from projects the viewer is not in', async () => {
    const outsider = await register('Olga', 'olga@cfg.dev');
    expect((await jql('type = Bug', outsider)).body.issues).toEqual([]);
  });
});

describe('saved filters', () => {
  it('stores personal and shared filters; only owners edit', async () => {
    const mine = await request(app).post('/api/filters').set(as(admin)).send({ name: 'Meus bugs', jql: 'type = Bug' });
    const shared = await request(app).post('/api/filters').set(as(admin)).send({ name: 'Time', jql: 'statusCategory != Done', shared: true });
    expect(mine.status).toBe(201);
    const invalid = await request(app).post('/api/filters').set(as(admin)).send({ name: 'Ruim', jql: 'status = (' });
    expect(invalid.status).toBe(400);

    const seen = (await request(app).get('/api/filters').set(as(member))).body.filters.map((f: { id: string }) => f.id);
    expect(seen).toContain(shared.body.filter.id);
    expect(seen).not.toContain(mine.body.filter.id);
    expect((await request(app).delete(`/api/filters/${shared.body.filter.id}`).set(as(member))).status).toBe(403);
  });
});

describe('automation', () => {
  it('closes the parent when every subtask is done, and records the run', async () => {
    const rule = await request(app).post('/api/projects/CFG/automations').set(as(admin)).send({
      name: 'Fechar pai',
      trigger: 'subtasks_done',
      actions: [
        { type: 'set_status', value: 'DONE' },
        { type: 'add_comment', value: 'Todas as subtarefas de {{key}} foram concluídas.' },
      ],
    });
    expect(rule.status).toBe(201);
    const story = await issue({ title: 'História com subtarefas', type: 'STORY' });
    const s1 = await issue({ title: 'Sub 1', type: 'SUBTASK', parentId: story.id });
    const s2 = await issue({ title: 'Sub 2', type: 'SUBTASK', parentId: story.id });

    await request(app).patch(`/api/issues/${s1.key}`).set(as(admin)).send({ status: 'DONE' });
    expect((await get(story.key)).status).toBe('TODO');
    await request(app).patch(`/api/issues/${s2.key}`).set(as(admin)).send({ status: 'DONE' });

    const parent = await get(story.key);
    expect(parent.status).toBe('DONE');
    expect(parent.comments[0]).toMatchObject({ body: `Todas as subtarefas de ${story.key} foram concluídas.`, author: { name: 'Automação' } });
    expect(parent.activities.find((a: { field: string }) => a.field === 'status').user.name).toBe('Automação');

    const rules = (await request(app).get('/api/projects/CFG/automations').set(as(member))).body.rules;
    expect(rules[0]).toMatchObject({ runCount: 1, runs: [{ success: true, issueKey: story.key }] });
    await request(app).delete(`/api/projects/CFG/automations/${rule.body.rule.id}`).set(as(admin));
  });

  it('honours JQL conditions and stops rule loops', async () => {
    // Bugs created are raised to HIGH priority and assigned to their reporter.
    await request(app).post('/api/projects/CFG/automations').set(as(admin)).send({
      name: 'Bugs urgentes', trigger: 'issue_created', condition: 'type = Bug',
      actions: [{ type: 'set_priority', value: 'HIGH' }, { type: 'assign', value: 'reporter' }],
    });
    const bug = await issue({ title: 'Bug novo', type: 'BUG', priority: 'LOW' }, member);
    const task = await issue({ title: 'Tarefa nova', priority: 'LOW' });
    expect(await get(bug.key)).toMatchObject({ priority: 'HIGH', assigneeId: member.id });
    expect((await get(task.key)).priority).toBe('LOW');

    // Two rules that bounce an issue between statuses must not loop forever.
    for (const [from, to] of [['IN_PROGRESS', 'IN_REVIEW'], ['IN_REVIEW', 'IN_PROGRESS']]) {
      await request(app).post('/api/projects/CFG/automations').set(as(admin))
        .send({ name: `${from}->${to}`, trigger: 'status_changed', triggerValue: from, actions: [{ type: 'set_status', value: to }] });
    }
    const res = await request(app).patch(`/api/issues/${task.key}`).set(as(admin)).send({ status: 'IN_PROGRESS' });
    expect(res.status).toBe(200);
    expect(['IN_PROGRESS', 'IN_REVIEW']).toContain((await get(task.key)).status);

    const invalid = await request(app).post('/api/projects/CFG/automations').set(as(admin))
      .send({ name: 'Ruim', trigger: 'issue_created', condition: 'tipo = (', actions: [{ type: 'set_priority', value: 'LOW' }] });
    expect(invalid.status).toBe(400);
  });

  it('keeps the automation account out of user lists and login', async () => {
    const users = (await request(app).get('/api/users').set(as(admin))).body.users;
    expect(users.find((u: { name: string }) => u.name === 'Automação')).toBeUndefined();
    const login = await request(app).post('/api/auth/login').send({ email: 'automacao@giro.system', password: '' });
    expect(login.status).toBe(401);
  });
});
