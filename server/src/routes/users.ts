import { Router } from 'express';
import { prisma } from '../db.js';
import { ah } from '../errors.js';
import { userSelect } from '../auth.js';

export const usersRouter = Router();

usersRouter.get(
  '/',
  ah(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const users = await prisma.user.findMany({
      where: { isSystem: false, ...(q ? { OR: [{ name: { contains: q } }, { email: { contains: q } }] } : {}) },
      select: userSelect,
      orderBy: { name: 'asc' },
      take: 50,
    });
    res.json({ users });
  }),
);
