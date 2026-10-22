import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, HttpError } from '../errors.js';
import { currentUser, userSelect } from '../auth.js';
import { loadProject } from '../access.js';
import { publishProject } from '../events.js';
import { CATEGORIES, projectStatuses, statusKeyFrom } from '../workflow.js';
import { JqlError, jqlWhere } from '../jql.js';
import { TRIGGERS, actionSchema } from '../automation.js';

/** Mounted at /api/projects/:key — workflow, custom fields and automation rules (admins edit, members read). */
export const projectConfigRouter = Router({ mergeParams: true });
const keyOf = (req: { params: unknown }) => (req.params as { key: string }).key;

// ---------------------------------------------------------------- workflow

const statusSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome do status').max(40),
  category: z.enum(CATEGORIES),
});
const statusUpdateSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  category: z.enum(CATEGORIES).optional(),
  wipLimit: z.number().int().min(1).max(999).nullable().optional(),
});
const orderSchema = z.object({ ids: z.array(z.string()).min(1) });

async function loadStatus(projectId: string, id: string) {
  const status = await prisma.projectStatus.findUnique({ where: { id } });
  if (!status || status.projectId !== projectId) throw new HttpError(404, 'Status não encontrado');
  return status;
}

projectConfigRouter.post(
  '/statuses',
  ah(async (req, res) => {
    const { project } = await loadProject(keyOf(req), currentUser(req).id, { admin: true });
    const data = statusSchema.parse(req.body);
    const existing = await projectStatuses(project.id);
    if (existing.some((s) => s.name.toLowerCase() === data.name.toLowerCase())) {
      throw new HttpError(409, `Já existe um status "${data.name}"`);
    }
    const status = await prisma.projectStatus.create({
      data: {
        projectId: project.id,
        key: statusKeyFrom(data.name, new Set(existing.map((s) => s.key))),
        name: data.name,
        category: data.category,
        position: existing.length,
      },
    });
    publishProject(project.id);
    res.status(201).json({ status });
  }),
);

projectConfigRouter.patch(
  '/statuses/:id',
  ah(async (req, res) => {
    const { project } = await loadProject(keyOf(req), currentUser(req).id, { admin: true });
    const status = await loadStatus(project.id, req.params.id);
    const data = statusUpdateSchema.parse(req.body);
    if (data.name && data.name.toLowerCase() !== status.name.toLowerCase()) {
      const clash = await prisma.projectStatus.findFirst({ where: { projectId: project.id, name: data.name, NOT: { id: status.id } } });
      if (clash) throw new HttpError(409, `Já existe um status "${data.name}"`);
    }
    const updated = await prisma.$transaction(async (tx) => {
      // Moving a column in or out of "done" resolves / reopens the issues sitting in it.
      if (data.category && (data.category === 'DONE') !== (status.category === 'DONE')) {
        await tx.issue.updateMany({
          where: { projectId: project.id, status: status.key },
          data: { resolvedAt: data.category === 'DONE' ? new Date() : null },
        });
      }
      return tx.projectStatus.update({ where: { id: status.id }, data });
    });
    publishProject(project.id);
    res.json({ status: updated });
  }),
);

projectConfigRouter.put(
  '/statuses/order',
  ah(async (req, res) => {
    const { project } = await loadProject(keyOf(req), currentUser(req).id, { admin: true });
    const { ids } = orderSchema.parse(req.body);
    const existing = await projectStatuses(project.id);
    if (ids.length !== existing.length || !existing.every((s) => ids.includes(s.id))) {
      throw new HttpError(400, 'A nova ordem precisa incluir todos os status do projeto');
    }
    await prisma.$transaction(ids.map((id, position) => prisma.projectStatus.update({ where: { id }, data: { position } })));
    publishProject(project.id);
    res.json({ statuses: await projectStatuses(project.id) });
  }),
);

projectConfigRouter.delete(
  '/statuses/:id',
  ah(async (req, res) => {
    const { project } = await loadProject(keyOf(req), currentUser(req).id, { admin: true });
    const status = await loadStatus(project.id, req.params.id);
    const all = await projectStatuses(project.id);
    if (all.length === 1) throw new HttpError(400, 'O fluxo precisa de pelo menos um status');
    const inUse = await prisma.issue.count({ where: { projectId: project.id, status: status.key } });
    const moveTo = typeof req.query.moveTo === 'string' ? all.find((s) => s.key === req.query.moveTo && s.id !== status.id) : undefined;
    if (inUse && !moveTo) {
      throw new HttpError(400, `${inUse} issue(s) estão neste status. Escolha para qual status elas devem ir.`);
    }
    await prisma.$transaction(async (tx) => {
      if (inUse && moveTo) {
        const resolution = (moveTo.category === 'DONE') !== (status.category === 'DONE')
          ? { resolvedAt: moveTo.category === 'DONE' ? new Date() : null }
          : {};
        await tx.issue.updateMany({ where: { projectId: project.id, status: status.key }, data: { status: moveTo.key, ...resolution } });
      }
      await tx.projectStatus.delete({ where: { id: status.id } });
      const rest = all.filter((s) => s.id !== status.id);
      for (const [position, s] of rest.entries()) await tx.projectStatus.update({ where: { id: s.id }, data: { position } });
    });
    publishProject(project.id);
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------- custom fields

const FIELD_TYPES = ['TEXT', 'NUMBER', 'DATE', 'SELECT'] as const;
const options = z.array(z.string().trim().min(1).max(60)).max(50);
const fieldSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome do campo').max(40),
  type: z.enum(FIELD_TYPES),
  options: options.optional().default([]),
});
const fieldUpdateSchema = z.object({ name: z.string().trim().min(1).max(40).optional(), options: options.optional() });

function checkOptions(type: string, opts: string[]) {
  if (type === 'SELECT' && !opts.length) throw new HttpError(400, 'Listas de opções precisam de pelo menos uma opção');
  if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) throw new HttpError(400, 'Há opções repetidas');
}

projectConfigRouter.post(
  '/fields',
  ah(async (req, res) => {
    const { project } = await loadProject(keyOf(req), currentUser(req).id, { admin: true });
    const data = fieldSchema.parse(req.body);
    checkOptions(data.type, data.options);
    const count = await prisma.customField.count({ where: { projectId: project.id } });
    if (await prisma.customField.findFirst({ where: { projectId: project.id, name: data.name } })) {
      throw new HttpError(409, `Já existe um campo "${data.name}"`);
    }
    const field = await prisma.customField.create({
      data: { projectId: project.id, name: data.name, type: data.type, options: JSON.stringify(data.type === 'SELECT' ? data.options : []), position: count },
    });
    publishProject(project.id);
    res.status(201).json({ field });
  }),
);

projectConfigRouter.patch(
  '/fields/:id',
  ah(async (req, res) => {
    const { project } = await loadProject(keyOf(req), currentUser(req).id, { admin: true });
    const field = await prisma.customField.findUnique({ where: { id: req.params.id } });
    if (!field || field.projectId !== project.id) throw new HttpError(404, 'Campo não encontrado');
    const data = fieldUpdateSchema.parse(req.body);
    if (data.options) {
      checkOptions(field.type, data.options);
      // Removing an option that issues still use would leave invalid values behind.
      const used = await prisma.customFieldValue.findMany({ where: { fieldId: field.id }, distinct: ['value'], select: { value: true } });
      const orphan = used.find((u) => !data.options!.includes(u.value));
      if (field.type === 'SELECT' && orphan) {
        throw new HttpError(400, `A opção "${orphan.value}" ainda está em uso; troque o valor nessas issues antes de removê-la`);
      }
    }
    const updated = await prisma.customField.update({
      where: { id: field.id },
      data: { name: data.name, options: data.options ? JSON.stringify(data.options) : undefined },
    });
    publishProject(project.id);
    res.json({ field: updated });
  }),
);

projectConfigRouter.delete(
  '/fields/:id',
  ah(async (req, res) => {
    const { project } = await loadProject(keyOf(req), currentUser(req).id, { admin: true });
    const field = await prisma.customField.findUnique({ where: { id: req.params.id } });
    if (!field || field.projectId !== project.id) throw new HttpError(404, 'Campo não encontrado');
    await prisma.customField.delete({ where: { id: field.id } });
    publishProject(project.id);
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------- automation

const ruleSchema = z.object({
  name: z.string().trim().min(1, 'Dê um nome à regra').max(80),
  enabled: z.boolean().default(true),
  trigger: z.enum(TRIGGERS),
  triggerValue: z.string().nullable().optional(),
  condition: z.string().max(1000).default(''),
  actions: z.array(actionSchema).min(1, 'Adicione pelo menos uma ação').max(10),
});

async function validateRule(projectId: string, userId: string, rule: z.infer<typeof ruleSchema>) {
  const statuses = await projectStatuses(projectId);
  if (rule.triggerValue && !statuses.some((s) => s.key === rule.triggerValue)) throw new HttpError(400, 'Status do gatilho inválido');
  if (rule.condition.trim()) {
    try {
      await jqlWhere(rule.condition, { userId, projectIds: [projectId] });
    } catch (err) {
      if (err instanceof JqlError) throw new HttpError(400, `Condição inválida (posição ${err.position + 1}): ${err.message}`);
      throw err;
    }
  }
  for (const a of rule.actions) {
    if (a.type === 'set_status' && !statuses.some((s) => s.key === a.value)) throw new HttpError(400, 'Status da ação inválido');
    if (a.type === 'assign' && a.value !== 'reporter' && a.value !== 'unassigned') {
      const member = await prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: a.value } } });
      if (!member) throw new HttpError(400, 'O responsável da ação precisa ser membro do projeto');
    }
  }
}

const serializeRule = <T extends { actions: string }>(r: T) => ({ ...r, actions: JSON.parse(r.actions) });

projectConfigRouter.get(
  '/automations',
  ah(async (req, res) => {
    const { project } = await loadProject(keyOf(req), currentUser(req).id);
    const rules = await prisma.automationRule.findMany({
      where: { projectId: project.id },
      include: { createdBy: { select: userSelect }, runs: { orderBy: { at: 'desc' }, take: 10 } },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ rules: rules.map(serializeRule) });
  }),
);

projectConfigRouter.post(
  '/automations',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { project } = await loadProject(keyOf(req), user.id, { admin: true });
    const data = ruleSchema.parse(req.body);
    await validateRule(project.id, user.id, data);
    const rule = await prisma.automationRule.create({
      data: { ...data, triggerValue: data.triggerValue ?? null, actions: JSON.stringify(data.actions), projectId: project.id, createdById: user.id },
    });
    res.status(201).json({ rule: serializeRule(rule) });
  }),
);

projectConfigRouter.patch(
  '/automations/:id',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { project } = await loadProject(keyOf(req), user.id, { admin: true });
    const rule = await prisma.automationRule.findUnique({ where: { id: req.params.id } });
    if (!rule || rule.projectId !== project.id) throw new HttpError(404, 'Regra não encontrada');
    const data = ruleSchema.parse({ ...serializeRule(rule), ...req.body });
    await validateRule(project.id, user.id, data);
    const updated = await prisma.automationRule.update({
      where: { id: rule.id },
      data: { ...data, triggerValue: data.triggerValue ?? null, actions: JSON.stringify(data.actions) },
    });
    res.json({ rule: serializeRule(updated) });
  }),
);

projectConfigRouter.delete(
  '/automations/:id',
  ah(async (req, res) => {
    const { project } = await loadProject(keyOf(req), currentUser(req).id, { admin: true });
    const rule = await prisma.automationRule.findUnique({ where: { id: req.params.id } });
    if (!rule || rule.projectId !== project.id) throw new HttpError(404, 'Regra não encontrada');
    await prisma.automationRule.delete({ where: { id: rule.id } });
    res.status(204).end();
  }),
);
