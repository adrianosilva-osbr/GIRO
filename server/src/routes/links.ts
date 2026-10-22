import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { ah, HttpError } from '../errors.js';
import { currentUser } from '../auth.js';
import { assertMember, loadIssue } from '../access.js';
import { publishProject } from '../events.js';

export const LINK_TYPES = ['BLOCKS', 'RELATES', 'DUPLICATES'] as const;

/** How a link reads from each side: "LOJA-1 bloqueia LOJA-2" / "LOJA-2 é bloqueada por LOJA-1". */
export const LINK_LABEL: Record<string, { outward: string; inward: string }> = {
  BLOCKS: { outward: 'bloqueia', inward: 'é bloqueada por' },
  RELATES: { outward: 'relaciona-se com', inward: 'relaciona-se com' },
  DUPLICATES: { outward: 'duplica', inward: 'é duplicada por' },
};

const createSchema = z.object({
  targetKey: z.string().min(1),
  type: z.enum(LINK_TYPES),
  // outward: this issue <type> target; inward: target <type> this issue
  direction: z.enum(['outward', 'inward']).default('outward'),
});

/** Mounted at /api/issues/:key/links */
export const issueLinksRouter = Router({ mergeParams: true });

issueLinksRouter.post(
  '/',
  ah(async (req, res) => {
    const user = currentUser(req);
    const { issue } = await loadIssue((req.params as { key: string }).key, user.id);
    const data = createSchema.parse(req.body);
    const { issue: other } = await loadIssue(data.targetKey, user.id);
    if (other.id === issue.id) throw new HttpError(400, 'Uma issue não pode ser vinculada a ela mesma');

    const [source, target] = data.direction === 'outward' ? [issue, other] : [other, issue];
    const existing = await prisma.issueLink.findFirst({
      where: {
        type: data.type,
        OR: [
          { sourceId: source.id, targetId: target.id },
          { sourceId: target.id, targetId: source.id },
        ],
      },
    });
    if (existing) throw new HttpError(409, 'Essas issues já estão vinculadas desta forma');

    const label = LINK_LABEL[data.type];
    const link = await prisma.$transaction(async (tx) => {
      const created = await tx.issueLink.create({
        data: { type: data.type, sourceId: source.id, targetId: target.id, createdById: user.id },
      });
      await tx.activity.createMany({
        data: [
          { issueId: source.id, userId: user.id, action: 'updated', field: 'link', toValue: `${label.outward} ${target.key}` },
          { issueId: target.id, userId: user.id, action: 'updated', field: 'link', toValue: `${label.inward} ${source.key}` },
        ],
      });
      return created;
    });
    publishProject(source.projectId, target.projectId);
    res.status(201).json({ link });
  }),
);

/** Mounted at /api/links */
export const linksRouter = Router();

linksRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const user = currentUser(req);
    const link = await prisma.issueLink.findUnique({
      where: { id: req.params.id },
      include: { source: true, target: true },
    });
    if (!link) throw new HttpError(404, 'Vínculo não encontrado');
    await assertMember(link.source.projectId, user.id);
    const label = LINK_LABEL[link.type];
    await prisma.$transaction([
      prisma.issueLink.delete({ where: { id: link.id } }),
      prisma.activity.createMany({
        data: [
          { issueId: link.sourceId, userId: user.id, action: 'updated', field: 'link', fromValue: `${label.outward} ${link.target.key}` },
          { issueId: link.targetId, userId: user.id, action: 'updated', field: 'link', fromValue: `${label.inward} ${link.source.key}` },
        ],
      }),
    ]);
    publishProject(link.source.projectId, link.target.projectId);
    res.status(204).end();
  }),
);
