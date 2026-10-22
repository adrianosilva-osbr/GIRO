import { useState, type FormEvent } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useMe } from '../auth';
import type { Project, Role } from '../types';
import { Avatar, ErrorText, Field } from '../components/ui';
import { useToast } from '../components/Toast';

export function SettingsPage() {
  const project = useOutletContext<Project>();
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const isAdmin = project.myRole === 'ADMIN';

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [leadId, setLeadId] = useState(project.leadId);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('MEMBER');
  const [error, setError] = useState<unknown>(null);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['project', project.key] }),
      qc.invalidateQueries({ queryKey: ['projects'] }),
    ]);

  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setError(null);
    try {
      await fn();
      await refresh();
      if (success) toast(success);
      return true;
    } catch (err) {
      setError(err);
      return false;
    }
  };

  const saveDetails = (e: FormEvent) => {
    e.preventDefault();
    run(() => api(`/projects/${project.key}`, { method: 'PATCH', body: { name, description, leadId } }), 'Projeto atualizado');
  };

  const addMember = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api(`/projects/${project.key}/members`, { method: 'POST', body: { email, role } });
      setEmail('');
    }, 'Membro adicionado');
  };

  const deleteProject = async () => {
    const typed = prompt(`Isso excluirá o projeto e TODAS as suas issues. Digite ${project.key} para confirmar.`);
    if (typed?.toUpperCase() !== project.key) return;
    if (await run(() => api(`/projects/${project.key}`, { method: 'DELETE' }))) navigate('/projects');
  };

  return (
    <div className="page narrow">
      <h1 className="page-title">Configurações do projeto</h1>
      {!isAdmin && <p className="notice">Apenas administradores podem alterar as configurações deste projeto.</p>}
      <ErrorText error={error} />

      <section className="settings-section">
        <h2>Detalhes</h2>
        <form className="form" onSubmit={saveDetails}>
          <Field label="Nome">
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdmin} />
          </Field>
          <Field label="Chave" hint="A chave não pode ser alterada.">
            <input value={project.key} disabled />
          </Field>
          <Field label="Descrição">
            <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!isAdmin} />
          </Field>
          <Field label="Líder do projeto">
            <select value={leadId} onChange={(e) => setLeadId(e.target.value)} disabled={!isAdmin}>
              {project.members?.map((m) => <option key={m.userId} value={m.userId}>{m.user.name}</option>)}
            </select>
          </Field>
          {isAdmin && <div><button className="btn btn-primary">Salvar</button></div>}
        </form>
      </section>

      <section className="settings-section">
        <h2>Membros ({project.members?.length})</h2>
        {isAdmin && (
          <form className="row gap-sm mb-sm" onSubmit={addMember}>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-mail de um usuário cadastrado" required />
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="MEMBER">Membro</option>
              <option value="ADMIN">Administrador</option>
            </select>
            <button className="btn btn-primary">Adicionar</button>
          </form>
        )}
        <table className="table">
          <thead>
            <tr><th>Nome</th><th>E-mail</th><th>Papel</th><th /></tr>
          </thead>
          <tbody>
            {project.members?.map((m) => (
              <tr key={m.userId}>
                <td>
                  <span className="row gap-sm">
                    <Avatar user={m.user} size={24} /> {m.user.name}
                    {m.userId === project.leadId && <span className="tag">Líder</span>}
                  </span>
                </td>
                <td className="muted">{m.user.email}</td>
                <td>
                  <select
                    value={m.role}
                    disabled={!isAdmin}
                    onChange={(e) => run(() => api(`/projects/${project.key}/members/${m.userId}`, { method: 'PATCH', body: { role: e.target.value } }), 'Papel atualizado')}
                  >
                    <option value="MEMBER">Membro</option>
                    <option value="ADMIN">Administrador</option>
                  </select>
                </td>
                <td className="right">
                  {(isAdmin || m.userId === me.id) && (
                    <button
                      className="btn btn-subtle"
                      onClick={async () => {
                        const self = m.userId === me.id;
                        if (!confirm(self ? 'Sair deste projeto?' : `Remover ${m.user.name} do projeto?`)) return;
                        const ok = await run(() => api(`/projects/${project.key}/members/${m.userId}`, { method: 'DELETE' }), self ? undefined : 'Membro removido');
                        if (ok && self) navigate('/projects');
                      }}
                    >
                      {m.userId === me.id ? 'Sair' : 'Remover'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {isAdmin && (
        <section className="settings-section danger-zone">
          <h2>Zona de perigo</h2>
          <p className="muted">Excluir o projeto remove permanentemente todas as issues, sprints e comentários.</p>
          <button className="btn btn-danger" onClick={deleteProject}>Excluir projeto</button>
        </section>
      )}
    </div>
  );
}
