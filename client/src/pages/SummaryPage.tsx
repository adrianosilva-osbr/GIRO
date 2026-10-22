import { Link, useOutletContext } from 'react-router-dom';
import { PRIORITIES, PRIORITY_LABEL, TYPES, TYPE_LABEL, formatDate, timeAgo } from '../constants';
import { useOpenIssue, useSummary } from '../hooks';
import type { Project } from '../types';
import { BarList, DailyLinesChart, DataTable } from '../components/charts';
import { IssueTypeIcon, PriorityIcon } from '../components/Icons';
import { Avatar, Spinner, StatusLozenge } from '../components/ui';

export function SummaryPage() {
  const project = useOutletContext<Project>();
  const { data, isLoading, isFetching } = useSummary(project.key);
  const openIssue = useOpenIssue();

  if (isLoading || !data) return <div className="page-center"><Spinner /></div>;
  const { totals } = data;
  const filtersLink = (params: string) => `/projects/${project.key}/issues?${params}`;

  return (
    <div className={`page summary-page ${isFetching ? 'refreshing' : ''}`}>
      <div className="page-header">
        <div>
          <div className="breadcrumbs muted small">Projetos / {project.name}</div>
          <h1 className="page-title">Resumo</h1>
          {project.description && <div className="muted">{project.description}</div>}
        </div>
      </div>

      <div className="stat-tiles">
        <StatTile label="Concluídas nos últimos 7 dias" value={totals.resolvedLast7} />
        <StatTile label="Atualizadas nos últimos 7 dias" value={totals.updatedLast7} />
        <StatTile label="Criadas nos últimos 7 dias" value={totals.createdLast7} />
        <StatTile
          label="Vencidas"
          value={totals.overdue}
          tone={totals.overdue ? 'critical' : undefined}
          hint={totals.dueSoon ? `${totals.dueSoon} vencem nos próximos 7 dias` : 'Nenhuma vence nos próximos 7 dias'}
        />
      </div>

      <div className="summary-grid">
        <section className="card-panel wide">
          <h2>Criadas x concluídas</h2>
          <p className="muted small">Issues por dia nos últimos 30 dias</p>
          <DailyLinesChart
            days={data.createdVsResolved.map((d) => d.day)}
            series={[
              { label: 'Criadas', values: data.createdVsResolved.map((d) => d.created) },
              { label: 'Concluídas', values: data.createdVsResolved.map((d) => d.resolved) },
            ]}
          />
          <DataTable
            summary="Ver dados em tabela"
            head={['Dia', 'Criadas', 'Concluídas']}
            rows={data.createdVsResolved.map((d) => [formatDate(d.day), d.created, d.resolved])}
          />
        </section>

        <section className="card-panel">
          <h2>Visão de status</h2>
          <p className="muted small">{totals.all} issues no total, {totals.open} em aberto</p>
          <BarList
            total={totals.all}
            rows={data.byStatus.map((s) => ({
              key: s.key,
              label: <Link to={filtersLink(`status=${s.key}`)}><StatusLozenge status={s} /></Link>,
              value: s.count,
              title: s.name,
            }))}
          />
        </section>

        <section className="card-panel">
          <h2>Carga de trabalho</h2>
          <p className="muted small">Issues em aberto por responsável</p>
          <BarList
            total={totals.open}
            rows={data.workload.map((w) => ({
              key: w.user?.id ?? 'none',
              label: (
                <Link className="row gap-sm" to={filtersLink(`assignee=${w.user?.id ?? 'unassigned'}&category=TODO,IN_PROGRESS`)}>
                  <Avatar user={w.user} size={20} /> {w.user?.name ?? 'Não atribuído'}
                </Link>
              ),
              value: w.open,
            }))}
          />
        </section>

        <section className="card-panel">
          <h2>Prioridades</h2>
          <BarList
            rows={PRIORITIES.map((p) => ({
              key: p,
              label: <span className="row gap-sm"><PriorityIcon priority={p} /> {PRIORITY_LABEL[p]}</span>,
              value: data.byPriority[p] ?? 0,
            }))}
            total={totals.all}
          />
        </section>

        <section className="card-panel">
          <h2>Tipos de issue</h2>
          <BarList
            rows={TYPES.map((t) => ({
              key: t,
              label: <span className="row gap-sm"><IssueTypeIcon type={t} /> {TYPE_LABEL[t]}</span>,
              value: data.byType[t] ?? 0,
            }))}
            total={totals.all}
          />
        </section>

        <section className="card-panel">
          <h2>Progresso dos épicos</h2>
          {data.epics.length === 0 && <p className="muted">Nenhum épico neste projeto.</p>}
          <ul className="epic-progress">
            {data.epics.map((e) => {
              const pct = e.total ? Math.round((e.done / e.total) * 100) : 0;
              return (
                <li key={e.id} onClick={() => openIssue(e.key)} title={`${e.done} de ${e.total} issues concluídas · ${e.donePoints} de ${e.points} pontos`}>
                  <div className="row space-between">
                    <span className="row gap-sm"><IssueTypeIcon type="EPIC" /> {e.title}</span>
                    <span className="muted small">{e.total ? `${pct}%` : 'sem issues'}</span>
                  </div>
                  <div className="meter"><div className="meter-fill" style={{ width: `${pct}%` }} /></div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="card-panel">
          <h2>Atividade recente</h2>
          <ul className="activity-feed">
            {data.recent.map((a) => (
              <li key={a.id}>
                <Avatar user={a.user} size={24} />
                <div>
                  <b>{a.user.name}</b> {describeActivity(a.action, a.field)}{' '}
                  <button className="link" onClick={() => openIssue(a.issue.key)}>{a.issue.key}</button>
                  <span className="muted"> · {a.issue.title}</span>
                  <div className="muted small">{timeAgo(a.createdAt)}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function describeActivity(action: string, field: string | null) {
  if (action === 'created') return 'criou';
  if (action === 'commented') return 'comentou em';
  const what: Record<string, string> = {
    status: 'mudou o status de',
    assignee: 'mudou o responsável de',
    attachment: 'mexeu nos anexos de',
    link: 'mexeu nos vínculos de',
    sprint: 'mudou a sprint de',
  };
  return what[field ?? ''] ?? 'atualizou';
}

function StatTile({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: 'critical' }) {
  return (
    <div className={`stat-tile ${tone ? `tone-${tone}` : ''}`}>
      <div className="stat-label">
        {tone === 'critical' && <span aria-hidden="true">⚠ </span>}
        {label}
      </div>
      <div className="stat-value">{value.toLocaleString('pt-BR')}</div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  );
}
