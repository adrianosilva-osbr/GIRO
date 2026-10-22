import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { outbox } from '../src/mailer.js';
import { plainText } from '../src/notify.js';

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

interface Account {
  token: string;
  user: { id: string; name: string };
}

async function register(name: string, email: string): Promise<Account> {
  const res = await request(app).post('/api/auth/register').send({ name, email, password: 'segredo1' });
  expect(res.status).toBe(201);
  return res.body;
}

async function createIssue(token: string, body: Record<string, unknown>) {
  const res = await request(app).post('/api/issues').set(auth(token)).send({ projectKey: 'COLAB', ...body });
  expect(res.status).toBe(201);
  return res.body.issue as { id: string; key: string };
}

const notificationsOf = async (token: string) =>
  (await request(app).get('/api/notifications').set(auth(token))).body as {
    unread: number;
    notifications: { type: string; detail: string; issue: { key: string }; read: boolean; id: string }[];
  };

let lia: Account;
let max: Account;
let zoe: Account;

beforeAll(async () => {
  lia = await register('Lia Admin', 'lia@colab.dev');
  max = await register('Max Membro', 'max@colab.dev');
  zoe = await register('Zoe Fora', 'zoe@colab.dev');
  await request(app).post('/api/projects').set(auth(lia.token)).send({ key: 'COLAB', name: 'Colaboração' });
  await request(app).post('/api/projects/COLAB/members').set(auth(lia.token)).send({ email: 'max@colab.dev' });
});

describe('notifications', () => {
  it('notifies the assignee, mentioned members and watchers — never the actor or outsiders', async () => {
    const issue = await createIssue(lia.token, {
      title: 'Revisar contrato',
      assigneeId: max.user.id,
      description: `Ver com @[Zoe Fora](${zoe.user.id})`, // Zoe is not a member: no notification
    });
    let maxN = await notificationsOf(max.token);
    expect(maxN.notifications.find((n) => n.issue.key === issue.key)?.type).toBe('assigned');
    expect((await notificationsOf(zoe.token)).notifications).toHaveLength(0);

    // Max comments mentioning Lia: Lia gets "mentioned" (not also "commented"); Max gets nothing for his own comment.
    const before = maxN.notifications.length;
    await request(app).post(`/api/issues/${issue.key}/comments`).set(auth(max.token))
      .send({ body: `Pode olhar, @[Lia Admin](${lia.user.id})?` });
    const liaN = await notificationsOf(lia.token);
    const forIssue = liaN.notifications.filter((n) => n.issue.key === issue.key);
    expect(forIssue.map((n) => n.type)).toEqual(['mentioned']);
    expect(forIssue[0].detail).toBe('Pode olhar, @Lia Admin?');
    maxN = await notificationsOf(max.token);
    expect(maxN.notifications.length).toBe(before);

    // Status change reaches watchers (reporter Lia + assignee Max), minus the actor.
    await request(app).patch(`/api/issues/${issue.key}`).set(auth(lia.token)).send({ status: 'IN_PROGRESS' });
    maxN = await notificationsOf(max.token);
    expect(maxN.notifications[0]).toMatchObject({ type: 'status', detail: 'Em andamento' });

    // E-mail goes out with a link to the issue.
    const mail = outbox.find((m) => m.to === 'max@colab.dev' && m.text.includes('mudou o status'));
    expect(mail?.text).toContain(`/?issue=${issue.key}`);
  });

  it('marks notifications as read and respects unwatching', async () => {
    const issue = await createIssue(lia.token, { title: 'Observável', assigneeId: max.user.id });
    expect((await notificationsOf(max.token)).unread).toBeGreaterThan(0);
    await request(app).post('/api/notifications/read').set(auth(max.token)).send({});
    expect((await notificationsOf(max.token)).unread).toBe(0);

    await request(app).delete(`/api/issues/${issue.key}/watch`).set(auth(max.token));
    await request(app).post(`/api/issues/${issue.key}/comments`).set(auth(lia.token)).send({ body: 'Atualização' });
    expect((await notificationsOf(max.token)).unread).toBe(0);

    const detail = await request(app).get(`/api/issues/${issue.key}`).set(auth(lia.token));
    expect(detail.body.issue.watchers.map((w: { id: string }) => w.id)).toEqual([lia.user.id]);
  });

  it('does not e-mail users who turned e-mails off', async () => {
    await request(app).patch('/api/auth/me').set(auth(max.token)).send({ emailNotifications: false });
    const sentBefore = outbox.filter((m) => m.to === 'max@colab.dev').length;
    await createIssue(lia.token, { title: 'Sem e-mail', assigneeId: max.user.id });
    expect(outbox.filter((m) => m.to === 'max@colab.dev').length).toBe(sentBefore);
    expect((await notificationsOf(max.token)).unread).toBe(1);
    await request(app).patch('/api/auth/me').set(auth(max.token)).send({ emailNotifications: true });
  });
});

describe('plainText', () => {
  it('strips Markdown for notification excerpts', () => {
    expect(plainText('Reproduzi no **Safari 17**. @[Bruno Lima](abc123) consegue?')).toBe('Reproduzi no Safari 17. @Bruno Lima consegue?');
    expect(plainText('- [ ] item _um_\n> citação com `code`')).toBe('item um citação com code');
    expect(plainText('Veja ![print](attachment:x1) e [o link](https://a.b)')).toBe('Veja [imagem: print] e o link');
    expect(plainText('snake_case_name fica')).toBe('snake_case_name fica');
  });
});

describe('attachments', () => {
  it('uploads, serves through a signed URL only, and deletes', async () => {
    const issue = await createIssue(lia.token, { title: 'Com anexo' });
    const up = await request(app)
      .post(`/api/issues/${issue.key}/attachments`)
      .set(auth(lia.token))
      .attach('files', Buffer.from('conteúdo de teste'), { filename: 'relatório.txt', contentType: 'text/plain' })
      .attach('files', Buffer.from('<script>alert(1)</script>'), { filename: 'x.html', contentType: 'text/html' });
    expect(up.status).toBe(201);
    const [txt, html] = up.body.attachments;
    expect(txt.filename).toBe('relatório.txt');
    expect(txt).not.toHaveProperty('storageKey');

    const ok = await request(app).get(txt.url);
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('conteúdo de teste');
    expect(ok.headers['content-disposition']).toMatch(/^inline/);

    // HTML is never rendered inline.
    const dl = await request(app).get(html.url);
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    expect(dl.headers['content-type']).toBe('application/octet-stream');

    // Flip the first signature character (always to a different one).
    const tampered = txt.url.replace(/sig=(\w)/, (_m: string, ch: string) => `sig=${ch === '0' ? '1' : '0'}`);
    expect((await request(app).get(tampered)).status).toBe(403);
    expect((await request(app).get(`/api/attachments/${txt.id}/file`)).status).toBe(403);

    // Outsiders cannot upload.
    const denied = await request(app).post(`/api/issues/${issue.key}/attachments`).set(auth(zoe.token))
      .attach('files', Buffer.from('x'), 'x.txt');
    expect(denied.status).toBe(403);

    const del = await request(app).delete(`/api/attachments/${txt.id}`).set(auth(lia.token));
    expect(del.status).toBe(204);
    const detail = await request(app).get(`/api/issues/${issue.key}`).set(auth(lia.token));
    expect(detail.body.issue.attachments.map((a: { id: string }) => a.id)).toEqual([html.id]);
  });
});

describe('issue links', () => {
  it('shows a link from both sides and rejects duplicates', async () => {
    const a = await createIssue(lia.token, { title: 'API' });
    const b = await createIssue(lia.token, { title: 'Tela' });
    const link = await request(app).post(`/api/issues/${a.key}/links`).set(auth(lia.token))
      .send({ targetKey: b.key, type: 'BLOCKS' });
    expect(link.status).toBe(201);

    const fromB = await request(app).get(`/api/issues/${b.key}`).set(auth(lia.token));
    expect(fromB.body.issue.links).toMatchObject([{ type: 'BLOCKS', direction: 'inward', issue: { key: a.key } }]);

    const dup = await request(app).post(`/api/issues/${b.key}/links`).set(auth(lia.token))
      .send({ targetKey: a.key, type: 'BLOCKS', direction: 'inward' });
    expect(dup.status).toBe(409);
    const self = await request(app).post(`/api/issues/${a.key}/links`).set(auth(lia.token)).send({ targetKey: a.key, type: 'RELATES' });
    expect(self.status).toBe(400);

    await request(app).delete(`/api/links/${link.body.link.id}`).set(auth(lia.token));
    const after = await request(app).get(`/api/issues/${a.key}`).set(auth(lia.token));
    expect(after.body.issue.links).toEqual([]);
  });
});

describe('passwords', () => {
  it('resets a forgotten password through the e-mailed link, once', async () => {
    const acct = await register('Esquecido', 'esq@colab.dev');
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'ninguem@colab.dev' });
    expect(unknown.body).toEqual({ ok: true });

    await request(app).post('/api/auth/forgot-password').send({ email: 'ESQ@colab.dev' });
    const mail = outbox.filter((m) => m.to === 'esq@colab.dev').pop();
    const token = mail?.text.match(/reset-password\?token=([a-f0-9]+)/)?.[1];
    expect(token).toBeTruthy();

    const reset = await request(app).post('/api/auth/reset-password').send({ token, password: 'novaSenha1' });
    expect(reset.status).toBe(200);
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: 'outra123' })).status).toBe(400);

    // Old sessions stop working; the new password logs in.
    expect((await request(app).get('/api/auth/me').set(auth(acct.token))).status).toBe(401);
    const login = await request(app).post('/api/auth/login').send({ email: 'esq@colab.dev', password: 'novaSenha1' });
    expect(login.status).toBe(200);
  });

  it('changes the password with the current one and returns a fresh token', async () => {
    const acct = await register('Troca', 'troca@colab.dev');
    const wrong = await request(app).post('/api/auth/change-password').set(auth(acct.token))
      .send({ currentPassword: 'errada', newPassword: 'nova1234' });
    expect(wrong.status).toBe(400);
    const ok = await request(app).post('/api/auth/change-password').set(auth(acct.token))
      .send({ currentPassword: 'segredo1', newPassword: 'nova1234' });
    expect(ok.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(auth(ok.body.token))).status).toBe(200);
  });
});

describe('live events', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  async function nextEvents(token: string, trigger: () => Promise<unknown>) {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: auth(token), signal: ctrl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ": connected"
    await trigger();
    const events: unknown[] = [];
    const deadline = Date.now() + 1500;
    let buffer = '';
    while (Date.now() < deadline && events.length < 2) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), 300)),
      ]);
      if (!chunk || chunk.done) continue;
      buffer += decoder.decode(chunk.value);
      for (const m of buffer.matchAll(/data: (.+)\n\n/g)) events.push(JSON.parse(m[1]));
      buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
    }
    ctrl.abort();
    return events;
  }

  it('pushes project changes to members and nothing to outsiders', async () => {
    const forMax = await nextEvents(max.token, () => createIssue(lia.token, { title: 'Ao vivo', assigneeId: max.user.id }));
    expect(forMax).toEqual(expect.arrayContaining([{ type: 'notifications' }, expect.objectContaining({ type: 'project' })]));

    const forZoe = await nextEvents(zoe.token, () => createIssue(lia.token, { title: 'Privada' }));
    expect(forZoe).toEqual([]);
  });
});
