export type IssueType = 'EPIC' | 'STORY' | 'TASK' | 'BUG' | 'SUBTASK';
/** Key of one of the project's workflow statuses (e.g. TODO, IN_PROGRESS, or a custom one). */
export type Status = string;
export type Category = 'TODO' | 'IN_PROGRESS' | 'DONE';

export interface StatusRef {
  key: string;
  name: string;
  category: Category;
}

export interface ProjectStatus extends StatusRef {
  id: string;
  position: number;
  wipLimit: number | null;
}

export type FieldType = 'TEXT' | 'NUMBER' | 'DATE' | 'SELECT';

export interface CustomField {
  id: string;
  name: string;
  type: FieldType;
  options: string[];
  position: number;
}
export type Priority = 'HIGHEST' | 'HIGH' | 'MEDIUM' | 'LOW' | 'LOWEST';
export type SprintStatus = 'PLANNED' | 'ACTIVE' | 'CLOSED';
export type Role = 'ADMIN' | 'MEMBER';

export interface User {
  id: string;
  name: string;
  email: string;
  avatarColor: string;
}

export interface Member {
  projectId: string;
  userId: string;
  role: Role;
  user: User;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  leadId: string;
  lead: User;
  issueCounter: number;
  createdAt: string;
  myRole?: Role;
  members?: Member[];
  statuses?: ProjectStatus[];
  customFields?: CustomField[];
  _count?: { issues: number; members: number };
}

export interface Sprint {
  id: string;
  projectId: string;
  name: string;
  goal: string;
  status: SprintStatus;
  startDate: string | null;
  endDate: string | null;
  completedAt: string | null;
  _count?: { issues: number };
}

export interface Issue {
  id: string;
  key: string;
  number: number;
  title: string;
  description: string;
  type: IssueType;
  status: Status;
  statusRef: StatusRef | null;
  priority: Priority;
  storyPoints: number | null;
  /** Minutes */
  originalEstimate: number | null;
  remainingEstimate: number | null;
  timeSpent: number;
  /** How many unfinished issues block this one. */
  blockedBy: number;
  labels: string[];
  dueDate: string | null;
  startDate: string | null;
  resolvedAt: string | null;
  rank: number;
  assigneeId: string | null;
  assignee: User | null;
  reporterId: string;
  reporter: User;
  sprintId: string | null;
  sprint: Pick<Sprint, 'id' | 'name' | 'status'> | null;
  parentId: string | null;
  parent: (Pick<Issue, 'id' | 'key' | 'title' | 'type'> & { parentId: string | null }) | null;
  project: Pick<Project, 'id' | 'key' | 'name'>;
  _count: { children: number; comments: number };
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  body: string;
  author: User;
  authorId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Activity {
  id: string;
  action: 'created' | 'updated' | 'commented';
  field: string | null;
  fromValue: string | null;
  toValue: string | null;
  user: User;
  createdAt: string;
}

export interface IssueDetail extends Issue {
  children: (Omit<Issue, 'reporter' | 'sprint' | 'parent' | 'project' | '_count'>)[];
  comments: Comment[];
  activities: Activity[];
  attachments: Attachment[];
  watchers: User[];
  links: IssueLink[];
  customValues: { fieldId: string; value: string }[];
  workLogs: WorkLog[];
}

export interface WorkLog {
  id: string;
  minutes: number;
  startedAt: string;
  description: string;
  userId: string;
  user: User;
}

export interface Me extends User {
  emailNotifications: boolean;
}

export interface Attachment {
  id: string;
  issueId: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;
  isImage: boolean;
  uploaderId: string;
  uploader: User;
  createdAt: string;
}

export type LinkType = 'BLOCKS' | 'RELATES' | 'DUPLICATES' | 'CLONES';

export interface IssueLink {
  id: string;
  type: LinkType;
  direction: 'outward' | 'inward';
  issue: Pick<Issue, 'id' | 'key' | 'title' | 'type' | 'status' | 'statusRef' | 'priority' | 'assignee'>;
}

export type NotificationType = 'assigned' | 'mentioned' | 'commented' | 'status';

export interface AppNotification {
  id: string;
  type: NotificationType;
  detail: string;
  read: boolean;
  createdAt: string;
  actor: User;
  issue: Pick<Issue, 'id' | 'key' | 'title' | 'type'>;
}

export interface Totals {
  scopePoints: number;
  remainingPoints: number;
  scopeCount: number;
  remainingCount: number;
}

export interface ReportIssue extends Pick<Issue, 'id' | 'key' | 'title' | 'type' | 'status' | 'statusRef' | 'priority' | 'assignee'> {
  points: number;
  addedAfterStart: boolean;
  deleted?: boolean;
}

export interface SprintReport {
  sprint: Sprint & { projectKey: string };
  synthetic: boolean;
  start: string;
  end: string | null;
  finish: string;
  committed: Totals;
  final: Totals;
  series: (Totals & { at: string; change?: { type: string; issueKey: string } })[];
  issues: { completed: ReportIssue[]; notCompleted: ReportIssue[]; removed: ReportIssue[] };
}

export interface Velocity {
  sprints: {
    id: string;
    name: string;
    status: SprintStatus;
    startDate: string;
    completedAt: string | null;
    committedPoints: number;
    completedPoints: number;
    committedCount: number;
    completedCount: number;
  }[];
  averagePoints: number | null;
  averageCount: number | null;
}

export interface EpicProgress extends Pick<Issue, 'id' | 'key' | 'title' | 'status' | 'statusRef' | 'priority' | 'assignee' | 'dueDate'> {
  startDate: string | null;
  total: number;
  done: number;
  points: number;
  donePoints: number;
}

export interface ProjectSummary {
  totals: { all: number; open: number; createdLast7: number; resolvedLast7: number; updatedLast7: number; overdue: number; dueSoon: number };
  byStatus: (StatusRef & { count: number })[];
  byType: Partial<Record<IssueType, number>>;
  byPriority: Partial<Record<Priority, number>>;
  workload: { user: User | null; open: number }[];
  createdVsResolved: { day: string; created: number; resolved: number }[];
  epics: EpicProgress[];
  recent: (Activity & { issue: Pick<Issue, 'key' | 'title' | 'type'> })[];
}

export interface SavedFilter {
  id: string;
  name: string;
  jql: string;
  shared: boolean;
  ownerId: string;
  owner: User;
}

export type Trigger = 'issue_created' | 'status_changed' | 'assignee_changed' | 'comment_added' | 'subtasks_done';
export type AutomationAction =
  | { type: 'set_status'; value: string }
  | { type: 'assign'; value: string }
  | { type: 'set_priority'; value: Priority }
  | { type: 'add_label'; value: string }
  | { type: 'add_comment'; value: string };

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  triggerValue: string | null;
  condition: string;
  actions: AutomationAction[];
  runCount: number;
  lastRunAt: string | null;
  createdBy: User;
  runs: { id: string; issueKey: string; success: boolean; message: string; at: string }[];
}
