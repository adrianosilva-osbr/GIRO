import { prisma } from './db.js';
import { HttpError } from './errors.js';

export async function loadProject(key: string, userId: string, opts: { admin?: boolean } = {}) {
  const project = await prisma.project.findUnique({ where: { key: key.toUpperCase() } });
  if (!project) throw new HttpError(404, 'Projeto não encontrado');
  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: project.id, userId } },
  });
  if (!membership) throw new HttpError(403, 'Você não é membro deste projeto');
  if (opts.admin && membership.role !== 'ADMIN') {
    throw new HttpError(403, 'Apenas administradores do projeto podem fazer isso');
  }
  return { project, membership };
}

export async function assertMember(projectId: string, userId: string) {
  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (!membership) throw new HttpError(403, 'Você não é membro deste projeto');
  return membership;
}

export async function loadIssue(key: string, userId: string) {
  const issue = await prisma.issue.findUnique({ where: { key: key.toUpperCase() } });
  if (!issue) throw new HttpError(404, 'Issue não encontrada');
  const membership = await assertMember(issue.projectId, userId);
  return { issue, membership };
}

export async function loadSprint(id: string, userId: string) {
  const sprint = await prisma.sprint.findUnique({ where: { id }, include: { project: true } });
  if (!sprint) throw new HttpError(404, 'Sprint não encontrada');
  await assertMember(sprint.projectId, userId);
  return sprint;
}
