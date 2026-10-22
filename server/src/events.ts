import type { Request, Response } from 'express';
import { prisma } from './db.js';
import { currentUser } from './auth.js';

/**
 * Live updates over Server-Sent Events. Clients only learn *that* something changed
 * (a project or their notifications) and refetch through the normal, authorized API.
 * Connections live in this process's memory, so this assumes a single server instance.
 */
interface Client {
  userId: string;
  res: Response;
  projectIds: Set<string>;
}

export type LiveEvent = { type: 'project'; projectId: string } | { type: 'notifications' };

const clients = new Set<Client>();

async function memberProjectIds(userId: string) {
  const rows = await prisma.projectMember.findMany({ where: { userId }, select: { projectId: true } });
  return new Set(rows.map((r) => r.projectId));
}

export async function eventsHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const client: Client = { userId: user.id, res, projectIds: await memberProjectIds(user.id) };
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  clients.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

function send(client: Client, event: LiveEvent) {
  client.res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function publishProject(...projectIds: string[]) {
  for (const projectId of new Set(projectIds)) {
    for (const c of clients) if (c.projectIds.has(projectId)) send(c, { type: 'project', projectId });
  }
}

export function publishUser(userId: string) {
  for (const c of clients) if (c.userId === userId) send(c, { type: 'notifications' });
}

/** Call after someone joins or leaves a project so their open connections get the right events. */
export async function refreshMemberships(userId: string) {
  const ids = await memberProjectIds(userId);
  for (const c of clients) if (c.userId === userId) c.projectIds = ids;
}
