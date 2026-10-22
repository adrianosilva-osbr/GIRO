import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useProjects } from '../hooks';
import type { Project } from '../types';
import { Avatar, EmptyState, ErrorText, Field, Modal, Spinner } from '../components/ui';
import { Icon } from '../components/Icons';

export function ProjectsPage() {
  const { data: projects = [], isLoading } = useProjects();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const visible = projects.filter((p) => `${p.name} ${p.key}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Projetos</h1>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> Criar projeto
        </button>
      </div>
      <div className="toolbar">
        <div className="search-box">
          <Icon name="search" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Pesquisar projetos" />
        </div>
      </div>
      {isLoading ? (
        <Spinner />
      ) : projects.length === 0 ? (
        <EmptyState title="Nenhum projeto ainda">Crie um projeto para começar a organizar o trabalho do time.</EmptyState>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Chave</th>
              <th>Líder</th>
              <th>Issues</th>
              <th>Membros</th>
              <th>Seu papel</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/projects/${p.key}/board`} className="row gap-sm">
                    <span className="project-avatar small">{p.key.slice(0, 2)}</span> {p.name}
                  </Link>
                </td>
                <td>{p.key}</td>
                <td>
                  <span className="row gap-sm"><Avatar user={p.lead} size={22} /> {p.lead.name}</span>
                </td>
                <td>{p._count?.issues}</td>
                <td>{p._count?.members}</td>
                <td>{p.myRole === 'ADMIN' ? 'Administrador' : 'Membro'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating && <CreateProjectModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function suggestKey(name: string) {
  const words = name.normalize('NFD').replace(/[^A-Za-z0-9\s]/g, '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const key = words.length > 1 ? words.map((w) => w[0]).join('') : words[0].slice(0, 4);
  return key.toUpperCase().replace(/^[0-9]+/, '').slice(0, 10);
}

function CreateProjectModal({ onClose }: { onClose(): void }) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<unknown>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { project } = await api<{ project: Project }>('/projects', { method: 'POST', body: { name, key, description } });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      onClose();
      navigate(`/projects/${project.key}/backlog`);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Modal
      title="Criar projeto"
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-subtle" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" form="create-project" disabled={!name || !key}>Criar</button>
        </>
      }
    >
      <form id="create-project" className="form" onSubmit={submit}>
        <Field label="Nome *">
          <input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!keyTouched) setKey(suggestKey(e.target.value));
            }}
            required
          />
        </Field>
        <Field label="Chave *" hint="Prefixo das issues, ex: GIRO-123. De 2 a 10 letras/números.">
          <input
            value={key}
            onChange={(e) => {
              setKeyTouched(true);
              setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
            }}
            maxLength={10}
            required
          />
        </Field>
        <Field label="Descrição">
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <ErrorText error={error} />
      </form>
    </Modal>
  );
}
