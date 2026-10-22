import { Link } from 'react-router-dom';
import { useMe } from '../auth';
import { useIssues, useProjects } from '../hooks';
import { IssueTable } from './IssueSearchPage';
import { EmptyState, Spinner } from '../components/ui';

export function HomePage() {
  const me = useMe();
  const { data: projects = [], isLoading } = useProjects();
  const assigned = useIssues({ assignee: 'me', status: 'TODO,IN_PROGRESS,IN_REVIEW', sort: 'priority' });
  const recent = useIssues({ reporter: 'me', sort: 'updated', limit: '8' });

  return (
    <div className="page">
      <h1 className="page-title">Olá, {me.name.split(' ')[0]}</h1>

      <section className="home-section">
        <div className="row space-between">
          <h2>Projetos</h2>
          <Link to="/projects">Ver todos</Link>
        </div>
        {isLoading ? (
          <Spinner />
        ) : projects.length === 0 ? (
          <EmptyState title="Você ainda não participa de nenhum projeto">
            <Link to="/projects">Crie seu primeiro projeto</Link>
          </EmptyState>
        ) : (
          <div className="project-cards">
            {projects.slice(0, 6).map((p) => (
              <Link key={p.id} to={`/projects/${p.key}/board`} className="project-card">
                <div className="project-avatar">{p.key.slice(0, 2)}</div>
                <div>
                  <b>{p.name}</b>
                  <div className="muted small">{p.key} · {p._count?.issues ?? 0} issues</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="home-section">
        <h2>Atribuídas a mim</h2>
        {assigned.isLoading ? (
          <Spinner />
        ) : assigned.data?.length ? (
          <IssueTable issues={assigned.data} showProject />
        ) : (
          <EmptyState title="Nada pendente com você 🎉" />
        )}
      </section>

      <section className="home-section">
        <h2>Criadas por mim recentemente</h2>
        {recent.data?.length ? <IssueTable issues={recent.data} showProject /> : <p className="muted">Nenhuma issue.</p>}
      </section>
    </div>
  );
}
