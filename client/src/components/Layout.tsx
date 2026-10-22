import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Navigate, Outlet, useMatch, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth, useMe } from '../auth';
import { useProject } from '../hooks';
import { Icon, Logo } from './Icons';
import { Avatar, EmptyState, Spinner } from './ui';
import { CreateIssueProvider, useCreateIssue } from './CreateIssue';
import { IssueDetailModal } from './IssueDetail';

/** Shell for every logged-in page: top navigation, global "Criar" modal and the issue modal. */
export function AppLayout() {
  const { user, loading } = useAuth();
  if (loading) return <div className="page-center"><Spinner /></div>;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <CreateIssueProvider>
      <TopNav />
      <div className="app-body">
        <Outlet />
      </div>
      <IssueModalHost />
    </CreateIssueProvider>
  );
}

function IssueModalHost() {
  const [params] = useSearchParams();
  const key = params.get('issue');
  return key ? <IssueDetailModal key={key} issueKey={key} /> : null;
}

function TopNav() {
  const me = useMe();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const openCreate = useCreateIssue();
  // TopNav sits outside the project route, so read the key from the URL directly.
  const key = useMatch('/projects/:key/*')?.params.key;
  const [q, setQ] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenuOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const search = (e: FormEvent) => {
    e.preventDefault();
    navigate(`/filters?q=${encodeURIComponent(q)}`);
  };

  return (
    <header className="topnav">
      <Link to="/" className="brand">
        <Logo /> <span>GIRO</span>
      </Link>
      <nav className="topnav-links">
        <NavLink to="/" end>Seu trabalho</NavLink>
        <NavLink to="/projects">Projetos</NavLink>
        <NavLink to="/filters">Filtros</NavLink>
      </nav>
      <button className="btn btn-primary" onClick={() => openCreate({ projectKey: key })}>
        <Icon name="plus" /> Criar
      </button>
      <div className="spacer" />
      <form onSubmit={search} className="search-box">
        <Icon name="search" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Pesquisar issues" aria-label="Pesquisar issues" />
      </form>
      <div className="user-menu" ref={menuRef}>
        <button className="btn-icon" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu do usuário">
          <Avatar user={me} size={30} />
        </button>
        {menuOpen && (
          <div className="dropdown">
            <div className="dropdown-header">
              <b>{me.name}</b>
              <div className="muted small">{me.email}</div>
            </div>
            <button onClick={logout}>
              <Icon name="logout" /> Sair
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

export function ProjectLayout() {
  const { key } = useParams();
  const { data: project, error, isLoading } = useProject(key);

  if (isLoading) return <div className="page-center"><Spinner /></div>;
  if (error || !project) {
    return (
      <EmptyState title="Projeto indisponível">
        {error?.message} <Link to="/projects">Ver projetos</Link>
      </EmptyState>
    );
  }

  return (
    <div className="project-shell">
      <aside className="sidebar">
        <div className="sidebar-project">
          <div className="project-avatar">{project.key.slice(0, 2)}</div>
          <div>
            <div className="sidebar-project-name">{project.name}</div>
            <div className="muted small">Projeto de software</div>
          </div>
        </div>
        <div className="sidebar-section">PLANEJAMENTO</div>
        <NavLink to="backlog"><Icon name="backlog" /> Backlog</NavLink>
        <NavLink to="board"><Icon name="board" /> Quadro</NavLink>
        <NavLink to="issues"><Icon name="list" /> Issues</NavLink>
        <div className="sidebar-section">PROJETO</div>
        <NavLink to="settings"><Icon name="settings" /> Configurações</NavLink>
      </aside>
      <main className="project-main">
        <Outlet context={project} />
      </main>
    </div>
  );
}
