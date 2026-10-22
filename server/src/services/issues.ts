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
import { formatDuration } from '../duration.js';
import { removeFiles } from '../routes/attachments.js';

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
  // Minutes
  originalEstimate: z.number().int().min(0).max(1_000_000).nullable().optional(),
  remainingEstimate: z.number().int().min(0).max(1_000_000).nullable().optional(),
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
  if (data.originalEstimate !== undefined && data.originalEstimate !== issue.originalEstimate) {
    update.originalEstimate = data.originalEstimate;
    track('originalEstimate', formatDuration(issue.originalEstimate), formatDuration(data.originalEstimate));
    // Like Jira: the first estimate also becomes the remaining estimate.
    if (issue.remainingEstimate === null && data.remainingEstimate === undefined && data.originalEstimate !== null) {
      update.remainingEstimate = Math.max(0, data.originalEstimate - issue.timeSpent);
    }
  }
  if (data.remainingEstimate !== undefined && data.remainingEstimate !== issue.remainingEstimate) {
    update.remainingEstimate = data.remainingEstimate;
    track('remainingEstimate', formatDuration(issue.remainingEstimate), formatDuration(data.remainingEstimate));
  }

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

// ---------------------------------------------------------------- delete

export async function deleteIssue(issue: LoadedIssue) {
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
}

// ---------------------------------------------------------------- time tracking

export const workLogSchema = z.object({
  minutes: z.number().int().min(1, 'Informe o tempo gasto').max(60 * 24 * 31),
  startedAt: z.coerce.date().optional(),
  description: z.string().max(2000).optional().default(''),
  // 'auto' subtracts the logged time; a number sets the remaining estimate explicitly.
  remaining: z.union([z.literal('auto'), z.number().int().min(0)]).default('auto'),
});

function adjustRemaining(issue: { remainingEstimate: number | null; originalEstimate: number | null }, delta: number) {
  const base = issue.remainingEstimate ?? issue.originalEstimate;
  return base === null ? null : Math.max(0, base - delta);
}

export async function logWork(issue: LoadedIssue, data: z.infer<typeof workLogSchema>, actor: Actor) {
  const remaining = data.remaining === 'auto' ? adjustRemaining(issue, data.minutes) : data.remaining;
  const log = await prisma.$transaction(async (tx) => {
    const created = await tx.workLog.create({
      data: { issueId: issue.id, userId: actor.id, minutes: data.minutes, startedAt: data.startedAt ?? new Date(), description: data.description },
      include: { user: { select: userSelect } },
    });
    await tx.issue.update({
      where: { id: issue.id },
      data: { timeSpent: { increment: data.minutes }, remainingEstimate: remaining },
    });
    await tx.activity.create({
      data: { issueId: issue.id, userId: actor.id, action: 'updated', field: 'worklog', toValue: formatDuration(data.minutes) },
    });
    return created;
  });
  publishProject(issue.projectId);
  return log;
}

export async function updateWorkLog(logId: string, data: { minutes?: number; startedAt?: Date; description?: string }) {
  const log = await prisma.workLog.findUniqueOrThrow({ where: { id: logId }, include: { issue: true } });
  const delta = data.minutes !== undefined ? data.minutes - log.minutes : 0;
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.workLog.update({ where: { id: log.id }, data, include: { user: { select: userSelect } } });
    if (delta) {
      const remaining = log.issue.remainingEstimate === null ? null : Math.max(0, log.issue.remainingEstimate - delta);
      await tx.issue.update({ where: { id: log.issueId }, data: { timeSpent: { increment: delta }, remainingEstimate: remaining } });
    }
    return result;
  });
  publishProject(log.issue.projectId);
  return updated;
}

export async function deleteWorkLog(logId: string, actor: Actor) {
  const log = await prisma.workLog.findUniqueOrThrow({ where: { id: logId }, include: { issue: true } });
  await prisma.$transaction([
    prisma.workLog.delete({ where: { id: log.id } }),
    prisma.issue.update({
      where: { id: log.issueId },
      // The time goes back to the remaining estimate, like Jira's "adjust automatically".
      data: {
        timeSpent: { decrement: log.minutes },
        remainingEstimate: log.issue.remainingEstimate === null ? null : log.issue.remainingEstimate + log.minutes,
      },
    }),
    prisma.activity.create({
      data: { issueId: log.issueId, userId: actor.id, action: 'updated', field: 'worklog', fromValue: formatDuration(log.minutes) },
    }),
  ]);
  publishProject(log.issue.projectId);
}

// ---------------------------------------------------------------- clone

export const cloneSchema = z.object({
  title: z.string().trim().min(1).optional(),
  includeSubtasks: z.boolean().default(true),
});

export async function cloneIssue(issue: LoadedIssue, opts: z.infer<typeof cloneSchema>, actor: Actor) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: issue.projectId } });
  const values = await prisma.customFieldValue.findMany({ where: { issueId: issue.id } });
  const sprint = issue.sprintId ? await prisma.sprint.findUnique({ where: { id: issue.sprintId } }) : null;
  const base = (src: Issue) => ({
    projectKey: project.key,
    description: src.description,
    type: src.type as CreateInput['type'],
    priority: src.priority as CreateInput['priority'],
    storyPoints: src.storyPoints,
    labels: src.labels.split(',').filter(Boolean),
    dueDate: src.dueDate,
    startDate: src.startDate,
    assigneeId: src.assigneeId,
  });
  const clone = await createIssue(
    project,
    {
      ...base(issue),
      title: opts.title ?? `CLONE - ${issue.title}`,
      // A closed sprint can't receive issues; the clone then starts in the backlog.
      sprintId: sprint && sprint.status !== 'CLOSED' ? sprint.id : null,
      parentId: issue.parentId,
      customFields: Object.fromEntries(values.map((v) => [v.fieldId, v.value])),
    },
    actor,
  );
  await prisma.issueLink.create({ data: { type: 'CLONES', sourceId: clone.id, targetId: issue.id, createdById: actor.id } });
  if (opts.includeSubtasks && issue.type !== 'SUBTASK') {
    const subtasks = await prisma.issue.findMany({ where: { parentId: issue.id, type: 'SUBTASK' }, orderBy: { rank: 'asc' } });
    for (const st of subtasks) await createIssue(project, { ...base(st), title: st.title, parentId: clone.id }, actor);
  }
  return clone;
}

// ---------------------------------------------------------------- move to another project

export const moveSchema = z.object({
  projectKey: z.string().min(1),
  // Target status key; defaults to the same key, else the first status of the same category.
  status: z.string().optional(),
});

async function targetStatus(db: Prisma.TransactionClient, projectId: string, from: { key: string; category: string } | null, requested?: string) {
  const statuses = await db.projectStatus.findMany({ where: { projectId }, orderBy: { position: 'asc' } });
  if (requested) {
    const s = statuses.find((x) => x.key === requested);
    if (!s) throw new HttpError(400, 'Status inválido no projeto de destino');
    return s;
  }
  const s = statuses.find((x) => x.key === from?.key) ?? statuses.find((x) => x.category === from?.category) ?? statuses[0];
  if (!s) throw new HttpError(400, 'O projeto de destino não tem status configurados');
  return s;
}

/**
 * Moves an issue (and its subtasks) to another project: new key (the old one keeps working),
 * mapped status, custom fields kept when the target has a field with the same name and type.
 * Sprint and epic don't cross projects, so they are cleared.
 */
export async function moveIssue(issue: LoadedIssue, target: Project, opts: z.infer<typeof moveSchema>, actor: Actor) {
  if (issue.projectId === target.id) throw new HttpError(400, 'A issue já está neste projeto');
  if (issue.type === 'SUBTASK') throw new HttpError(400, 'Subtarefas se movem junto com a issue pai');
  const source = await prisma.project.findUniqueOrThrow({ where: { id: issue.projectId } });
  const [sourceFields, targetFields] = await Promise.all([
    prisma.customField.findMany({ where: { projectId: source.id } }),
    prisma.customField.findMany({ where: { projectId: target.id } }),
  ]);
  const fieldMap = new Map<string, string>();
  for (const f of sourceFields) {
    const match = targetFields.find((t) => t.name.toLowerCase() === f.name.toLowerCase() && t.type === f.type);
    if (match) fieldMap.set(f.id, match.id);
  }
  const subtasks = await prisma.issue.findMany({
    where: { parentId: issue.id, type: 'SUBTASK' },
    include: { statusRef: { select: { key: true, name: true, category: true } } },
    orderBy: { rank: 'asc' },
  });

  const moveOne = async (tx: Prisma.TransactionClient, src: LoadedIssue, parentId: string | null, requested?: string) => {
    const status = await targetStatus(tx, target.id, src.statusRef, requested);
    const { issueCounter } = await tx.project.update({ where: { id: target.id }, data: { issueCounter: { increment: 1 } } });
    const max = await tx.issue.aggregate({ where: { projectId: target.id }, _max: { rank: true } });
    const keepAssignee = src.assigneeId
      ? await tx.projectMember.findUnique({ where: { projectId_userId: { projectId: target.id, userId: src.assigneeId } } })
      : null;
    const newKey = `${target.key}-${issueCounter}`;
    await tx.issueKeyAlias.create({ data: { key: src.key, issueId: src.id } });
    // Custom values: re-point the ones with a matching field, drop the rest.
    const values = await tx.customFieldValue.findMany({ where: { issueId: src.id } });
    await tx.customFieldValue.deleteMany({ where: { issueId: src.id } });
    for (const v of values) {
      const fieldId = fieldMap.get(v.fieldId);
      if (fieldId) await tx.customFieldValue.create({ data: { issueId: src.id, fieldId, value: v.value } });
    }
    const wasDone = src.statusRef?.category === 'DONE';
    const nowDone = status.category === 'DONE';
    const moved = await tx.issue.update({
      where: { id: src.id },
      data: {
        projectId: target.id,
        number: issueCounter,
        key: newKey,
        status: status.key,
        resolvedAt: wasDone === nowDone ? undefined : nowDone ? new Date() : null,
        sprintId: null,
        parentId,
        assigneeId: keepAssignee ? src.assigneeId : null,
        rank: (max._max.rank ?? 0) + 1,
      },
      include: issueListInclude,
    });
    await logSprintChanges(tx, src, moved);
    await tx.activity.create({
      data: {
        issueId: src.id,
        userId: actor.id,
        action: 'updated',
        field: 'project',
        fromValue: `${source.name} (${src.key})`,
        toValue: `${target.name} (${newKey})`,
      },
    });
    return moved;
  };

  const moved = await prisma.$transaction(
    async (tx) => {
      const main = await moveOne(tx, issue, null, opts.status);
      for (const st of subtasks) await moveOne(tx, st, issue.id);
      // Issues of a moved epic stay behind; epics don't span projects.
      if (issue.type === 'EPIC') await tx.issue.updateMany({ where: { parentId: issue.id, projectId: source.id }, data: { parentId: null } });
      return main;
    },
    { timeout: 20_000 },
  );
  publishProject(source.id, target.id);
  return moved;
}
