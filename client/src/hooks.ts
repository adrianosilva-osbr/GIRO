import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from './api';
import type { Issue, IssueDetail, Project, Sprint, User } from './types';

export type IssueFilters = Record<string, string | undefined>;

export const issuesKey = (filters: IssueFilters): QueryKey => ['issues', filters];

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => api<{ projects: Project[] }>('/projects').then((r) => r.projects),
  });
}

export function useProject(key: string | undefined) {
  return useQuery({
    queryKey: ['project', key],
    queryFn: () => api<{ project: Project }>(`/projects/${key}`).then((r) => r.project),
    enabled: !!key,
  });
}

export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ users: User[] }>('/users').then((r) => r.users),
  });
}

export function useIssues(filters: IssueFilters, enabled = true) {
  return useQuery({
    queryKey: issuesKey(filters),
    queryFn: () => api<{ issues: Issue[] }>(`/issues${qs(filters)}`).then((r) => r.issues),
    enabled,
  });
}

export function useIssue(key: string | null) {
  return useQuery({
    queryKey: ['issue', key],
    queryFn: () => api<{ issue: IssueDetail }>(`/issues/${key}`).then((r) => r.issue),
    enabled: !!key,
  });
}

export function useSprints(projectKey: string | undefined, includeClosed = false) {
  return useQuery({
    queryKey: ['sprints', projectKey, includeClosed],
    queryFn: () =>
      api<{ sprints: Sprint[] }>(`/projects/${projectKey}/sprints${includeClosed ? '?includeClosed=1' : ''}`).then(
        (r) => r.sprints,
      ),
    enabled: !!projectKey,
  });
}

/** Refreshes everything that may show issue data. */
export function useInvalidateWork() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['issues'] }),
      qc.invalidateQueries({ queryKey: ['issue'] }),
      qc.invalidateQueries({ queryKey: ['sprints'] }),
      qc.invalidateQueries({ queryKey: ['projects'] }),
    ]);
}

export function useUpdateIssue() {
  const invalidate = useInvalidateWork();
  return useMutation({
    mutationFn: ({ key, data }: { key: string; data: Partial<Record<string, unknown>> }) =>
      api<{ issue: Issue }>(`/issues/${key}`, { method: 'PATCH', body: data }).then((r) => r.issue),
    onSettled: invalidate,
  });
}

/**
 * Moves an issue with an optimistic update of one cached list, so drag and drop feels instant.
 */
export function useMoveIssue(listKey: QueryKey) {
  const qc = useQueryClient();
  const invalidate = useInvalidateWork();
  return useMutation({
    mutationFn: ({ issue, data }: { issue: Issue; data: Partial<Issue> }) =>
      api(`/issues/${issue.key}`, { method: 'PATCH', body: data }),
    onMutate: async ({ issue, data }) => {
      await qc.cancelQueries({ queryKey: listKey });
      const previous = qc.getQueryData<Issue[]>(listKey);
      qc.setQueryData<Issue[]>(listKey, (old) =>
        old?.map((i) => (i.id === issue.id ? { ...i, ...data } : i)).sort((a, b) => a.rank - b.rank),
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(listKey, ctx.previous);
    },
    onSettled: invalidate,
  });
}

/** Opening an issue is just a URL change (?issue=KEY), so issue links are shareable. */
export function useOpenIssue() {
  const [params, setParams] = useSearchParams();
  return (key: string | null) => {
    const next = new URLSearchParams(params);
    if (key) next.set('issue', key);
    else next.delete('issue');
    setParams(next);
  };
}
