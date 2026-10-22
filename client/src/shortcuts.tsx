import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal } from './components/ui';

/*
 * Keyboard shortcuts, Jira style. Single keys ("c") and two-key sequences ("g b") are ignored while
 * the user is typing. Components register shortcuts while mounted, so the help dialog always lists
 * exactly what the current screen supports.
 */

interface Shortcut {
  keys: string;
  label: string;
  run(): void;
}

const Registry = createContext<{ register(s: Shortcut): () => void; list(): Shortcut[]; showHelp(): void } | null>(null);

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function ShortcutProvider({ children }: { children: ReactNode }) {
  const shortcuts = useRef<Shortcut[]>([]);
  const [help, setHelp] = useState(false);
  const pending = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      // Inside an open dialog only the dialog's own shortcuts (registered last) apply.
      const key = e.key === '?' ? '?' : e.key.toLowerCase();
      if (key === '?') {
        e.preventDefault();
        setHelp((h) => !h);
        return;
      }
      const now = Date.now();
      const combo = pending.current && now - pending.current.at < 1200 ? `${pending.current.key} ${key}` : null;
      const all = [...shortcuts.current].reverse(); // most recently mounted wins
      const match = (combo && all.find((s) => s.keys === combo)) || all.find((s) => s.keys === key);
      if (match) {
        e.preventDefault();
        pending.current = null;
        match.run();
        return;
      }
      // Remember a possible first key of a sequence ("g …").
      pending.current = all.some((s) => s.keys.startsWith(`${key} `)) ? { key, at: now } : null;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const api = useMemo(() => ({
    register(s: Shortcut) {
      shortcuts.current.push(s);
      return () => {
        shortcuts.current = shortcuts.current.filter((x) => x !== s);
      };
    },
    list: () => shortcuts.current,
    showHelp: () => setHelp(true),
  }), []);

  return (
    <Registry.Provider value={api}>
      {children}
      {help && <ShortcutHelp shortcuts={shortcuts.current} onClose={() => setHelp(false)} />}
    </Registry.Provider>
  );
}

/** Registers a shortcut while the calling component is mounted. The latest `run` is always used. */
export function useShortcut(keys: string, label: string, run: () => void, enabled = true) {
  const registry = useContext(Registry);
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!registry || !enabled) return;
    return registry.register({ keys, label, run: () => runRef.current() });
  }, [registry, keys, label, enabled]);
}

function ShortcutHelp({ shortcuts, onClose }: { shortcuts: Shortcut[]; onClose(): void }) {
  // De-duplicate by key (a key registered twice shows the most specific, latest one).
  const byKey = new Map<string, Shortcut>();
  for (const s of shortcuts) byKey.set(s.keys, s);
  const rows = [...byKey.values(), { keys: '?', label: 'Mostrar / ocultar esta ajuda', run: () => {} }, { keys: 'esc', label: 'Fechar janela', run: () => {} }];
  return (
    <Modal title="Atalhos de teclado" onClose={onClose} width={520}>
      <table className="table shortcut-table">
        <tbody>
          {rows.map((s) => (
            <tr key={s.keys}>
              <td className="nowrap">{s.keys.split(' ').map((k, i) => <span key={i}>{i > 0 && <span className="muted"> depois </span>}<kbd>{k}</kbd></span>)}</td>
              <td>{s.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Os atalhos não funcionam enquanto você digita num campo.</p>
    </Modal>
  );
}

export function useShortcutHelp() {
  return useContext(Registry)?.showHelp ?? (() => {});
}
