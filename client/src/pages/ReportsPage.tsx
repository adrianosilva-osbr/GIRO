import { useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { daysLeft, formatDate, formatDateTime } from '../constants';
import { useOpenIssue, useSprintReport, useSprints, useVelocity } from '../hooks';
import type { Project, ReportIssue, SprintReport } from '../types';
import { BurndownChart, DataTable, GroupedColumns, fmtNumber, type BurnPoint } from '../components/charts';
import { IssueTypeIcon, PriorityIcon } from '../components/Icons';
import { Avatar, EmptyState, Spinner, StatusLozenge } from '../components/ui';

type Metric = 'points' | 'count';

const CHANGE_LABEL: Record<string, string> = {
  added: 'adicionada à sprint',
  removed: 'removida da sprint',
  done: 'concluída',
  reopened: 'reaberta',
  points: 'pontos alterados',
};

export function ReportsPage() {
  const project = useOutletContext<Project>();
  const [params, setParams] = useSearchParams();
  const tab = params.get('report') === 'velocity' ? 'velocity' : 'burndown';
  const [metric, setMetric] = useState<Metric>('points');

  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    next.set('report', t);
    setParams(next, { replace: true });
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumbs muted small">Projetos / {project.name}</div>
          <h1 className="page-title">Relatórios</h1>
        </div>
      </div>
      <div className="toolbar">
        <div className="tabs">
          <button className={tab === 'burndown' ? 'active' : ''} onClick={() => setTab('burndown')}>Burndown da sprint</button>
          <button className={tab === 'velocity' ? 'active' : ''} onClick={() => setTab('velocity')}>Velocidade</button>
        </div>
        <div className="spacer" />
        <div className="segmented" role="group" aria-label="Medida">
          <button className={metric === 'points' ? 'active' : ''} onClick={() => setMetric('points')}>Story points</button>
          <button className={metric === 'count' ? 'active' : ''} onClick={() => setMetric('count')}>Quantidade de issues</button>
        </div>
      </div>
      {tab === 'burndown' ? <Burndown project={project} metric={metric} /> : <VelocityReport project={project} metric={metric} />}
    </div>
  );
}

function Burndown({ project, metric }: { project: Project; metric: Metric }) {
  const [params, setParams] = useSearchParams();
  const { data: sprints = [], isLoading } = useSprints(project.key, true);
  const started = sprints
    .filter((s) => s.status !== 'PLANNED')
    .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''));
  const sprintId = params.get('sprint') ?? started[0]?.id;
  const { data: report, isLoading: loadingReport, isFetching } = useSprintReport(sprintId);

  if (isLoading) return <Spinner />;
  if (!started.length) {
    return <EmptyState title="Nenhuma sprint iniciada ainda">Inicie uma sprint no backlog para acompanhar o burndown.</EmptyState>;
  }

  return (
    <div className={isFetching ? 'refreshing' : ''}>
      <div className="toolbar">
        <select
          value={sprintId}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            next.set('sprint', e.target.value);
            setParams(next, { replace: true });
          }}
          aria-label="Sprint"
        >
          {started.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} {s.status === 'ACTIVE' ? '(ativa)' : `(encerrada em ${formatDate(s.completedAt)})`}
            </option>
          ))}
        </select>
      </div>
      {loadingReport || !report ? <Spinner /> : <BurndownBody report={report} metric={metric} />}
    </div>
  );
}

function BurndownBody({ report, metric }: { report: SprintReport; metric: Metric }) {
  const unit = metric === 'points' ? 'pontos' : 'issues';
  const pick = (t: { remainingPoints: number; scopePoints: number; remainingCount: number; scopeCount: number }) =>
    metric === 'points' ? { remaining: t.remainingPoints, scope: t.scopePoints } : { remaining: t.remainingCount, scope: t.scopeCount };
  const points: BurnPoint[] = report.series.map((p) => ({
    t: new Date(p.at).getTime(),
    ...pick(p),
    change: p.change ? `${p.change.issueKey} ${CHANGE_LABEL[p.change.type] ?? p.change.type}` : undefined,
  }));
  const committed = pick(report.committed).scope;
  const final = pick(report.final);
  const start = new Date(report.start).getTime();
  const end = report.end ? new Date(report.end).getTime() : new Date(report.finish).getTime();
  const active = report.sprint.status === 'ACTIVE';
  const left = daysLeft(report.end);
  const noPoints = metric === 'points' && report.committed.scopePoints === 0 && report.final.scopePoints === 0;

  return (
    <>
      <div className="stat-tiles">
        <Tile label="Compromisso inicial" value={committed} unit={unit} />
        <Tile label={active ? 'Escopo atual' : 'Escopo final'} value={final.scope} unit={unit} hint={final.scope !== committed ? `${final.scope > committed ? '+' : ''}${fmtNumber(final.scope - committed)} desde o início` : 'sem mudanças de escopo'} />
        <Tile label="Concluído" value={final.scope - final.remaining} unit={unit} />
        <Tile
          label={active ? 'Restante' : 'Não concluído'}
          value={final.remaining}
          unit={unit}
          hint={active && left !== null ? (left >= 0 ? `${left} dia(s) para o fim` : `sprint atrasada ${-left} dia(s)`) : undefined}
        />
      </div>

      <section className="card-panel">
        <div className="row space-between">
          <h2>{report.sprint.name}</h2>
          <span className="muted small">
            {formatDate(report.start)} – {report.end ? formatDate(report.end) : 'sem data de fim'}
            {report.sprint.completedAt && ` · encerrada em ${formatDate(report.sprint.completedAt)}`}
          </span>
        </div>
        {report.sprint.goal && <p className="muted">{report.sprint.goal}</p>}
        {noPoints && <p className="notice">As issues desta sprint não têm story points. Use a medida “Quantidade de issues”.</p>}
        {report.synthetic && (
          <p className="notice">
            Esta sprint começou antes do registro de histórico, então o gráfico é uma aproximação baseada nas datas de conclusão.
          </p>
        )}
        <BurndownChart points={points} start={start} end={end} committed={committed} today={active ? Date.now() : undefined} unit={unit} />
        <DataTable
          summary="Ver dados em tabela"
          head={['Quando', 'Mudança', 'Escopo', 'Restante']}
          rows={points.map((p, i) => [
            formatDateTime(new Date(p.t).toISOString()),
            p.change ?? (i === 0 ? 'Início (compromisso)' : 'Hoje / fim'),
            p.scope,
            p.remaining,
          ])}
        />
      </section>

      <IssueSection title="Issues concluídas" issues={report.issues.completed} metric={metric} />
      <IssueSection title={active ? 'Issues em andamento' : 'Issues não concluídas'} issues={report.issues.notCompleted} metric={metric} />
      <IssueSection title="Removidas da sprint" issues={report.issues.removed} metric={metric} />
      {[...report.issues.completed, ...report.issues.notCompleted].some((i) => i.addedAfterStart) && (
        <p className="muted small">* Adicionada depois do início da sprint.</p>
      )}
    </>
  );
}

function Tile({ label, value, unit, hint }: { label: string; value: number; unit: string; hint?: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {fmtNumber(value)} <span className="stat-unit">{unit}</span>
      </div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  );
}

function IssueSection({ title, issues, metric }: { title: string; issues: ReportIssue[]; metric: Metric }) {
  const openIssue = useOpenIssue();
  if (!issues.length) return null;
  const points = issues.reduce((s, i) => s + i.points, 0);
  return (
    <section className="card-panel">
      <h2>
        {title} <span className="muted">({issues.length}{metric === 'points' ? ` · ${points} pontos` : ''})</span>
      </h2>
      <table className="table issue-table">
        <thead>
          <tr>
            <th style={{ width: 36 }}>Tipo</th>
            <th style={{ width: 100 }}>Chave</th>
            <th>Resumo</th>
            <th>Status atual</th>
            <th style={{ width: 40 }}>P</th>
            <th>Responsável</th>
            <th className="num">Pontos</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((i) => (
            <tr key={i.id} className={i.deleted ? '' : 'clickable'} onClick={() => !i.deleted && openIssue(i.key)}>
              <td><IssueTypeIcon type={i.type} /></td>
              <td className="key">{i.key}{i.addedAfterStart && ' *'}</td>
              <td>{i.title}</td>
              <td>{!i.deleted && <StatusLozenge status={i.statusRef} />}</td>
              <td>{!i.deleted && <PriorityIcon priority={i.priority} />}</td>
              <td><span className="row gap-sm"><Avatar user={i.assignee} size={22} /> {i.assignee?.name ?? <span className="muted">Não atribuído</span>}</span></td>
              <td className="num">{i.points || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function VelocityReport({ project, metric }: { project: Project; metric: Metric }) {
  const { data, isLoading, isFetching } = useVelocity(project.key);
  if (isLoading || !data) return <Spinner />;
  if (!data.sprints.length) {
    return <EmptyState title="Ainda não há sprints para comparar">A velocidade aparece depois que a primeira sprint é iniciada.</EmptyState>;
  }
  const unit = metric === 'points' ? 'pontos' : 'issues';
  const avg = metric === 'points' ? data.averagePoints : data.averageCount;
  const groups = data.sprints.map((s) => ({
    label: s.name.replace(`${project.key} `, ''),
    note: s.status === 'ACTIVE' ? 'em andamento' : undefined,
    values: metric === 'points' ? [s.committedPoints, s.completedPoints] : [s.committedCount, s.completedCount],
  }));

  return (
    <div className={isFetching ? 'refreshing' : ''}>
      <div className="stat-tiles">
        <div className="stat-tile">
          <div className="stat-label">Velocidade média</div>
          <div className="stat-value">{avg !== null ? fmtNumber(avg) : '—'} <span className="stat-unit">{unit} por sprint</span></div>
          <div className="muted small">Média das últimas {data.sprints.filter((s) => s.status === 'CLOSED').length} sprints encerradas</div>
        </div>
      </div>
      <section className="card-panel">
        <h2>Comprometido x concluído por sprint</h2>
        <p className="muted small">Compromisso = o que estava na sprint quando ela começou. Concluído = o que terminou até o encerramento.</p>
        <GroupedColumns
          groups={groups}
          series={['Comprometido', 'Concluído']}
          reference={avg !== null ? { label: 'Média concluída', value: avg } : undefined}
        />
        <DataTable
          summary="Ver dados em tabela"
          head={['Sprint', 'Início', 'Comprometido', 'Concluído', '% entregue']}
          rows={data.sprints.map((s) => {
            const c = metric === 'points' ? s.committedPoints : s.committedCount;
            const d = metric === 'points' ? s.completedPoints : s.completedCount;
            return [s.name + (s.status === 'ACTIVE' ? ' (em andamento)' : ''), formatDate(s.startDate), c, d, c ? `${Math.round((d / c) * 100)}%` : '—'];
          })}
        />
      </section>
    </div>
  );
}
