import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, HttpError } from '../errors.js';
import { currentUser, userSelect } from '../auth.js';
import { JqlError, parseJql } from '../jql.js';

const filterSchema = z.object({
  name: z.string().trim().min(1, 'Dê um nome ao filtro').max(80),
  jql: z.string().trim().min(1, 'A consulta está vazia').max(2000),
  shared: z.boolean().default(false),
});

function checkSyntax(jql: string) {
  try {
    parseJql(jql);
  } catch (err) {
    if (err instanceof JqlError) throw new HttpError(400, `Erro na consulta (posição ${err.position + 1}): ${err.message}`);
    throw err;
  }
}

export const filtersRouter = Router();

/** The viewer's own filters plus everyone's shared ones. */
filtersRouter.get(
  '/',
  ah(async (req, res) => {
    const user = currentUser(req);
    const filters = await prisma.savedFilter.findMany({
      where: { OR: [{ ownerId: user.id }, { shared: true }] },
      include: { owner: { select: userSelect } },
      orderBy: { name: 'asc' },
    });
    res.json({ filters });
  }),
);

filtersRouter.post(
  '/',
  ah(async (req, res) => {
    const user = currentUser(req);
    const data = filterSchema.parse(req.body);
    checkSyntax(data.jql);
    const filter = await prisma.savedFilter.create({ data: { ...data, ownerId: user.id }, include: { owner: { select: userSelect } } });
    res.status(201).json({ filter });
  }),
);

async function ownFilter(id: string, userId: string) {
  const filter = await prisma.savedFilter.findUnique({ where: { id } });
  if (!filter) throw new HttpError(404, 'Filtro não encontrado');
  if (filter.ownerId !== userId) throw new HttpError(403, 'Só quem criou o filtro pode alterá-lo');
  return filter;
}

filtersRouter.patch(
  '/:id',
  ah(async (req, res) => {
    const user = currentUser(req);
    const filter = await ownFilter(req.params.id, user.id);
    const data = filterSchema.partial().parse(req.body);
    if (data.jql) checkSyntax(data.jql);
    const updated = await prisma.savedFilter.update({ where: { id: filter.id }, data, include: { owner: { select: userSelect } } });
    res.json({ filter: updated });
  }),
);

filtersRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const user = currentUser(req);
    const filter = await ownFilter(req.params.id, user.id);
    await prisma.savedFilter.delete({ where: { id: filter.id } });
    res.status(204).end();
  }),
);
