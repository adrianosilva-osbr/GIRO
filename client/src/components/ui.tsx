import { useEffect, type ReactNode } from 'react';
import type { StatusRef, User } from '../types';
import { Icon } from './Icons';

export function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function Avatar({ user, size = 24, title }: { user: User | null | undefined; size?: number; title?: string }) {
  const style = { width: size, height: size, fontSize: Math.max(9, size * 0.4) };
  if (!user) {
    return (
      <span className="avatar avatar-empty" style={style} title={title ?? 'Não atribuído'}>
        <svg viewBox="0 0 16 16" width={size * 0.6} height={size * 0.6} fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="5.5" r="3" />
          <path d="M2.5 14a5.5 5.5 0 0 1 11 0z" />
        </svg>
      </span>
    );
  }
  return (
    <span className="avatar" style={{ ...style, background: user.avatarColor }} title={title ?? user.name}>
      {initials(user.name)}
    </span>
  );
}

export function StatusLozenge({ status }: { status: StatusRef | null | undefined }) {
  if (!status) return null;
  return <span className={`lozenge lozenge-${status.category.toLowerCase()}`}>{status.name}</span>;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 560,
}: {
  title?: ReactNode;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: width }} role="dialog" aria-modal="true">
        {title && (
          <div className="modal-header">
            <h2>{title}</h2>
            <button className="btn-icon" onClick={onClose} aria-label="Fechar">
              <Icon name="close" />
            </button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner() {
  return <div className="spinner" aria-label="Carregando" />;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="error-text">{error instanceof Error ? error.message : String(error)}</div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
