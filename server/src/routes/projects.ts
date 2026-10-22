import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, HttpError } from '../errors.js';
import { currentUser, userSelect } from '../auth.js';
import { loadProject } from '../access.js';
import { publishProject, refreshMemberships } from '../events.js';
import { removeFiles } from './attachments.js';
import { createDefaultStatuses } from '../workflow.js';

const createSchema = z.object({
  key: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'A chave deve ter de 2 a 10 caracteres, começando com letra (ex: GIRO)'),
  name: z.string().trim().min(2, 'Informe o nome do projeto'),
  description: z.string().optional().default(''),
});

const updateSchema = z.object({
  name: z.string().trim().min(2).optional(),
  description: z.string().optional(),
  leadId: z.string().optional(),
});

const roleSchema = z.enum(['ADMIN', 'MEMBER']);

const addMemberSchema = z
  .object({
    userId: z.string().optional(),
    email: z.string().trim().toLowerCase().optional(),
    role: roleSchema.default('MEMBER'),
  })
  .refine((d) => d.userId || d.email, 'Informe o usuário ou e-mail');

export const projectsRouter = Router();

projectsRouter.get(
  '/',
  ah(async (req, res) => {
    const user = currentUser(req);
    const projects = await prisma.project.findMany({
      where: { members: { some: { userId: user.id } } },
      include: {
        lead: { select: userSelect },
        members: { where: { userId: user.id }, select: { role: true } },
        _count: { select: { issues: true, members: true } },
      },
      orderBy: { name: 'asc' },
    });
    res.json({
      projects: projects.map(({ members, ...p }) => ({ ...p, myRole: members[0]?.role })),
    });
  }),
);

projectsRouter.post(
  '/',
  ah(async (req, res) => {
    const user = currentUser(req);
    const data = createSchema.parse(req.body);
    const exists = await prisma.project.findUnique({ where: { key: data.key } });
    if (exists) throw new HttpError(409, `Já existe um projeto com a chave ${data.key}`);
    const project = await prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          ...data,
          leadId: user.id,
          members: { create: { userId: user.id, role: 'ADMIN' } },
        },
      });
      await createDefaultStatuses(tx, created.id);
      return created;
    });
    res.status(201).json({ project });
  }),
);

projectsRouter.get(
  '/:key',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { project, membership } = await loadProject(req.params.key, user.id);
    const full = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      include: {
        lead: { select: userSelect },
        members: { include: { user: { select: userSelect } }, orderBy: { createdAt: 'asc' } },
        statuses: { orderBy: { position: 'asc' } },
        customFields: { orderBy: { position: 'asc' } },
      },
    });
    const customFields = full.customFields.map((f) => ({ ...f, options: JSON.parse(f.options) as string[] }));
    res.json({ project: { ...full, customFields, myRole: membership.role } });
  }),
);

projectsRouter.patch(
  '/:key',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { project } = await loadProject(req.params.key, user.id, { admin: true });
    const data = updateSchema.parse(req.body);
    if (data.leadId) {
      const m = await prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId: project.id, userId: data.leadId } },
      });
      if (!m) throw new HttpError(400, 'O líder do projeto precisa ser membro');
    }
    const updated = await prisma.project.update({ where: { id: project.id }, data });
    publishProject(project.id);
    res.json({ project: updated });
  }),
);

projectsRouter.delete(
  '/:key',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { project } = await loadProject(req.params.key, user.id, { admin: true });
    const files = await prisma.attachment.findMany({ where: { issue: { projectId: project.id } }, select: { storageKey: true } });
    await prisma.project.delete({ where: { id: project.id } });
    removeFiles(files.map((f) => f.storageKey));
    res.status(204).end();
  }),
);

projectsRouter.post(
  '/:key/members',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { project } = await loadProject(req.params.key, user.id, { admin: true });
    const data = addMemberSchema.parse(req.body);
    const target = await prisma.user.findFirst({
      where: data.userId ? { id: data.userId } : { email: data.email },
    });
    if (!target) throw new HttpError(404, 'Usuário não encontrado. Peça para ele criar uma conta primeiro.');
    const member = await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId: target.id } },
      create: { projectId: project.id, userId: target.id, role: data.role },
      update: {},
      include: { user: { select: userSelect } },
    });
    await refreshMemberships(target.id);
    publishProject(project.id);
    res.status(201).json({ member });
  }),
);

async function assertKeepsAnAdmin(projectId: string, userId: string) {
  const admins = await prisma.projectMember.count({ where: { projectId, role: 'ADMIN', NOT: { userId } } });
  if (admins === 0) throw new HttpError(400, 'O projeto precisa de pelo menos um administrador');
}

projectsRouter.patch(
  '/:key/members/:userId',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { project } = await loadProject(req.params.key, user.id, { admin: true });
    const role = roleSchema.parse(req.body.role);
    if (role !== 'ADMIN') await assertKeepsAnAdmin(project.id, req.params.userId);
    const member = await prisma.projectMember.update({
      where: { projectId_userId: { projectId: project.id, userId: req.params.userId } },
      data: { role },
      include: { user: { select: userSelect } },
    });
    publishProject(project.id);
    res.json({ member });
  }),
);

projectsRouter.delete(
  '/:key/members/:userId',
  ah(async (req, res) => {
    const user = currentUser(req);
    const isSelf = req.params.userId === user.id;
    const { project } = await loadProject(req.params.key, user.id, { admin: !isSelf });
    if (project.leadId === req.params.userId) {
      throw new HttpError(400, 'Troque o líder do projeto antes de remover este membro');
    }
    await assertKeepsAnAdmin(project.id, req.params.userId);
    await prisma.projectMember.delete({
      where: { projectId_userId: { projectId: project.id, userId: req.params.userId } },
    });
    await refreshMemberships(req.params.userId);
    publishProject(project.id);
    res.status(204).end();
  }),
);
