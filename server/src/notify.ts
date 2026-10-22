import type { Issue, User } from '@prisma/client';
import { prisma } from './db.js';
import { publishUser } from './events.js';
import { APP_URL, sendMail } from './mailer.js';

/** Mentions are stored in Markdown as @[Display Name](userId). */
const MENTION_RE = /@\[([^\]\n]+)\]\(([a-z0-9]+)\)/g;

export function extractMentions(text: string | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const m of (text ?? '').matchAll(MENTION_RE)) ids.add(m[2]);
  return ids;
}

/** Text without Markdown syntax (mentions become @Name), for e-mails and notification excerpts. */
export function plainText(text: string, max = 160) {
  const plain = text
    .replace(MENTION_RE, '@$1')
    .replace(/```[\s\S]*?```/g, ' [código] ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '[imagem: $1]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]( \[[ xX]\])?|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

export async function watch(issueId: string, userIds: (string | null | undefined)[]) {
  for (const userId of new Set(userIds.filter((u): u is string => !!u))) {
    await prisma.watcher.upsert({
      where: { issueId_userId: { issueId, userId } },
      create: { issueId, userId },
      update: {},
    });
  }
}

export async function watcherIds(issueId: string) {
  const rows = await prisma.watcher.findMany({ where: { issueId }, select: { userId: true } });
  return rows.map((r) => r.userId);
}

export type NotificationType = 'assigned' | 'mentioned' | 'commented' | 'status';

const STATUS_LABEL: Record<string, string> = {
  TODO: 'A fazer',
  IN_PROGRESS: 'Em andamento',
  IN_REVIEW: 'Em revisão',
  DONE: 'Concluído',
};

function describe(type: NotificationType, actor: string, key: string, detail: string) {
  switch (type) {
    case 'assigned':
      return `${actor} atribuiu ${key} a você`;
    case 'mentioned':
      return `${actor} mencionou você em ${key}`;
    case 'commented':
      return `${actor} comentou em ${key}`;
    case 'status':
      return `${actor} mudou o status de ${key} para ${STATUS_LABEL[detail] ?? detail}`;
  }
}

/**
 * Creates in-app notifications (and e-mails, for users who keep them on) for project members
 * among `userIds`, never for the person who made the change.
 */
export async function notify(opts: {
  issue: Pick<Issue, 'id' | 'key' | 'title' | 'projectId'>;
  actor: Pick<User, 'id' | 'name'>;
  type: NotificationType;
  userIds: Iterable<string>;
  detail?: string;
}) {
  const { issue, actor, type } = opts;
  const detail = opts.detail ?? '';
  const candidates = [...new Set(opts.userIds)].filter((id) => id !== actor.id);
  if (!candidates.length) return;
  const recipients = await prisma.user.findMany({
    where: { id: { in: candidates }, memberships: { some: { projectId: issue.projectId } } },
  });

  for (const user of recipients) {
    await prisma.notification.create({
      data: { userId: user.id, actorId: actor.id, issueId: issue.id, type, detail },
    });
    publishUser(user.id);
    if (user.emailNotifications) {
      const headline = describe(type, actor.name, issue.key, detail);
      const excerpt = (type === 'commented' || type === 'mentioned') && detail ? `\n\n"${detail}"` : '';
      void sendMail({
        to: user.email,
        subject: `[${issue.key}] ${issue.title}`,
        text: `${headline}.${excerpt}\n\nAbrir a issue: ${APP_URL}/?issue=${issue.key}\n\nVocê pode desativar estes e-mails no seu perfil do GIRO.`,
      });
    }
  }
}
