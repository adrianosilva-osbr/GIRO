import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './db.js';

type Db = PrismaClient | Prisma.TransactionClient;

export const CATEGORIES = ['TODO', 'IN_PROGRESS', 'DONE'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Every new project starts with this workflow; teams can rename, reorder, add and remove columns. */
export const DEFAULT_STATUSES = [
  { key: 'TODO', name: 'A fazer', category: 'TODO' },
  { key: 'IN_PROGRESS', name: 'Em andamento', category: 'IN_PROGRESS' },
  { key: 'IN_REVIEW', name: 'Em revisão', category: 'IN_PROGRESS' },
  { key: 'DONE', name: 'Concluído', category: 'DONE' },
] as const;

export async function createDefaultStatuses(db: Db, projectId: string) {
  await db.projectStatus.createMany({
    data: DEFAULT_STATUSES.map((s, position) => ({ ...s, projectId, position })),
  });
}

export function projectStatuses(projectId: string, db: Db = prisma) {
  return db.projectStatus.findMany({ where: { projectId }, orderBy: { position: 'asc' } });
}

/** Status a new issue starts in: the first "to do" column, or simply the first one. */
export async function initialStatus(projectId: string, db: Db = prisma) {
  const statuses = await projectStatuses(projectId, db);
  return statuses.find((s) => s.category === 'TODO') ?? statuses[0];
}

export const normalize = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/** "Em validação" -> "EM_VALIDACAO", unique within the project. */
export function statusKeyFrom(name: string, taken: Set<string>) {
  const base =
    normalize(name)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'STATUS';
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}

export const isDone = (issue: { statusRef?: { category: string } | null }) => issue.statusRef?.category === 'DONE';
