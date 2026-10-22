import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { CREATABLE_TYPES, PRIORITIES, PRIORITY_LABEL, TYPE_LABEL } from '../constants';
import { useInvalidateWork, useIssues, useOpenIssue, useProject, useProjects, useSprints } from '../hooks';
import type { Issue, IssueType, Priority } from '../types';
import { ErrorText, Field, Modal } from './ui';
import { useToast } from './Toast';
import { MarkdownEditor } from './MarkdownEditor';

export interface CreateDefaults {
  projectKey?: string;
  type?: IssueType;
  sprintId?: string | null;
  parentId?: string | null;
}

const CreateIssueContext = createContext<(defaults?: CreateDefaults) => void>(() => {});
export const useCreateIssue = () => useContext(CreateIssueContext);

export function CreateIssueProvider({ children }: { children: ReactNode }) {
  const [defaults, setDefaults] = useState<CreateDefaults | null>(null);
  return (
    <CreateIssueContext.Provider value={(d) => setDefaults(d ?? {})}>
      {children}
      {defaults && <CreateIssueModal defaults={defaults} onClose={() => setDefaults(null)} />}
    </CreateIssueContext.Provider>
  );
}

function CreateIssueModal({ defaults, onClose }: { defaults: CreateDefaults; onClose(): void }) {
  const { data: projects = [] } = useProjects();
  const [projectKey, setProjectKey] = useState(defaults.projectKey ?? '');
  const [type, setType] = useState<IssueType>(defaults.type ?? 'TASK');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('MEDIUM');
  const [assigneeId, setAssigneeId] = useState('');
  const [sprintId, setSprintId] = useState(defaults.sprintId ?? '');
  const [parentId, setParentId] = useState(defaults.parentId ?? '');
  const [storyPoints, setStoryPoints] = useState('');
  const [labels, setLabels] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [another, setAnother] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!projectKey && projects.length) setProjectKey(projects[0].key);
  }, [projects, projectKey]);

  const { data: project } = useProject(projectKey || undefined);
  const { data: sprints = [] } = useSprints(projectKey || undefined);
  const isSubtask = type === 'SUBTASK';
  const { data: parents = [] } = useIssues(
    isSubtask ? { project: projectKey, excludeType: 'EPIC,SUBTASK' } : { project: projectKey, type: 'EPIC' },
    !!projectKey && type !== 'EPIC',
  );

  const invalidate = useInvalidateWork();
  const openIssue = useOpenIssue();
  const toast = useToast();

  const changeProject = (key: string) => {
    setProjectKey(key);
    setAssigneeId('');
    setSprintId('');
    setParentId('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { issue } = await api<{ issue: Issue }>('/issues', {
        method: 'POST',
        body: {
          projectKey,
          type,
          title,
          description,
          priority,
          assigneeId: assigneeId || null,
          sprintId: isSubtask ? null : sprintId || null,
          parentId: type === 'EPIC' ? null : parentId || null,
          storyPoints: storyPoints === '' ? null : Number(storyPoints),
          labels: labels.split(',').map((l) => l.trim()).filter(Boolean),
          dueDate: dueDate || null,
        },
      });
      await invalidate();
      toast(
        <span>
          Issue <button className="link" onClick={() => openIssue(issue.key)}>{issue.key}</button> criada
        </span>,
      );
      if (another) {
        setTitle('');
        setDescription('');
      } else {
        onClose();
      }
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Criar issue"
      onClose={onClose}
      width={640}
      footer={
        <>
          <label className="checkbox">
            <input type="checkbox" checked={another} onChange={(e) => setAnother(e.target.checked)} />
            Criar outra
          </label>
          <div className="spacer" />
          <button type="button" className="btn btn-subtle" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form="create-issue" className="btn btn-primary" disabled={saving || !title.trim() || !projectKey}>
            {saving ? 'Criando…' : 'Criar'}
          </button>
        </>
      }
    >
      <form id="create-issue" onSubmit={submit} className="form">
        <div className="form-row">
          <Field label="Projeto *">
            <select value={projectKey} onChange={(e) => changeProject(e.target.value)} required>
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name} ({p.key})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tipo de issue *">
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value as IssueType);
                setParentId('');
              }}
            >
              {[...CREATABLE_TYPES, 'SUBTASK' as const].map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Resumo *">
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="O que precisa ser feito?" required />
        </Field>
        <div className="field">
          <span className="field-label">Descrição</span>
          <MarkdownEditor
            rows={5}
            value={description}
            onChange={setDescription}
            members={project?.members?.map((m) => m.user)}
            placeholder="Adicione detalhes, critérios de aceite… Use @ para mencionar alguém."
          />
        </div>
        <div className="form-row">
          <Field label="Prioridade">
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Responsável">
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Não atribuído</option>
              {project?.members?.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.user.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="form-row">
          {type !== 'EPIC' && (
            <Field label={isSubtask ? 'Issue pai *' : 'Épico'}>
              <select value={parentId} onChange={(e) => setParentId(e.target.value)} required={isSubtask}>
                <option value="">{isSubtask ? 'Selecione…' : 'Nenhum'}</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.key} — {p.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {!isSubtask && (
            <Field label="Sprint">
              <select value={sprintId} onChange={(e) => setSprintId(e.target.value)}>
                <option value="">Backlog</option>
                {sprints.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.status === 'ACTIVE' ? ' (ativa)' : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <div className="form-row">
          <Field label="Story points">
            <input type="number" min={0} value={storyPoints} onChange={(e) => setStoryPoints(e.target.value)} />
          </Field>
          <Field label="Data limite">
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Etiquetas" hint="Separe por vírgula, ex: frontend, urgente">
          <input value={labels} onChange={(e) => setLabels(e.target.value)} />
        </Field>
        <ErrorText error={error} />
      </form>
    </Modal>
  );
}
