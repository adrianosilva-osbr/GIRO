import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { Attachment, User } from '../types';
import { Markdown } from './Markdown';
import { Avatar } from './ui';

interface Props {
  value: string;
  onChange(value: string): void;
  /** People who can be @mentioned. */
  members?: User[];
  /** Enables paste/drop/attach of files; returns the uploaded attachments. */
  onUpload?(files: File[]): Promise<Attachment[]>;
  /** Used to resolve attachment: references in the preview. */
  attachments?: Attachment[];
  onSubmit?(): void;
  onCancel?(): void;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
}

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function MarkdownEditor({
  value,
  onChange,
  members = [],
  onUpload,
  attachments,
  onSubmit,
  onCancel,
  placeholder,
  rows = 6,
  autoFocus,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');

  const suggestions = mention
    ? members.filter((m) => normalize(`${m.name} ${m.email}`).includes(normalize(mention.query))).slice(0, 6)
    : [];

  /** Replaces [start, end) with text and puts the caret (or selection) where asked. */
  const replaceRange = (start: number, end: number, text: string, selStart?: number, selEnd?: number) => {
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(selStart ?? start + text.length, selEnd ?? selStart ?? start + text.length);
    });
  };

  const wrap = (before: string, after = before, placeholderText = 'texto') => {
    const el = ref.current!;
    const { selectionStart: s, selectionEnd: e } = el;
    const selected = value.slice(s, e) || placeholderText;
    replaceRange(s, e, before + selected + after, s + before.length, s + before.length + selected.length);
  };

  const prefixLines = (prefix: string | ((i: number) => string)) => {
    const el = ref.current!;
    const lineStart = value.lastIndexOf('\n', el.selectionStart - 1) + 1;
    const lineEnd = value.indexOf('\n', el.selectionEnd);
    const end = lineEnd === -1 ? value.length : lineEnd;
    const lines = value.slice(lineStart, end).split('\n');
    const text = lines.map((l, i) => (typeof prefix === 'string' ? prefix : prefix(i)) + l).join('\n');
    replaceRange(lineStart, end, text);
  };

  const insertAtCaret = (text: string) => {
    const el = ref.current;
    const pos = el ? el.selectionStart : value.length;
    const end = el ? el.selectionEnd : value.length;
    const pad = pos > 0 && !/\s$/.test(value.slice(0, pos)) ? ' ' : '';
    replaceRange(pos, end, pad + text);
  };

  const detectMention = (text: string, caret: number) => {
    const m = text.slice(0, caret).match(/(?:^|\s)@([\p{L}\p{N}._-]{0,30})$/u);
    if (m && members.length) {
      setMention({ start: caret - m[1].length - 1, query: m[1] });
      setActive(0);
    } else {
      setMention(null);
    }
  };

  const pickMention = (user: User) => {
    if (!mention) return;
    const caret = ref.current?.selectionStart ?? mention.start + mention.query.length + 1;
    replaceRange(mention.start, caret, `@[${user.name}](${user.id}) `);
    setMention(null);
  };

  const upload = async (files: File[]) => {
    if (!onUpload || !files.length) return;
    setUploading(true);
    setError('');
    try {
      const created = await onUpload(files);
      const refs = created.map((a) => `${a.isImage ? '!' : ''}[${a.filename.replace(/[[\]]/g, '')}](attachment:${a.id})`);
      insertAtCaret(refs.join('\n') + '\n');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && suggestions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(suggestions[active]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMention(null); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && onSubmit) { e.preventDefault(); onSubmit(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); wrap('**'); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); wrap('_'); return; }
    if (e.key === 'Escape' && onCancel) { e.stopPropagation(); onCancel(); }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length && onUpload) {
      e.preventDefault();
      upload(files);
    }
  };

  const onDrop = (e: DragEvent) => {
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length && onUpload) {
      e.preventDefault();
      upload(files);
    }
  };

  const tools: { label: string; title: string; run(): void }[] = [
    { label: 'B', title: 'Negrito (Ctrl+B)', run: () => wrap('**') },
    { label: 'I', title: 'Itálico (Ctrl+I)', run: () => wrap('_') },
    { label: 'S', title: 'Tachado', run: () => wrap('~~') },
    { label: '</>', title: 'Código', run: () => {
      const el = ref.current!;
      const multiline = value.slice(el.selectionStart, el.selectionEnd).includes('\n');
      if (multiline) wrap('```\n', '\n```', 'código');
      else wrap('`', '`', 'código');
    } },
    { label: '🔗', title: 'Link', run: () => {
      const el = ref.current!;
      const s = el.selectionStart;
      const selected = value.slice(s, el.selectionEnd) || 'texto do link';
      const text = `[${selected}](https://)`;
      replaceRange(s, el.selectionEnd, text, s + selected.length + 3, s + text.length - 1);
    } },
    { label: '•', title: 'Lista', run: () => prefixLines('- ') },
    { label: '1.', title: 'Lista numerada', run: () => prefixLines((i) => `${i + 1}. `) },
    { label: '☐', title: 'Lista de tarefas', run: () => prefixLines('- [ ] ') },
    { label: '❝', title: 'Citação', run: () => prefixLines('> ') },
  ];

  return (
    <div
      className={`md-editor ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        if (onUpload && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="md-toolbar">
        <button type="button" className={tab === 'write' ? 'active' : ''} onClick={() => setTab('write')}>Escrever</button>
        <button type="button" className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>Visualizar</button>
        <span className="md-sep" />
        {tab === 'write' &&
          tools.map((t) => (
            <button key={t.title} type="button" className="md-tool" title={t.title} onMouseDown={(e) => e.preventDefault()} onClick={t.run}>
              {t.label}
            </button>
          ))}
        {tab === 'write' && members.length > 0 && (
          <button type="button" className="md-tool" title="Mencionar alguém" onMouseDown={(e) => e.preventDefault()} onClick={() => insertAtCaret('@')}>
            @
          </button>
        )}
        {tab === 'write' && onUpload && (
          <>
            <button type="button" className="md-tool" title="Anexar arquivo" onClick={() => fileInput.current?.click()}>📎</button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                upload(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>

      {tab === 'write' ? (
        <div className="md-input">
          <textarea
            ref={ref}
            value={value}
            rows={rows}
            autoFocus={autoFocus}
            placeholder={placeholder}
            onChange={(e) => {
              onChange(e.target.value);
              detectMention(e.target.value, e.target.selectionStart);
            }}
            onClick={(e) => detectMention(value, e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => setTimeout(() => setMention(null), 150)}
          />
          {mention && suggestions.length > 0 && (
            <ul className="mention-menu" role="listbox">
              {suggestions.map((u, i) => (
                <li
                  key={u.id}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'active' : ''}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(u);
                  }}
                >
                  <Avatar user={u} size={22} /> {u.name} <span className="muted small">{u.email}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="md-preview">
          {value.trim() ? <Markdown source={value} attachments={attachments} /> : <span className="muted">Nada para visualizar.</span>}
        </div>
      )}
      <div className="md-footer muted small">
        {uploading ? 'Enviando arquivo…' : error ? <span className="error-inline">{error}</span> : (
          <>Markdown suportado{members.length > 0 && ' · @ para mencionar'}{onUpload && ' · cole ou arraste imagens'}{onSubmit && ' · Ctrl+Enter para salvar'}</>
        )}
      </div>
    </div>
  );
}
