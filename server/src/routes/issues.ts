import { Router } from 'express';
import type { Prisma, User } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, HttpError } from '../errors.js';
import { currentUser, userSelect } from '../auth.js';
import { assertMember, loadIssue, loadProject } from '../access.js';
import { decodeLabels, issueListInclude, normalizeLabel, serializeIssue } from '../serialize.js';
import { publishProject } from '../events.js';
import { extractMentions, notify, plainText, watch } from '../notify.js';
import { serializeAttachment } from './attachments.js';
import { JqlError, compileJql, parseJql, sortByPriority } from '../jql.js';
import {
  addComment,
  cloneIssue,
  cloneSchema,
  createIssue,
  createSchema,
  deleteIssue,
  deleteWorkLog,
  logWork,
  moveIssue,
  moveSchema,
  updateIssue,
  updateSchema,
  updateWorkLog,
  workLogSchema,
} from '../services/issues.js';
import { formatDuration } from '../duration.js';
import { buildCsv, buildXlsx, type Cell } from '../xlsx.js';

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

/**
 * Runs a search (JQL or basic filters) limited to the viewer's projects. Shared by the list
 * and the export so a download always matches what the screen shows.
 */
async function searchIssues<I extends Prisma.IssueInclude>(q: Record<string, unknown>, user: User, include: I, maxLimit: number) {
  const memberships = await prisma.projectMember.findMany({ where: { userId: user.id }, select: { projectId: true } });
  const projectIds = memberships.map((m) => m.projectId);
  const and: Prisma.IssueWhereInput[] = [{ projectId: { in: projectIds } }];
  const limit = Math.min(Number(q.limit) || maxLimit, maxLimit);

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
        throw new HttpError(400, `Erro na consulta (posição ${err.position + 1}): ${err.message}`);
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

  let issues = await prisma.issue.findMany({ where: { AND: and }, include, orderBy, take: limit });
  if (byPriority) issues = sortByPriority(issues, byPriority);
  return issues;
}

issuesRouter.get(
  '/',
  ah(async (req, res) => {
    const issues = await searchIssues(req.query, currentUser(req), issueListInclude, 1000);
    res.json({ issues: issues.map(serializeIssue) });
  }),
);

/** GET /api/issues/export?format=csv|xlsx&(jql=…|basic filters)&tz=<minutes> */
issuesRouter.get(
  '/export',
  ah(async (req, res) => {
    const user = currentUser(req);
    const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
    const tz = Math.max(-840, Math.min(840, Number(req.query.tz) || 0));
    const issues = await searchIssues(
      req.query,
      user,
      { ...issueListInclude, customValues: { include: { field: { select: { name: true, type: true } } } } },
      5000,
    );

    // One column per custom field name across the exported projects.
    const customNames = [...new Set(issues.flatMap((i) => i.customValues.map((v) => v.field.name)))].sort();
    const dateOnly = (d: Date | null) => (d ? new Date(d.toISOString().slice(0, 10)) : null);
    const hours = (m: number | null) => (m == null ? null : Math.round((m / 60) * 100) / 100);
    const TYPE: Record<string, string> = { EPIC: 'Épico', STORY: 'História', TASK: 'Tarefa', BUG: 'Bug', SUBTASK: 'Subtarefa' };
    const PRIORITY: Record<string, string> = { HIGHEST: 'Muito alta', HIGH: 'Alta', MEDIUM: 'Média', LOW: 'Baixa', LOWEST: 'Muito baixa' };
    const CATEGORY: Record<string, string> = { TODO: 'A fazer', IN_PROGRESS: 'Em andamento', DONE: 'Concluído' };

    const header = [
      'Chave', 'Resumo', 'Tipo', 'Status', 'Categoria do status', 'Prioridade', 'Projeto', 'Responsável', 'Relator',
      'Sprint', 'Pai / Épico', 'Etiquetas', 'Story points', 'Estimativa original (h)', 'Tempo gasto (h)', 'Restante (h)',
      'Data de início', 'Data limite', 'Criado', 'Atualizado', 'Concluído em', 'Bloqueada por', 'Descrição',
      ...customNames,
    ];
    const rows: Cell[][] = issues.map((i) => {
      const custom = new Map(i.customValues.map((v) => [v.field.name, v.field.type === 'NUMBER' ? Number(v.value) : v.field.type === 'DATE' ? new Date(v.value) : v.value]));
      return [
        i.key, i.title, TYPE[i.type] ?? i.type, i.statusRef?.name ?? i.status, CATEGORY[i.statusRef?.category ?? ''] ?? '',
        PRIORITY[i.priority] ?? i.priority, i.project.name, i.assignee?.name ?? '', i.reporter.name,
        i.sprint?.name ?? '', i.parent ? `${i.parent.key} ${i.parent.title}` : '', decodeLabels(i.labels).join(', '),
        i.storyPoints, hours(i.originalEstimate), hours(i.timeSpent || null), hours(i.remainingEstimate),
        dateOnly(i.startDate), dateOnly(i.dueDate), i.createdAt, i.updatedAt, i.resolvedAt, i._count.linksIn || null, i.description,
        ...customNames.map((n) => custom.get(n) ?? null),
      ];
    });

    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'xlsx') {
      const widths = header.map((h) => (h === 'Resumo' || h === 'Descrição' ? 50 : h === 'Pai / Épico' ? 30 : Math.max(12, h.length + 3)));
      const file = buildXlsx(header, rows, { sheetName: 'Issues', tzOffset: tz, widths });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="giro-issues-${stamp}.xlsx"`);
      return res.send(file);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="giro-issues-${stamp}.csv"`);
    res.send(buildCsv(header, rows, tz));
  }),
);

const bulkSchema = z.object({
  keys: z.array(z.string()).min(1, 'Selecione pelo menos uma issue').max(500),
  delete: z.boolean().optional(),
  changes: z
    .object({
      status: z.string().optional(),
      assigneeId: z.string().nullable().optional(),
      priority: updateSchema.shape.priority,
      sprintId: z.string().nullable().optional(),
      addLabels: z.array(z.string()).optional(),
      removeLabels: z.array(z.string()).optional(),
    })
    .optional(),
});

/** Applies the same change to many issues; each one succeeds or fails on its own. */
issuesRouter.post(
  '/bulk',
  ah(async (req, res) => {
    const user = currentUser(req);
    const data = bulkSchema.parse(req.body);
    if (!data.delete && !data.changes) throw new HttpError(400, 'Nada a fazer');
    const results: { key: string; ok: boolean; error?: string }[] = [];
    for (const key of data.keys) {
      try {
        const { issue } = await loadIssue(key, user.id);
        if (data.delete) {
          await deleteIssue(issue);
        } else {
          const c = data.changes!;
          let labels: string[] | undefined;
          if (c.addLabels?.length || c.removeLabels?.length) {
            const remove = new Set((c.removeLabels ?? []).map(normalizeLabel));
            labels = [...decodeLabels(issue.labels).filter((l) => !remove.has(l)), ...(c.addLabels ?? [])];
          }
          // Subtasks always follow their parent's sprint, so they are skipped for sprint moves.
          const sprintId = c.sprintId !== undefined && issue.type !== 'SUBTASK' ? c.sprintId : undefined;
          await updateIssue(issue, { status: c.status, assigneeId: c.assigneeId, priority: c.priority, sprintId, labels }, user);
        }
        results.push({ key: issue.key, ok: true });
      } catch (err) {
        results.push({ key, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    res.json({ results, updated: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
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
    const statusRef = { select: { key: true, name: true, category: true } } as const;
    const issue = await prisma.issue.findUniqueOrThrow({
      where: { id: base.id },
      include: {
        ...issueListInclude,
        children: { include: { assignee: { select: userSelect }, statusRef }, orderBy: { rank: 'asc' } },
        comments: { include: { author: { select: userSelect } }, orderBy: { createdAt: 'asc' } },
        activities: { include: { user: { select: userSelect } }, orderBy: { createdAt: 'desc' }, take: 100 },
        attachments: { include: { uploader: { select: userSelect } }, orderBy: { createdAt: 'asc' } },
        watchers: { include: { user: { select: userSelect } }, orderBy: { createdAt: 'asc' } },
        linksOut: { include: { target: { include: { assignee: { select: userSelect }, statusRef } } }, orderBy: { createdAt: 'asc' } },
        linksIn: { include: { source: { include: { assignee: { select: userSelect }, statusRef } } }, orderBy: { createdAt: 'asc' } },
        customValues: { select: { fieldId: true, value: true } },
        workLogs: { include: { user: { select: userSelect } }, orderBy: { startedAt: 'desc' } },
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
    await deleteIssue(issue);
    res.status(204).end();
  }),
);

issuesRouter.post(
  '/:key/clone',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { issue } = await loadIssue(req.params.key, user.id);
    const clone = await cloneIssue(issue, cloneSchema.parse(req.body ?? {}), user);
    res.status(201).json({ issue: serializeIssue(clone) });
  }),
);

issuesRouter.post(
  '/:key/move',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { issue } = await loadIssue(req.params.key, user.id);
    const data = moveSchema.parse(req.body);
    const { project } = await loadProject(data.projectKey, user.id);
    const moved = await moveIssue(issue, project, data, user);
    res.json({ issue: serializeIssue(moved) });
  }),
);

issuesRouter.post(
  '/:key/worklogs',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { issue } = await loadIssue(req.params.key, user.id);
    const log = await logWork(issue, workLogSchema.parse(req.body), user);
    res.status(201).json({ workLog: log, timeSpent: formatDuration(issue.timeSpent + log.minutes) });
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

/** Mounted at /api/worklogs — the author or a project admin may change a work log. */
export const workLogsRouter = Router();

async function loadWorkLog(id: string, userId: string) {
  const log = await prisma.workLog.findUnique({ where: { id }, include: { issue: true } });
  if (!log) throw new HttpError(404, 'Registro de trabalho não encontrado');
  const membership = await assertMember(log.issue.projectId, userId);
  if (log.userId !== userId && membership.role !== 'ADMIN') {
    throw new HttpError(403, 'Você só pode alterar seus próprios registros de trabalho');
  }
  return log;
}

workLogsRouter.patch(
  '/:id',
  ah(async (req, res) => {
    const user = currentUser(req);
    const log = await loadWorkLog(req.params.id, user.id);
    const data = workLogSchema.pick({ minutes: true, startedAt: true, description: true }).partial().parse(req.body);
    res.json({ workLog: await updateWorkLog(log.id, data) });
  }),
);

workLogsRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const user = currentUser(req);
    const log = await loadWorkLog(req.params.id, user.id);
    await deleteWorkLog(log.id, user);
    res.status(204).end();
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
