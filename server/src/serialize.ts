import { userSelect } from './auth.js';

export function encodeLabels(labels: string[]): string {
  const clean = [...new Set(labels.map(normalizeLabel).filter(Boolean))];
  return clean.length ? `,${clean.join(',')},` : '';
}

export function normalizeLabel(label: string) {
  return label.trim().toLowerCase().replace(/[\s,]+/g, '-');
}

export function decodeLabels(stored: string): string[] {
  return stored.split(',').filter(Boolean);
}

/** Relations included whenever an issue is returned in a list. */
export const issueListInclude = {
  assignee: { select: userSelect },
  reporter: { select: userSelect },
  sprint: { select: { id: true, name: true, status: true } },
  parent: { select: { id: true, key: true, title: true, type: true, parentId: true } },
  statusRef: { select: { key: true, name: true, category: true } },
  project: { select: { id: true, key: true, name: true } },
  _count: {
    select: {
      children: true,
      comments: true,
      // Unfinished issues that block this one.
      linksIn: { where: { type: 'BLOCKS', source: { statusRef: { category: { not: 'DONE' } } } } },
    },
  },
} as const;

export function serializeIssue<T extends { labels: string; _count?: { linksIn?: number } }>(issue: T) {
  return { ...issue, labels: decodeLabels(issue.labels), blockedBy: issue._count?.linksIn ?? 0 };
}
