export type IssueType = 'EPIC' | 'STORY' | 'TASK' | 'BUG' | 'SUBTASK';
export type Status = 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE';
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
  priority: Priority;
  storyPoints: number | null;
  labels: string[];
  dueDate: string | null;
  rank: number;
  assigneeId: string | null;
  assignee: User | null;
  reporterId: string;
  reporter: User;
  sprintId: string | null;
  sprint: Pick<Sprint, 'id' | 'name' | 'status'> | null;
  parentId: string | null;
  parent: Pick<Issue, 'id' | 'key' | 'title' | 'type'> | null;
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
}
