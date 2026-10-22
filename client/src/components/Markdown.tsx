import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Attachment } from '../types';

marked.setOptions({ gfm: true, breaks: true });

// Links in user content open in a new tab and can't reach back into the app window.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const MENTION_RE = /@\[([^\]\n]+)\]\(([a-z0-9]+)\)/g;
const ATTACHMENT_RE = /\(attachment:([a-z0-9]+)\)/g;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Markdown → sanitized HTML. Mentions (@[Nome](id)) become chips and attachment references
 * (attachment:id) are swapped for the attachment's current signed URL.
 */
export function renderMarkdown(source: string, attachments: Attachment[] = []) {
  const urls = new Map(attachments.map((a) => [a.id, a.url]));
  const prepared = source
    .replace(MENTION_RE, (_m, name: string) => `<span class="mention">@${escapeHtml(name)}</span>`)
    .replace(ATTACHMENT_RE, (m, id: string) => (urls.has(id) ? `(${urls.get(id)})` : m));
  const html = marked.parse(prepared, { async: false }) as string;
  return DOMPurify.sanitize(html);
}

/** Plain text version (mentions as @Nome), for previews. */
export function markdownToPlain(source: string) {
  return source.replace(MENTION_RE, '@$1');
}

export function Markdown({ source, attachments, className }: { source: string; attachments?: Attachment[]; className?: string }) {
  const html = useMemo(() => renderMarkdown(source, attachments), [source, attachments]);
  return <div className={`markdown ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
