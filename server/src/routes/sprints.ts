import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, HttpError } from '../errors.js';
import { currentUser } from '../auth.js';
import { loadProject, loadSprint } from '../access.js';
import { publishProject } from '../events.js';
import { logSprintStart } from '../sprintlog.js';

const createSchema = z.object({
  name: z.string().trim().min(1).optional(),
  goal: z.string().optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  goal: z.string().optional(),
  startDate: z.coerce.date().nullable().optional(),
  endDate: z.coerce.date().nullable().optional(),
});

const startSchema = updateSchema;

const completeSchema = z.object({
  // 'backlog' or the id of a planned sprint that receives the unfinished issues
  moveTo: z.string().default('backlog'),
});

const DAY = 24 * 60 * 60 * 1000;

/** Mounted at /api/projects/:key/sprints */
export const projectSprintsRouter = Router({ mergeParams: true });

projectSprintsRouter.get(
  '/',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { project } = await loadProject((req.params as { key: string }).key, user.id);
    const includeClosed = req.query.includeClosed === '1';
    const sprints = await prisma.sprint.findMany({
      where: { projectId: project.id, ...(includeClosed ? {} : { status: { not: 'CLOSED' } }) },
      include: { _count: { select: { issues: true } } },
      orderBy: [{ createdAt: 'asc' }],
    });
    const order: Record<string, number> = { ACTIVE: 0, PLANNED: 1, CLOSED: 2 };
    sprints.sort((a, b) => order[a.status] - order[b.status]);
    res.json({ sprints });
  }),
);

projectSprintsRouter.post(
  '/',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { project } = await loadProject((req.params as { key: string }).key, user.id);
    const data = createSchema.parse(req.body);
    const sprint = await prisma.$transaction(async (tx) => {
      const { sprintCounter } = await tx.project.update({
        where: { id: project.id },
        data: { sprintCounter: { increment: 1 } },
      });
      return tx.sprint.create({
        data: {
          projectId: project.id,
          name: data.name || `${project.key} Sprint ${sprintCounter}`,
          goal: data.goal ?? '',
        },
      });
    });
    publishProject(project.id);
    res.status(201).json({ sprint });
  }),
);

/** Mounted at /api/sprints */
export const sprintsRouter = Router();

sprintsRouter.patch(
  '/:id',
  ah(async (req, res) => {
    const user = currentUser(req);
    const sprint = await loadSprint(req.params.id, user.id);
    if (sprint.status === 'CLOSED') throw new HttpError(400, 'Sprints encerradas não podem ser editadas');
    const data = updateSchema.parse(req.body);
    const updated = await prisma.sprint.update({ where: { id: sprint.id }, data });
    publishProject(sprint.projectId);
    res.json({ sprint: updated });
  }),
);

sprintsRouter.post(
  '/:id/start',
  ah(async (req, res) => {
    const user = currentUser(req);
    const sprint = await loadSprint(req.params.id, user.id);
    if (sprint.status !== 'PLANNED') throw new HttpError(400, 'Apenas sprints planejadas podem ser iniciadas');
    const active = await prisma.sprint.findFirst({ where: { projectId: sprint.projectId, status: 'ACTIVE' } });
    if (active) throw new HttpError(409, `Já existe uma sprint ativa (${active.name}). Encerre-a primeiro.`);
    const issues = await prisma.issue.count({ where: { sprintId: sprint.id } });
    if (!issues) throw new HttpError(400, 'Adicione pelo menos uma issue à sprint antes de iniciá-la');

    const data = startSchema.parse(req.body ?? {});
    const startDate = data.startDate ?? new Date();
    const endDate = data.endDate ?? new Date(startDate.getTime() + 14 * DAY);
    if (endDate <= startDate) throw new HttpError(400, 'A data de término deve ser posterior ao início');
    const updated = await prisma.$transaction(async (tx) => {
      const started = await tx.sprint.update({
        where: { id: sprint.id },
        data: { status: 'ACTIVE', name: data.name, goal: data.goal, startDate, endDate },
      });
      // The commitment is what the sprint holds right now, stamped at its official start.
      await logSprintStart(tx, started, startDate);
      return started;
    });
    publishProject(sprint.projectId);
    res.json({ sprint: updated });
  }),
);

sprintsRouter.post(
  '/:id/complete',
  ah(async (req, res) => {
    const user = currentUser(req);
    const sprint = await loadSprint(req.params.id, user.id);
    if (sprint.status !== 'ACTIVE') throw new HttpError(400, 'Apenas a sprint ativa pode ser encerrada');
    const { moveTo } = completeSchema.parse(req.body ?? {});

    let targetSprintId: string | null = null;
    if (moveTo !== 'backlog') {
      const target = await prisma.sprint.findUnique({ where: { id: moveTo } });
      if (!target || target.projectId !== sprint.projectId || target.status !== 'PLANNED') {
        throw new HttpError(400, 'Sprint de destino inválida');
      }
      targetSprintId = target.id;
    }

    const result = await prisma.$transaction(async (tx) => {
      const completed = await tx.issue.count({
        where: { sprintId: sprint.id, statusRef: { category: 'DONE' }, type: { not: 'SUBTASK' } },
      });
      // Subtasks travel with their parent: a finished subtask of an unfinished parent moves too.
      const moved = await tx.issue.updateMany({
        where: {
          sprintId: sprint.id,
          OR: [
            { type: { not: 'SUBTASK' }, statusRef: { category: { not: 'DONE' } } },
            { type: 'SUBTASK', parent: { statusRef: { category: { not: 'DONE' } } } },
          ],
        },
        data: { sprintId: targetSprintId },
      });
      const updated = await tx.sprint.update({
        where: { id: sprint.id },
        data: { status: 'CLOSED', completedAt: new Date() },
      });
      return { sprint: updated, completed, moved: moved.count };
    });
    publishProject(sprint.projectId);
    res.json(result);
  }),
);

sprintsRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const user = currentUser(req);
    const sprint = await loadSprint(req.params.id, user.id);
    if (sprint.status !== 'PLANNED') throw new HttpError(400, 'Apenas sprints planejadas podem ser excluídas');
    // Issues return to the backlog through onDelete: SetNull.
    await prisma.sprint.delete({ where: { id: sprint.id } });
    publishProject(sprint.projectId);
    res.status(204).end();
  }),
);
