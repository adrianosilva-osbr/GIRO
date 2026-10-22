import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { AutomationRule, User } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { jqlWhere } from './jql.js';
import { addComment, updateIssue } from './services/issues.js';

export const TRIGGERS = ['issue_created', 'status_changed', 'assignee_changed', 'comment_added', 'subtasks_done'] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_status'), value: z.string().min(1) }),
  // userId, or "reporter" / "unassigned"
  z.object({ type: z.literal('assign'), value: z.string().min(1) }),
  z.object({ type: z.literal('set_priority'), value: z.enum(['HIGHEST', 'HIGH', 'MEDIUM', 'LOW', 'LOWEST']) }),
  z.object({ type: z.literal('add_label'), value: z.string().trim().min(1) }),
  // Supports {{key}}, {{title}} and {{actor}} placeholders
  z.object({ type: z.literal('add_comment'), value: z.string().trim().min(1).max(2000) }),
]);
export type Action = z.infer<typeof actionSchema>;

export interface AutomationEvent {
  type: Trigger;
  issueId: string;
  projectId: string;
  actorId: string;
  statusKey?: string;
}

/** Chain bookkeeping: actions can trigger further rules, but never the same rule twice and never deeper than MAX_DEPTH. */
export interface AutomationCtx {
  depth: number;
  seen: Set<string>;
}
const MAX_DEPTH = 3;

const SYSTEM_EMAIL = 'automacao@giro.system';
let systemUser: User | null = null;

/** The account automation actions are performed as. It has no usable password. */
export async function getSystemUser() {
  if (systemUser) return systemUser;
  systemUser = await prisma.user.upsert({
    where: { email: SYSTEM_EMAIL },
    update: {},
    create: {
      email: SYSTEM_EMAIL,
      name: 'Automação',
      avatarColor: '#5E4DB2',
      isSystem: true,
      // A bcrypt hash of random bytes nobody knows: login can never succeed.
      passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
    },
  });
  return systemUser;
}

function fill(template: string, vars: Record<string, string>) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);
}

async function run(rule: AutomationRule, event: AutomationEvent, ctx: AutomationCtx) {
  const issue = await prisma.issue.findUnique({
    where: { id: event.issueId },
    include: { statusRef: { select: { key: true, name: true, category: true } } },
  });
  if (!issue) return;

  if (rule.condition.trim()) {
    const { where } = await jqlWhere(rule.condition, { userId: event.actorId, projectIds: [rule.projectId] });
    const matches = await prisma.issue.count({ where: { AND: [{ id: issue.id }, where] } });
    if (!matches) return; // condition not met: not a run
  }

  const bot = await getSystemUser();
  const actor = await prisma.user.findUnique({ where: { id: event.actorId } });
  const next: AutomationCtx = { depth: ctx.depth + 1, seen: new Set([...ctx.seen, rule.id]) };
  const actions = z.array(actionSchema).parse(JSON.parse(rule.actions));
  const done: string[] = [];

  for (const action of actions) {
    // Re-read between actions so each one sees the previous one's effect.
    const current = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      include: { statusRef: { select: { key: true, name: true, category: true } } },
    });
    switch (action.type) {
      case 'set_status':
        await updateIssue(current, { status: action.value }, bot, next);
        break;
      case 'assign': {
        const assigneeId =
          action.value === 'reporter' ? current.reporterId : action.value === 'unassigned' ? null : action.value;
        await updateIssue(current, { assigneeId }, bot, next);
        break;
      }
      case 'set_priority':
        await updateIssue(current, { priority: action.value }, bot, next);
        break;
      case 'add_label': {
        const labels = [...current.labels.split(',').filter(Boolean), action.value];
        await updateIssue(current, { labels }, bot, next);
        break;
      }
      case 'add_comment':
        await addComment(current, fill(action.value, { key: current.key, title: current.title, actor: actor?.name ?? '' }), bot, next);
        break;
    }
    done.push(action.type);
  }
  return done;
}

/** Runs every enabled rule of the project listening to this event. Failures are recorded, never thrown. */
export async function fireAutomations(event: AutomationEvent, ctx: AutomationCtx) {
  if (ctx.depth >= MAX_DEPTH) return;
  const rules = await prisma.automationRule.findMany({
    where: { projectId: event.projectId, enabled: true, trigger: event.type },
    orderBy: { createdAt: 'asc' },
  });
  for (const rule of rules) {
    if (ctx.seen.has(rule.id)) continue;
    if (event.type === 'status_changed' && rule.triggerValue && rule.triggerValue !== event.statusKey) continue;
    const issueKey = (await prisma.issue.findUnique({ where: { id: event.issueId }, select: { key: true } }))?.key ?? '?';
    try {
      const done = await run(rule, event, ctx);
      if (!done) continue;
      await prisma.$transaction([
        prisma.automationRun.create({ data: { ruleId: rule.id, issueKey, success: true, message: `${done.length} ação(ões) executada(s)` } }),
        prisma.automationRule.update({ where: { id: rule.id }, data: { runCount: { increment: 1 }, lastRunAt: new Date() } }),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.automationRun.create({ data: { ruleId: rule.id, issueKey, success: false, message: message.slice(0, 500) } });
    }
  }
}
