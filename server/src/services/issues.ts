import type { Issue, Prisma, Project, User } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../errors.js';
import { userSelect } from '../auth.js';
import { encodeLabels, issueListInclude } from '../serialize.js';
import { publishProject } from '../events.js';
import { extractMentions, notify, plainText, watch, watcherIds } from '../notify.js';
import { logSprintChanges } from '../sprintlog.js';
import { initialStatus, isDone } from '../workflow.js';
import { fireAutomations, type AutomationCtx } from '../automation.js';

/*
 * Issue creation, updates and comments live here (not in the routes) because automations
 * perform the very same operations, with the same history, notifications and live updates.
 */

export const ISSUE_TYPES = ['EPIC', 'STORY', 'TASK', 'BUG', 'SUBTASK'] as const;
export const PRIORITIES = ['HIGHEST', 'HIGH', 'MEDIUM', 'LOW', 'LOWEST'] as const;

const nullableId = z.string().min(1).nullable();
const customFieldsSchema = z.record(z.union([z.string(), z.number(), z.null()]));

export const createSchema = z.object({
  projectKey: z.string(),
  title: z.string().trim().min(1, 'Informe um resumo'),
  description: z.string().optional().default(''),
  type: z.enum(ISSUE_TYPES).default('TASK'),
  status: z.string().min(1).optional(),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  storyPoints: z.number().int().min(0).max(1000).nullable().optional(),
  labels: z.array(z.string()).optional().default([]),
  dueDate: z.coerce.date().nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  assigneeId: nullableId.optional(),
  sprintId: nullableId.optional(),
  parentId: nullableId.optional(),
  customFields: customFieldsSchema.optional(),
});

export const updateSchema = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  type: z.enum(ISSUE_TYPES).optional(),
  status: z.string().min(1).optional(),
  priority: z.enum(PRIORITIES).optional(),
  storyPoints: z.number().int().min(0).max(1000).nullable().optional(),
  labels: z.array(z.string()).optional(),
  dueDate: z.coerce.date().nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  assigneeId: nullableId.optional(),
  sprintId: nullableId.optional(),
  parentId: nullableId.optional(),
  rank: z.number().finite().optional(),
  customFields: customFieldsSchema.optional(),
});

export type CreateInput = z.infer<typeof createSchema>;
export type UpdateInput = z.infer<typeof updateSchema>;
type Actor = Pick<User, 'id' | 'name'> & { isSystem?: boolean };
type LoadedIssue = Issue & { statusRef: { key: string; name: string; category: string } | null };

const rootCtx = (): AutomationCtx => ({ depth: 0, seen: new Set() });

// ---------------------------------------------------------------- validation

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

async function validateStatus(projectId: string, key: string) {
  const status = await prisma.projectStatus.findUnique({ where: { projectId_key: { projectId, key } } });
  if (!status) throw new HttpError(400, `Status inválido para este projeto: ${key}`);
  return status;
}

/** Canonical text for a custom field value, or null to clear it. Throws on invalid input. */
function customValue(field: { name: string; type: string; options: string }, raw: string | number | null): string | null {
  if (raw === null || raw === '') return null;
  const fail = (why: string) => {
    throw new HttpError(400, `Valor inválido para "${field.name}": ${why}`);
  };
  switch (field.type) {
    case 'NUMBER': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(n)) fail('informe um número');
      return String(n);
    }
    case 'DATE': {
      const s = String(raw).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) fail('use AAAA-MM-DD');
      return s;
    }
    case 'SELECT': {
      const options = JSON.parse(field.options) as string[];
      if (!options.includes(String(raw))) fail(`escolha uma das opções (${options.join(', ')})`);
      return String(raw);
    }
    default: {
      const s = String(raw).trim();
      if (s.length > 2000) fail('máximo de 2000 caracteres');
      return s || null;
    }
  }
}

type Change = { field: string; fromValue: string | null; toValue: string | null };

async function applyCustomFields(tx: Prisma.TransactionClient, issue: { id: string; projectId: string }, input: Record<string, string | number | null>) {
  const changes: Change[] = [];
  const fields = await tx.customField.findMany({ where: { projectId: issue.projectId, id: { in: Object.keys(input) } } });
  if (fields.length !== Object.keys(input).length) throw new HttpError(400, 'Campo personalizado inválido para este projeto');
  const current = await tx.customFieldValue.findMany({ where: { issueId: issue.id } });
  for (const field of fields) {
    const next = customValue(field, input[field.id]);
    const prev = current.find((v) => v.fieldId === field.id)?.value ?? null;
    if (next === prev) continue;
    if (next === null) await tx.customFieldValue.delete({ where: { issueId_fieldId: { issueId: issue.id, fieldId: field.id } } });
    else {
      await tx.customFieldValue.upsert({
        where: { issueId_fieldId: { issueId: issue.id, fieldId: field.id } },
        create: { issueId: issue.id, fieldId: field.id, value: next },
        update: { value: next },
      });
    }
    changes.push({ field: `custom:${field.name}`, fromValue: prev, toValue: next });
  }
  return changes;
}

// ---------------------------------------------------------------- create

export async function createIssue(project: Project, data: CreateInput, actor: Actor, ctx = rootCtx()) {
  const parent = await validateParent(project.id, data.type, data.parentId);
  await validateAssignee(project.id, data.assigneeId);
  // Subtasks always live in the same sprint as their parent, like in Jira.
  const sprintId = data.type === 'SUBTASK' ? (parent?.sprintId ?? null) : (data.sprintId ?? null);
  if (data.type !== 'SUBTASK') await validateSprint(project.id, sprintId);
  const status = data.status ? await validateStatus(project.id, data.status) : await initialStatus(project.id);
  if (!status) throw new HttpError(400, 'O projeto não tem status configurados');

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
        status: status.key,
        priority: data.priority,
        storyPoints: data.storyPoints ?? null,
        labels: encodeLabels(data.labels),
        dueDate: data.dueDate ?? null,
        startDate: data.startDate ?? null,
        resolvedAt: status.category === 'DONE' ? new Date() : null,
        assigneeId: data.assigneeId ?? null,
        reporterId: actor.id,
        sprintId,
        parentId: data.parentId ?? null,
        rank: (max._max.rank ?? 0) + 1,
      },
      include: issueListInclude,
    });
    await tx.activity.create({ data: { issueId: created.id, userId: actor.id, action: 'created' } });
    if (data.customFields && Object.keys(data.customFields).length) await applyCustomFields(tx, created, data.customFields);
    await logSprintChanges(tx, null, created);
    return created;
  });

  // The automation account never becomes a watcher.
  await watch(issue.id, [actor.isSystem ? null : actor.id, issue.assigneeId]);
  if (issue.assigneeId) await notify({ issue, actor, type: 'assigned', userIds: [issue.assigneeId] });
  await notify({ issue, actor, type: 'mentioned', userIds: extractMentions(issue.description) });
  publishProject(project.id);
  await fireAutomations({ type: 'issue_created', issueId: issue.id, projectId: project.id, actorId: actor.id }, ctx);
  return issue;
}

// ---------------------------------------------------------------- update

function fmtDate(d: Date | null | undefined) {
  return d ? d.toISOString().slice(0, 10) : null;
}

export async function updateIssue(issue: LoadedIssue, data: UpdateInput, actor: Actor, ctx = rootCtx()) {
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

  for (const field of ['title', 'priority'] as const) {
    if (data[field] !== undefined && data[field] !== issue[field]) {
      update[field] = data[field];
      track(field, issue[field], data[field]);
    }
  }
  let newStatus: Awaited<ReturnType<typeof validateStatus>> | null = null;
  if (data.status !== undefined && data.status !== issue.status) {
    newStatus = await validateStatus(issue.projectId, data.status);
    update.status = newStatus.key;
    track('status', issue.statusRef?.name ?? issue.status, newStatus.name);
    const wasDone = isDone(issue);
    const nowDone = newStatus.category === 'DONE';
    if (wasDone !== nowDone) update.resolvedAt = nowDone ? new Date() : null;
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
  if (data.startDate !== undefined && fmtDate(data.startDate) !== fmtDate(issue.startDate)) {
    update.startDate = data.startDate;
    track('startDate', fmtDate(issue.startDate), fmtDate(data.startDate));
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
    if (data.customFields && Object.keys(data.customFields).length) {
      changes.push(...(await applyCustomFields(tx, issue, data.customFields)));
      update.updatedAt = new Date();
    }
    const result = await tx.issue.update({ where: { id: issue.id }, data: update, include: issueListInclude });
    await logSprintChanges(tx, issue, result);
    if (sprintChanged) {
      await tx.issue.updateMany({
        where: { parentId: issue.id, type: 'SUBTASK' },
        data: { sprintId: data.sprintId ?? null },
      });
    }
    if (changes.length) {
      await tx.activity.createMany({
        data: changes.map((c) => ({ ...c, issueId: issue.id, userId: actor.id, action: 'updated' })),
      });
    }
    return result;
  });

  if (update.assigneeId) {
    await watch(issue.id, [update.assigneeId as string]);
    await notify({ issue: updated, actor, type: 'assigned', userIds: [update.assigneeId as string] });
  }
  if (newStatus) {
    await notify({ issue: updated, actor, type: 'status', userIds: await watcherIds(issue.id), detail: newStatus.name });
  }
  if (update.description !== undefined) {
    const before = extractMentions(issue.description);
    const added = [...extractMentions(updated.description)].filter((id) => !before.has(id));
    await notify({ issue: updated, actor, type: 'mentioned', userIds: added });
  }
  publishProject(issue.projectId);

  const event = { issueId: issue.id, projectId: issue.projectId, actorId: actor.id };
  if (newStatus) {
    await fireAutomations({ ...event, type: 'status_changed', statusKey: newStatus.key }, ctx);
    // A subtask reaching "done" may complete its parent's checklist.
    if (updated.type === 'SUBTASK' && updated.parentId && newStatus.category === 'DONE' && !isDone(issue)) {
      const pending = await prisma.issue.count({
        where: { parentId: updated.parentId, type: 'SUBTASK', statusRef: { category: { not: 'DONE' } } },
      });
      if (pending === 0) await fireAutomations({ ...event, issueId: updated.parentId, type: 'subtasks_done' }, ctx);
    }
  }
  if (update.assigneeId !== undefined) await fireAutomations({ ...event, type: 'assignee_changed' }, ctx);
  return updated;
}

// ---------------------------------------------------------------- comments

export async function addComment(issue: Issue, body: string, actor: Actor, ctx = rootCtx()) {
  const [comment] = await prisma.$transaction([
    prisma.comment.create({
      data: { issueId: issue.id, authorId: actor.id, body },
      include: { author: { select: userSelect } },
    }),
    prisma.activity.create({ data: { issueId: issue.id, userId: actor.id, action: 'commented' } }),
    prisma.issue.update({ where: { id: issue.id }, data: { updatedAt: new Date() } }),
  ]);

  const mentioned = extractMentions(body);
  const excerpt = plainText(body);
  const watchers = await watcherIds(issue.id);
  if (!actor.isSystem) await watch(issue.id, [actor.id]);
  await notify({ issue, actor, type: 'mentioned', userIds: mentioned, detail: excerpt });
  // Mentioned people already got a more specific notification.
  await notify({ issue, actor, type: 'commented', userIds: watchers.filter((id) => !mentioned.has(id)), detail: excerpt });
  publishProject(issue.projectId);
  await fireAutomations({ type: 'comment_added', issueId: issue.id, projectId: issue.projectId, actorId: actor.id }, ctx);
  return comment;
}
