import type { IssueType, Priority } from '../types';
import { PRIORITY_LABEL, TYPE_LABEL } from '../constants';

const TYPE_COLOR: Record<IssueType, string> = {
  EPIC: '#904EE2',
  STORY: '#63BA3C',
  TASK: '#4BADE8',
  BUG: '#E5493A',
  SUBTASK: '#4BADE8',
};

export function IssueTypeIcon({ type, size = 16 }: { type: IssueType; size?: number }) {
  const color = TYPE_COLOR[type];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-label={TYPE_LABEL[type]} role="img" className="type-icon">
      <title>{TYPE_LABEL[type]}</title>
      <rect width="16" height="16" rx="3" fill={color} />
      {type === 'EPIC' && <path d="M9.3 3 5 9h3l-1.3 4L11 7H8z" fill="#fff" />}
      {type === 'STORY' && <path d="M5 3.5h6v9L8 10l-3 2.5z" fill="#fff" />}
      {type === 'TASK' && <path d="m4.5 8.2 2.3 2.3 4.7-5" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
      {type === 'BUG' && <circle cx="8" cy="8" r="3.2" fill="#fff" />}
      {type === 'SUBTASK' && (
        <g fill="none" stroke="#fff" strokeWidth="1.4">
          <rect x="3.5" y="3.5" width="5" height="5" rx="1" fill="#fff" />
          <rect x="7.5" y="7.5" width="5" height="5" rx="1" />
        </g>
      )}
    </svg>
  );
}

const PRIORITY_COLOR: Record<Priority, string> = {
  HIGHEST: '#C9372C',
  HIGH: '#E2483D',
  MEDIUM: '#E2A03F',
  LOW: '#1D7AFC',
  LOWEST: '#579DFF',
};

export function PriorityIcon({ priority, size = 16 }: { priority: Priority; size?: number }) {
  const color = PRIORITY_COLOR[priority];
  const up = priority === 'HIGHEST' || priority === 'HIGH';
  const double = priority === 'HIGHEST' || priority === 'LOWEST';
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={PRIORITY_LABEL[priority]} className="priority-icon">
      <title>{`Prioridade: ${PRIORITY_LABEL[priority]}`}</title>
      {priority === 'MEDIUM' ? (
        <g stroke={color} strokeWidth="2" strokeLinecap="round">
          <path d="M3 6h10M3 10h10" />
        </g>
      ) : (
        <g fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" transform={up ? undefined : 'rotate(180 8 8)'}>
          <path d={double ? 'm3 8 5-4 5 4' : 'm3 10 5-4 5 4'} />
          {double && <path d="m3 12 5-4 5 4" />}
        </g>
      )}
    </svg>
  );
}

type IconName =
  | 'search' | 'plus' | 'board' | 'backlog' | 'list' | 'settings' | 'close' | 'chevron' | 'trash'
  | 'home' | 'folder' | 'filter' | 'more' | 'logout' | 'check' | 'edit' | 'timeline' | 'chart';

const PATHS: Record<IconName, string> = {
  search: 'M10.5 10.5 14 14M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z',
  plus: 'M8 3v10M3 8h10',
  board: 'M2.5 3h3v10h-3zM6.5 3h3v7h-3zM10.5 3h3v5h-3z',
  backlog: 'M2.5 4h11M2.5 8h11M2.5 12h7',
  list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5',
  settings: 'M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM13 8l1.3-.9-1.2-2.1-1.5.4-1.1-.7L10 3H7.6l-.4 1.7-1.1.7-1.5-.4-1.2 2.1L4.7 8l-1.3.9 1.2 2.1 1.5-.4 1.1.7L7.6 13H10l.4-1.7 1.1-.7 1.5.4 1.2-2.1Z',
  close: 'M4 4l8 8M12 4l-8 8',
  chevron: 'm5 6 3 3 3-3',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5',
  home: 'M2.5 7.5 8 3l5.5 4.5V13h-3.5V9.5h-4V13H2.5z',
  folder: 'M2 4.5h4l1.5 1.5H14v7H2z',
  filter: 'M2.5 3.5h11l-4.2 5v4l-2.6 1v-5z',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  logout: 'M6 3H3v10h3M10 5l3 3-3 3M13 8H6',
  check: 'm3.5 8.5 3 3 6-7',
  edit: 'M10.5 3 13 5.5 6 12.5H3.5V10z',
  timeline: 'M2.5 4h6M5 8h7M3.5 12h5M2.5 2v12',
  chart: 'M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5',
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 2.6 : 1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Logo() {
  return (
    <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#0C66E4" />
      <path d="M16 7a9 9 0 1 0 9 9h-9" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}
