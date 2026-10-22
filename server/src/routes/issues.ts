import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, HttpError } from '../errors.js';
import { currentUser, userSelect } from '../auth.js';
import { assertMember, loadIssue, loadProject } from '../access.js';
import { issueListInclude, normalizeLabel, serializeIssue } from '../serialize.js';
import { publishProject } from '../events.js';
import { extractMentions, notify, plainText, watch } from '../notify.js';
import { removeFiles, serializeAttachment } from './attachments.js';
import { logSprintChanges } from '../sprintlog.js';
import { JqlError, compileJql, parseJql, sortByPriority } from '../jql.js';
import { addComment, createIssue, createSchema, updateIssue, updateSchema } from '../services/issues.js';

const commentSchema = z.object({ body: z.string().trim().min(1, 'O comentário está vazio') });

export const issuesRouter = Router();

function csv(value: unknown): string[] {
  return typeof value === 'string' && value ? value.split(',').map((v) => v.trim()).filter(Boolean) : [];
}

/** Basic filters (query-string) → Prisma conditions. JQL, when given, replaces them. */
function basicFilters(q: Record<string, unknown>, userId: string): Prisma.IssueWhereInput[] {
  const and: Prisma.IssueWhereInput[] = [];
  if (typeof q.project === 'string' && q.project) and.push({ project: { key: q.project.toUpperCase() } });

  const text = typeof q.q === 'string' ? q.q.trim() : '';
  if (text) {
    and.push({ OR: [{ title: { contains: text } }, { description: { contains: text } }, { key: text.toUpperCase() }] });
  }

  const statuses = csv(q.status);
  if (statuses.length) and.push({ status: { in: statuses } });
  const categories = csv(q.category);
  if (categories.length) and.push({ statusRef: { category: { in: categories } } });
  const types = csv(q.type);
  if (types.length) and.push({ type: { in: types } });
  const excludeTypes = csv(q.excludeType);
  if (excludeTypes.length) and.push({ type: { notIn: excludeTypes } });
  const priorities = csv(q.priority);
  if (priorities.length) and.push({ priority: { in: priorities } });

  const assignees = csv(q.assignee);
  if (assignees.length) {
    const ids = assignees.filter((a) => a !== 'unassigned').map((a) => (a === 'me' ? userId : a));
    const or: Prisma.IssueWhereInput[] = [];
    if (ids.length) or.push({ assigneeId: { in: ids } });
    if (assignees.includes('unassigned')) or.push({ assigneeId: null });
    and.push({ OR: or });
  }

  if (q.reporter === 'me') and.push({ reporterId: userId });

  const sprint = typeof q.sprint === 'string' ? q.sprint : '';
  if (sprint === 'backlog') and.push({ sprintId: null });
  else if (sprint === 'active') and.push({ sprint: { status: 'ACTIVE' } });
  else if (sprint === 'open') and.push({ OR: [{ sprintId: null }, { sprint: { status: { not: 'CLOSED' } } }] });
  else if (sprint) and.push({ sprintId: sprint });

  for (const label of csv(q.label)) and.push({ labels: { contains: `,${normalizeLabel(label)},` } });
  if (typeof q.parent === 'string' && q.parent) and.push({ parent: { key: q.parent.toUpperCase() } });
  return and;
}

issuesRouter.get(
  '/',
  ah(async (req, res) => {
    const user = currentUser(req);
    const q = req.query;
    const memberships = await prisma.projectMember.findMany({ where: { userId: user.id }, select: { projectId: true } });
    const projectIds = memberships.map((m) => m.projectId);
    const and: Prisma.IssueWhereInput[] = [{ projectId: { in: projectIds } }];
    const limit = Math.min(Number(q.limit) || 500, 1000);

    let orderBy: Prisma.IssueOrderByWithRelationInput[];
    let byPriority: 'asc' | 'desc' | undefined;
    if (typeof q.jql === 'string' && q.jql.trim()) {
      try {
        const compiled = await compileJql(parseJql(q.jql), { userId: user.id, projectIds });
        and.push(compiled.where);
        orderBy = compiled.orderBy.length ? compiled.orderBy : compiled.sortByPriority ? [{ rank: 'asc' }] : [{ updatedAt: 'desc' }];
        byPriority = compiled.sortByPriority;
      } catch (err) {
        if (err instanceof JqlError) {
          return res.status(400).json({ error: `Erro na consulta (posição ${err.position + 1}): ${err.message}`, position: err.position });
        }
        throw err;
      }
    } else {
      and.push(...basicFilters(q, user.id));
      const sort = typeof q.sort === 'string' ? q.sort : 'rank';
      orderBy =
        sort === 'created' ? [{ createdAt: 'desc' }]
        : sort === 'updated' ? [{ updatedAt: 'desc' }]
        : sort === 'key' ? [{ projectId: 'asc' }, { number: 'desc' }]
        : [{ rank: 'asc' }];
      if (sort === 'priority') byPriority = 'desc';
    }

    let issues = await prisma.issue.findMany({ where: { AND: and }, include: issueListInclude, orderBy, take: limit });
    if (byPriority) issues = sortByPriority(issues, byPriority);
    res.json({ issues: issues.map(serializeIssue) });
  }),
);

issuesRouter.post(
  '/',
  ah(async (req, res) => {
    const user = currentUser(req);
    const data = createSchema.parse(req.body);
    const { project } = await loadProject(data.projectKey, user.id);
    const issue = await createIssue(project, data, user);
    res.status(201).json({ issue: serializeIssue(issue) });
  }),
);

issuesRouter.get(
  '/:key',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { issue: base } = await loadIssue(req.params.key, user.id);
    const issue = await prisma.issue.findUniqueOrThrow({
      where: { id: base.id },
      include: {
        ...issueListInclude,
        children: {
          include: { assignee: { select: userSelect }, statusRef: { select: { key: true, name: true, category: true } } },
          orderBy: { rank: 'asc' },
        },
        comments: { include: { author: { select: userSelect } }, orderBy: { createdAt: 'asc' } },
        activities: { include: { user: { select: userSelect } }, orderBy: { createdAt: 'desc' }, take: 100 },
        attachments: { include: { uploader: { select: userSelect } }, orderBy: { createdAt: 'asc' } },
        watchers: { include: { user: { select: userSelect } }, orderBy: { createdAt: 'asc' } },
        linksOut: { include: { target: { include: { assignee: { select: userSelect }, statusRef: { select: { key: true, name: true, category: true } } } } }, orderBy: { createdAt: 'asc' } },
        linksIn: { include: { source: { include: { assignee: { select: userSelect }, statusRef: { select: { key: true, name: true, category: true } } } } }, orderBy: { createdAt: 'asc' } },
        customValues: { select: { fieldId: true, value: true } },
      },
    });
    const { linksOut, linksIn, watchers, attachments, ...rest } = issue;
    // Links are flattened so the client sees each one from this issue's point of view.
    const links = [
      ...linksOut.map((l) => ({ id: l.id, type: l.type, direction: 'outward' as const, issue: serializeIssue(l.target) })),
      ...linksIn.map((l) => ({ id: l.id, type: l.type, direction: 'inward' as const, issue: serializeIssue(l.source) })),
    ];
    res.json({
      issue: {
        ...serializeIssue(rest),
        children: rest.children.map(serializeIssue),
        attachments: attachments.map(serializeAttachment),
        watchers: watchers.map((w) => w.user),
        links,
      },
    });
  }),
);

issuesRouter.patch(
  '/:key',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { issue } = await loadIssue(req.params.key, user.id);
    const data = updateSchema.parse(req.body);
    const updated = await updateIssue(issue, data, user);
    res.json({ issue: serializeIssue(updated) });
  }),
);

issuesRouter.delete(
  '/:key',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { issue } = await loadIssue(req.params.key, user.id);
    const files = await prisma.attachment.findMany({
      where: { OR: [{ issueId: issue.id }, { issue: { parentId: issue.id, type: 'SUBTASK' } }] },
      select: { storageKey: true },
    });
    await logSprintChanges(prisma, issue, null);
    await prisma.$transaction([
      prisma.issue.deleteMany({ where: { parentId: issue.id, type: 'SUBTASK' } }),
      prisma.issue.delete({ where: { id: issue.id } }),
    ]);
    removeFiles(files.map((f) => f.storageKey));
    publishProject(issue.projectId);
    res.status(204).end();
  }),
);

issuesRouter.post(
  '/:key/comments',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { issue } = await loadIssue(req.params.key, user.id);
    const { body } = commentSchema.parse(req.body);
    const comment = await addComment(issue, body, user);
    res.status(201).json({ comment });
  }),
);

issuesRouter.post(
  '/:key/watch',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { issue } = await loadIssue(req.params.key, user.id);
    await watch(issue.id, [user.id]);
    res.json({ watching: true });
  }),
);

issuesRouter.delete(
  '/:key/watch',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { issue } = await loadIssue(req.params.key, user.id);
    await prisma.watcher.deleteMany({ where: { issueId: issue.id, userId: user.id } });
    res.json({ watching: false });
  }),
);

export const commentsRouter = Router();

async function loadComment(id: string, userId: string) {
  const comment = await prisma.comment.findUnique({ where: { id }, include: { issue: true } });
  if (!comment) throw new HttpError(404, 'Comentário não encontrado');
  const membership = await assertMember(comment.issue.projectId, userId);
  return { comment, membership };
}

commentsRouter.patch(
  '/:id',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { comment } = await loadComment(req.params.id, user.id);
    if (comment.authorId !== user.id) throw new HttpError(403, 'Você só pode editar seus próprios comentários');
    const { body } = commentSchema.parse(req.body);
    const updated = await prisma.comment.update({
      where: { id: comment.id },
      data: { body },
      include: { author: { select: userSelect } },
    });
    const before = extractMentions(comment.body);
    const added = [...extractMentions(body)].filter((id) => !before.has(id));
    await notify({ issue: comment.issue, actor: user, type: 'mentioned', userIds: added, detail: plainText(body) });
    publishProject(comment.issue.projectId);
    res.json({ comment: updated });
  }),
);

commentsRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { comment, membership } = await loadComment(req.params.id, user.id);
    if (comment.authorId !== user.id && membership.role !== 'ADMIN') {
      throw new HttpError(403, 'Você só pode excluir seus próprios comentários');
    }
    await prisma.comment.delete({ where: { id: comment.id } });
    publishProject(comment.issue.projectId);
    res.status(204).end();
  }),
);
