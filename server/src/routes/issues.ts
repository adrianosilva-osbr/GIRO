import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, HttpError } from '../errors.js';
import { currentUser, userSelect } from '../auth.js';
import { assertMember, loadIssue, loadProject } from '../access.js';
import { encodeLabels, issueListInclude, normalizeLabel, serializeIssue } from '../serialize.js';

export const ISSUE_TYPES = ['EPIC', 'STORY', 'TASK', 'BUG', 'SUBTASK'] as const;
export const STATUSES = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'] as const;
export const PRIORITIES = ['HIGHEST', 'HIGH', 'MEDIUM', 'LOW', 'LOWEST'] as const;

const nullableId = z.string().min(1).nullable();

const createSchema = z.object({
  projectKey: z.string(),
  title: z.string().trim().min(1, 'Informe um resumo'),
  description: z.string().optional().default(''),
  type: z.enum(ISSUE_TYPES).default('TASK'),
  status: z.enum(STATUSES).default('TODO'),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  storyPoints: z.number().int().min(0).max(1000).nullable().optional(),
  labels: z.array(z.string()).optional().default([]),
  dueDate: z.coerce.date().nullable().optional(),
  assigneeId: nullableId.optional(),
  sprintId: nullableId.optional(),
  parentId: nullableId.optional(),
});

const updateSchema = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  type: z.enum(ISSUE_TYPES).optional(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  storyPoints: z.number().int().min(0).max(1000).nullable().optional(),
  labels: z.array(z.string()).optional(),
  dueDate: z.coerce.date().nullable().optional(),
  assigneeId: nullableId.optional(),
  sprintId: nullableId.optional(),
  parentId: nullableId.optional(),
  rank: z.number().finite().optional(),
});

const commentSchema = z.object({ body: z.string().trim().min(1, 'O comentário está vazio') });

export const issuesRouter = Router();

async function validateParent(projectId: string, type: string, parentId: string | null | undefined) {
  if (type === 'SUBTASK') {
    if (!parentId) throw new HttpError(400, 'Subtarefas precisam de uma issue pai');
  } else if (type === 'EPIC') {
    if (parentId) throw new HttpError(400, 'Épicos não podem ter issue pai');
    return null;
  }
  if (!parentId) return null;
  const parent = await prisma.issue.findUnique({ where: { id: parentId } });
  if (!parent || parent.projectId !== projectId) throw new HttpError(400, 'Issue pai inválida');
  if (type === 'SUBTASK' && (parent.type === 'SUBTASK' || parent.type === 'EPIC')) {
    throw new HttpError(400, 'Subtarefas só podem ficar dentro de histórias, tarefas ou bugs');
  }
  if (type !== 'SUBTASK' && parent.type !== 'EPIC') {
    throw new HttpError(400, 'Histórias, tarefas e bugs só podem ser vinculados a um épico');
  }
  return parent;
}

async function validateSprint(projectId: string, sprintId: string | null | undefined) {
  if (!sprintId) return null;
  const sprint = await prisma.sprint.findUnique({ where: { id: sprintId } });
  if (!sprint || sprint.projectId !== projectId) throw new HttpError(400, 'Sprint inválida');
  if (sprint.status === 'CLOSED') throw new HttpError(400, 'Não é possível mover issues para uma sprint encerrada');
  return sprint;
}

async function validateAssignee(projectId: string, assigneeId: string | null | undefined) {
  if (!assigneeId) return null;
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: assigneeId } },
    include: { user: true },
  });
  if (!member) throw new HttpError(400, 'O responsável precisa ser membro do projeto');
  return member.user;
}

function csv(value: unknown): string[] {
  return typeof value === 'string' && value ? value.split(',').map((v) => v.trim()).filter(Boolean) : [];
}

const PRIORITY_ORDER: Record<string, number> = { HIGHEST: 0, HIGH: 1, MEDIUM: 2, LOW: 3, LOWEST: 4 };

issuesRouter.get(
  '/',
  ah(async (req, res) => {
    const user = currentUser(req);
    const q = req.query;
    const and: Prisma.IssueWhereInput[] = [{ project: { members: { some: { userId: user.id } } } }];

    if (typeof q.project === 'string' && q.project) and.push({ project: { key: q.project.toUpperCase() } });

    const text = typeof q.q === 'string' ? q.q.trim() : '';
    if (text) {
      and.push({
        OR: [{ title: { contains: text } }, { description: { contains: text } }, { key: text.toUpperCase() }],
      });
    }

    const statuses = csv(q.status);
    if (statuses.length) and.push({ status: { in: statuses } });
    const types = csv(q.type);
    if (types.length) and.push({ type: { in: types } });
    const excludeTypes = csv(q.excludeType);
    if (excludeTypes.length) and.push({ type: { notIn: excludeTypes } });
    const priorities = csv(q.priority);
    if (priorities.length) and.push({ priority: { in: priorities } });

    const assignees = csv(q.assignee);
    if (assignees.length) {
      const ids = assignees.filter((a) => a !== 'unassigned').map((a) => (a === 'me' ? user.id : a));
      const or: Prisma.IssueWhereInput[] = [];
      if (ids.length) or.push({ assigneeId: { in: ids } });
      if (assignees.includes('unassigned')) or.push({ assigneeId: null });
      and.push({ OR: or });
    }

    if (q.reporter === 'me') and.push({ reporterId: user.id });

    const sprint = typeof q.sprint === 'string' ? q.sprint : '';
    if (sprint === 'backlog') and.push({ sprintId: null });
    else if (sprint === 'active') and.push({ sprint: { status: 'ACTIVE' } });
    else if (sprint === 'open') and.push({ OR: [{ sprintId: null }, { sprint: { status: { not: 'CLOSED' } } }] });
    else if (sprint) and.push({ sprintId: sprint });

    for (const label of csv(q.label)) and.push({ labels: { contains: `,${normalizeLabel(label)},` } });

    if (typeof q.parent === 'string' && q.parent) and.push({ parent: { key: q.parent.toUpperCase() } });

    const sort = typeof q.sort === 'string' ? q.sort : 'rank';
    const orderBy: Prisma.IssueOrderByWithRelationInput[] =
      sort === 'created'
        ? [{ createdAt: 'desc' }]
        : sort === 'updated'
          ? [{ updatedAt: 'desc' }]
          : sort === 'key'
            ? [{ projectId: 'asc' }, { number: 'desc' }]
            : [{ rank: 'asc' }];

    const limit = Math.min(Number(q.limit) || 500, 1000);
    let issues = await prisma.issue.findMany({ where: { AND: and }, include: issueListInclude, orderBy, take: limit });
    if (sort === 'priority') {
      issues = issues.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.rank - b.rank);
    }
    res.json({ issues: issues.map(serializeIssue) });
  }),
);

issuesRouter.post(
  '/',
  ah(async (req, res) => {
    const user = currentUser(req);
    const data = createSchema.parse(req.body);
    const { project } = await loadProject(data.projectKey, user.id);
    const parent = await validateParent(project.id, data.type, data.parentId);
    await validateAssignee(project.id, data.assigneeId);
    // Subtasks always live in the same sprint as their parent, like in Jira.
    const sprintId = data.type === 'SUBTASK' ? (parent?.sprintId ?? null) : (data.sprintId ?? null);
    if (data.type !== 'SUBTASK') await validateSprint(project.id, sprintId);

    const issue = await prisma.$transaction(async (tx) => {
      const { issueCounter } = await tx.project.update({
        where: { id: project.id },
        data: { issueCounter: { increment: 1 } },
      });
      const max = await tx.issue.aggregate({ where: { projectId: project.id }, _max: { rank: true } });
      const created = await tx.issue.create({
        data: {
          projectId: project.id,
          number: issueCounter,
          key: `${project.key}-${issueCounter}`,
          title: data.title,
          description: data.description,
          type: data.type,
          status: data.status,
          priority: data.priority,
          storyPoints: data.storyPoints ?? null,
          labels: encodeLabels(data.labels),
          dueDate: data.dueDate ?? null,
          assigneeId: data.assigneeId ?? null,
          reporterId: user.id,
          sprintId,
          parentId: data.parentId ?? null,
          rank: (max._max.rank ?? 0) + 1,
        },
        include: issueListInclude,
      });
      await tx.activity.create({ data: { issueId: created.id, userId: user.id, action: 'created' } });
      return created;
    });
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
        children: { include: { assignee: { select: userSelect } }, orderBy: { rank: 'asc' } },
        comments: { include: { author: { select: userSelect } }, orderBy: { createdAt: 'asc' } },
        activities: { include: { user: { select: userSelect } }, orderBy: { createdAt: 'desc' }, take: 100 },
      },
    });
    res.json({ issue: { ...serializeIssue(issue), children: issue.children.map(serializeIssue) } });
  }),
);

type Change = { field: string; fromValue: string | null; toValue: string | null };

function fmtDate(d: Date | null | undefined) {
  return d ? d.toISOString().slice(0, 10) : null;
}

issuesRouter.patch(
  '/:key',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { issue } = await loadIssue(req.params.key, user.id);
    const data = updateSchema.parse(req.body);
    const update: Prisma.IssueUncheckedUpdateInput = {};
    const changes: Change[] = [];
    const track = (field: string, from: string | null | undefined, to: string | null | undefined) => {
      if ((from ?? null) !== (to ?? null)) changes.push({ field, fromValue: from ?? null, toValue: to ?? null });
    };

    const nextType = data.type ?? issue.type;
    if (data.type && data.type !== issue.type) {
      if (data.type === 'SUBTASK' || issue.type === 'SUBTASK') {
        throw new HttpError(400, 'Não é possível converter de/para subtarefa');
      }
      if (data.type === 'EPIC' && issue.parentId && data.parentId !== null) {
        throw new HttpError(400, 'Remova o épico pai antes de transformar esta issue em épico');
      }
      if (issue.type === 'EPIC') {
        const children = await prisma.issue.count({ where: { parentId: issue.id } });
        if (children) throw new HttpError(400, 'Este épico tem issues vinculadas; desvincule-as primeiro');
      }
      update.type = data.type;
      track('type', issue.type, data.type);
    }

    for (const field of ['title', 'status', 'priority'] as const) {
      if (data[field] !== undefined && data[field] !== issue[field]) {
        update[field] = data[field];
        track(field, issue[field], data[field]);
      }
    }
    if (data.description !== undefined && data.description !== issue.description) {
      update.description = data.description;
      changes.push({ field: 'description', fromValue: null, toValue: null });
    }
    if (data.storyPoints !== undefined && data.storyPoints !== issue.storyPoints) {
      update.storyPoints = data.storyPoints;
      track('storyPoints', issue.storyPoints?.toString(), data.storyPoints?.toString());
    }
    if (data.labels !== undefined) {
      const encoded = encodeLabels(data.labels);
      if (encoded !== issue.labels) {
        update.labels = encoded;
        track('labels', issue.labels.replace(/^,|,$/g, ''), encoded.replace(/^,|,$/g, ''));
      }
    }
    if (data.dueDate !== undefined && fmtDate(data.dueDate) !== fmtDate(issue.dueDate)) {
      update.dueDate = data.dueDate;
      track('dueDate', fmtDate(issue.dueDate), fmtDate(data.dueDate));
    }
    if (data.assigneeId !== undefined && data.assigneeId !== issue.assigneeId) {
      const [from, to] = await Promise.all([
        issue.assigneeId ? prisma.user.findUnique({ where: { id: issue.assigneeId } }) : null,
        validateAssignee(issue.projectId, data.assigneeId),
      ]);
      update.assigneeId = data.assigneeId;
      track('assignee', from?.name, to?.name);
    }
    if (data.parentId !== undefined && data.parentId !== issue.parentId) {
      if (data.parentId === issue.id) throw new HttpError(400, 'Uma issue não pode ser pai de si mesma');
      const [from, to] = await Promise.all([
        issue.parentId ? prisma.issue.findUnique({ where: { id: issue.parentId } }) : null,
        validateParent(issue.projectId, nextType, data.parentId),
      ]);
      update.parentId = data.parentId;
      track('parent', from?.key, to?.key);
      if (nextType === 'SUBTASK' && to) update.sprintId = to.sprintId;
    }
    let sprintChanged = false;
    if (data.sprintId !== undefined && data.sprintId !== issue.sprintId) {
      if (nextType === 'SUBTASK') throw new HttpError(400, 'Subtarefas seguem a sprint da issue pai');
      const [from, to] = await Promise.all([
        issue.sprintId ? prisma.sprint.findUnique({ where: { id: issue.sprintId } }) : null,
        validateSprint(issue.projectId, data.sprintId),
      ]);
      update.sprintId = data.sprintId;
      sprintChanged = true;
      track('sprint', from?.name, to?.name);
    }
    if (data.rank !== undefined) update.rank = data.rank;

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.issue.update({ where: { id: issue.id }, data: update, include: issueListInclude });
      if (sprintChanged) {
        await tx.issue.updateMany({
          where: { parentId: issue.id, type: 'SUBTASK' },
          data: { sprintId: data.sprintId ?? null },
        });
      }
      if (changes.length) {
        await tx.activity.createMany({
          data: changes.map((c) => ({ ...c, issueId: issue.id, userId: user.id, action: 'updated' })),
        });
      }
      return result;
    });
    res.json({ issue: serializeIssue(updated) });
  }),
);

issuesRouter.delete(
  '/:key',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { issue } = await loadIssue(req.params.key, user.id);
    await prisma.$transaction([
      prisma.issue.deleteMany({ where: { parentId: issue.id, type: 'SUBTASK' } }),
      prisma.issue.delete({ where: { id: issue.id } }),
    ]);
    res.status(204).end();
  }),
);

issuesRouter.post(
  '/:key/comments',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { issue } = await loadIssue(req.params.key, user.id);
    const { body } = commentSchema.parse(req.body);
    const [comment] = await prisma.$transaction([
      prisma.comment.create({
        data: { issueId: issue.id, authorId: user.id, body },
        include: { author: { select: userSelect } },
      }),
      prisma.activity.create({ data: { issueId: issue.id, userId: user.id, action: 'commented' } }),
      prisma.issue.update({ where: { id: issue.id }, data: { updatedAt: new Date() } }),
    ]);
    res.status(201).json({ comment });
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
    res.status(204).end();
  }),
);

