import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah } from '../errors.js';
import { currentUser, userSelect } from '../auth.js';
import { publishUser } from '../events.js';

const readSchema = z.object({ ids: z.array(z.string()).optional() });

export const notificationsRouter = Router();

notificationsRouter.get(
  '/',
  ah(async (req, res) => {
    const user = currentUser(req);
    const [notifications, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: user.id },
        include: {
          actor: { select: userSelect },
          issue: { select: { id: true, key: true, title: true, type: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 40,
      }),
      prisma.notification.count({ where: { userId: user.id, read: false } }),
    ]);
    res.json({ notifications, unread });
  }),
);

/** Marks the given notifications (or all of them) as read. */
notificationsRouter.post(
  '/read',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { ids } = readSchema.parse(req.body ?? {});
    await prisma.notification.updateMany({
      where: { userId: user.id, read: false, ...(ids ? { id: { in: ids } } : {}) },
      data: { read: true },
    });
    publishUser(user.id);
    res.json({ ok: true });
  }),
);
