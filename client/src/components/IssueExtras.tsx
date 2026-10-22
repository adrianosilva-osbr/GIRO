import { useEffect, useRef, useState } from 'react';
import { api, uploadFiles } from '../api';
import { formatDateTime, isDone } from '../constants';
import { useInvalidateWork, useIssues, useOpenIssue } from '../hooks';
import type { Attachment, IssueDetail, IssueLink, LinkType, User } from '../types';
import { Icon, IssueTypeIcon, PriorityIcon } from './Icons';
import { Avatar, Modal, StatusLozenge } from './ui';
import { useToast } from './Toast';

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function useUploadToIssue(issueKey: string) {
  const invalidate = useInvalidateWork();
  return async (files: File[]) => {
    const created = await uploadFiles<Attachment>(issueKey, files);
    await invalidate();
    return created;
  };
}

export function AttachmentsSection({ issue, meId, isAdmin }: { issue: IssueDetail; meId: string; isAdmin: boolean }) {
  const upload = useUploadToIssue(issue.key);
  const invalidate = useInvalidateWork();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const send = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    try {
      await upload(files);
      toast(files.length === 1 ? 'Arquivo anexado' : `${files.length} arquivos anexados`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: Attachment) => {
    if (!confirm(`Excluir o anexo "${a.filename}"?`)) return;
    try {
      await api(`/attachments/${a.id}`, { method: 'DELETE' });
      await invalidate();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <section
      className={`issue-section ${dragOver ? 'drop-files' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        send(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="row space-between">
        <h3>Anexos {issue.attachments.length > 0 && <span className="muted">({issue.attachments.length})</span>}</h3>
        <button className="btn-icon" title="Anexar arquivos" onClick={() => input.current?.click()} disabled={busy}>
          <Icon name="plus" />
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            send(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>
      {busy && <p className="muted small">Enviando…</p>}
      {issue.attachments.length === 0 && !busy ? (
        <button className="dropzone" onClick={() => input.current?.click()}>
          Arraste arquivos para cá ou <span className="link">procure no computador</span> (até 10 MB cada)
        </button>
      ) : (
        <div className="attachments">
          {issue.attachments.map((a) => (
            <div key={a.id} className="attachment" title={`${a.filename} · ${formatSize(a.size)} · ${a.uploader.name}, ${formatDateTime(a.createdAt)}`}>
              <button className="attachment-thumb" onClick={() => (a.isImage ? setPreview(a) : window.open(a.url, '_blank', 'noopener'))}>
                {a.isImage ? <img src={a.url} alt={a.filename} loading="lazy" /> : <span className="file-ext">{extension(a.filename)}</span>}
              </button>
              <div className="attachment-meta">
                <span className="attachment-name">{a.filename}</span>
                <span className="muted small">{formatSize(a.size)}</span>
              </div>
              <div className="attachment-actions">
                <a className="btn-icon" href={`${a.url}&download`} title="Baixar" download>
                  ⤓
                </a>
                {(a.uploaderId === meId || isAdmin) && (
                  <button className="btn-icon" title="Excluir" onClick={() => remove(a)}>
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {preview && (
        <Modal onClose={() => setPreview(null)} width={1100}>
          <div className="lightbox">
            <div className="row space-between">
              <b>{preview.filename}</b>
              <div className="row gap-sm">
                <a className="btn" href={`${preview.url}&download`} download>Baixar</a>
                <button className="btn-icon" onClick={() => setPreview(null)} aria-label="Fechar"><Icon name="close" /></button>
              </div>
            </div>
            <img src={preview.url} alt={preview.filename} />
          </div>
        </Modal>
      )}
    </section>
  );
}

function extension(name: string) {
  const ext = name.includes('.') ? name.split('.').pop()! : 'arq';
  return ext.slice(0, 4).toUpperCase();
}

const LINK_OPTIONS: { value: string; label: string; type: LinkType; direction: 'outward' | 'inward' }[] = [
  { value: 'BLOCKS:outward', label: 'bloqueia', type: 'BLOCKS', direction: 'outward' },
  { value: 'BLOCKS:inward', label: 'é bloqueada por', type: 'BLOCKS', direction: 'inward' },
  { value: 'RELATES:outward', label: 'relaciona-se com', type: 'RELATES', direction: 'outward' },
  { value: 'DUPLICATES:outward', label: 'duplica', type: 'DUPLICATES', direction: 'outward' },
  { value: 'DUPLICATES:inward', label: 'é duplicada por', type: 'DUPLICATES', direction: 'inward' },
  { value: 'CLONES:outward', label: 'clona', type: 'CLONES', direction: 'outward' },
  { value: 'CLONES:inward', label: 'é clonada por', type: 'CLONES', direction: 'inward' },
];

export function linkLabel(link: Pick<IssueLink, 'type' | 'direction'>) {
  if (link.type === 'RELATES') return 'relaciona-se com';
  return LINK_OPTIONS.find((o) => o.type === link.type && o.direction === link.direction)!.label;
}

export function LinksSection({ issue }: { issue: IssueDetail }) {
  const openIssue = useOpenIssue();
  const invalidate = useInvalidateWork();
  const toast = useToast();
  const [adding, setAdding] = useState(false);

  const groups = new Map<string, IssueLink[]>();
  for (const l of issue.links) {
    const label = linkLabel(l);
    groups.set(label, [...(groups.get(label) ?? []), l]);
  }

  const remove = async (l: IssueLink) => {
    try {
      await api(`/links/${l.id}`, { method: 'DELETE' });
      await invalidate();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <section className="issue-section">
      <div className="row space-between">
        <h3>Issues vinculadas</h3>
        <button className="btn-icon" title="Vincular issue" onClick={() => setAdding(true)}><Icon name="plus" /></button>
      </div>
      {adding && <AddLinkForm issue={issue} onDone={() => setAdding(false)} />}
      {[...groups].map(([label, links]) => (
        <div key={label} className="link-group">
          <div className="link-label">{label}</div>
          <ul className="child-list">
            {links.map((l) => (
              <li key={l.id} onClick={() => openIssue(l.issue.key)}>
                <IssueTypeIcon type={l.issue.type} />
                <span className={`key ${isDone(l.issue) ? 'done' : ''}`}>{l.issue.key}</span>
                <span className="child-title">{l.issue.title}</span>
                <PriorityIcon priority={l.issue.priority} />
                <Avatar user={l.issue.assignee} size={22} />
                <StatusLozenge status={l.issue.statusRef} />
                <button
                  className="btn-icon"
                  title="Remover vínculo"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(l);
                  }}
                >
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function AddLinkForm({ issue, onDone }: { issue: IssueDetail; onDone(): void }) {
  const [kind, setKind] = useState(LINK_OPTIONS[0].value);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const invalidate = useInvalidateWork();
  const toast = useToast();

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const { data: results = [] } = useIssues({ q, limit: '8', sort: 'updated' }, q.length > 0);
  const linked = new Set([issue.id, ...issue.links.map((l) => l.issue.id)]);
  const options = results.filter((r) => !linked.has(r.id));

  const link = async (targetKey: string) => {
    const opt = LINK_OPTIONS.find((o) => o.value === kind)!;
    try {
      await api(`/issues/${issue.key}/links`, { method: 'POST', body: { targetKey, type: opt.type, direction: opt.direction } });
      await invalidate();
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="link-form">
      <div className="row gap-sm">
        <span className="muted nowrap">Esta issue</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 180 }}>
          {LINK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Busque por chave ou resumo" />
        <button className="btn btn-subtle" onClick={onDone}>Cancelar</button>
      </div>
      {q && (
        <ul className="child-list link-results">
          {options.map((r) => (
            <li key={r.id} onClick={() => link(r.key)}>
              <IssueTypeIcon type={r.type} />
              <span className="key">{r.key}</span>
              <span className="child-title">{r.title}</span>
              <span className="muted small">{r.project.name}</span>
              <StatusLozenge status={r.statusRef} />
            </li>
          ))}
          {options.length === 0 && <li className="muted">Nenhuma issue encontrada</li>}
        </ul>
      )}
    </div>
  );
}

export function WatchButton({ issue, me }: { issue: IssueDetail; me: User }) {
  const invalidate = useInvalidateWork();
  const toast = useToast();
  const watching = issue.watchers.some((w) => w.id === me.id);
  const toggle = async () => {
    try {
      await api(`/issues/${issue.key}/watch`, { method: watching ? 'DELETE' : 'POST' });
      await invalidate();
      toast(watching ? 'Você não está mais observando esta issue' : 'Você está observando esta issue');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const names = issue.watchers.map((w) => w.name).join(', ') || 'ninguém';
  return (
    <button className={`btn-icon watch-btn ${watching ? 'watching' : ''}`} onClick={toggle} title={`${watching ? 'Parar de observar' : 'Observar'} · Observadores: ${names}`}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" fill={watching ? 'currentColor' : 'none'} fillOpacity={watching ? 0.15 : 0} />
        <circle cx="8" cy="8" r="2" />
      </svg>
      <span className="small">{issue.watchers.length}</span>
    </button>
  );
}
