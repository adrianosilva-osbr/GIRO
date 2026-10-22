import { useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';

/*
 * Small hand-written SVG charts. Conventions (see the data-viz guidelines this follows):
 * 2px lines, bars <= 24px with a 4px rounded data-end, hairline solid gridlines,
 * text always in ink tokens (never the series color), a legend for 2+ series,
 * a hover layer on every chart, and a table view next to it.
 */

export const SERIES = ['var(--chart-1)', 'var(--chart-2)'] as const;

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Rounded axis maximum and ~4 evenly spaced ticks (0 / 5 / 10 / 15 …). */
export function niceTicks(max: number, target = 4) {
  if (max <= 0) return { max: 1, ticks: [0, 1] };
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return { max: top, ticks };
}

export const fmtNumber = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const fmtDay = (t: number) => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

export function Legend({ items }: { items: { label: string; color: string; kind?: 'line' | 'rect' | 'ref' }[] }) {
  return (
    <div className="chart-legend">
      {items.map((i) => (
        <span key={i.label} className="chart-legend-item">
          <span className={`chart-key chart-key-${i.kind ?? 'line'}`} style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  // Flip to the left of the pointer near the right edge so it never leaves the chart.
  const left = x > width - 200 ? undefined : x + 14;
  const right = x > width - 200 ? width - x + 14 : undefined;
  return (
    <div className="chart-tooltip" style={{ left, right, top: Math.max(0, y - 10) }} role="status">
      {children}
    </div>
  );
}

function TooltipRow({ color, label, value, kind = 'line' }: { color: string; label: string; value: string; kind?: 'line' | 'rect' | 'ref' }) {
  return (
    <div className="chart-tooltip-row">
      <span className={`chart-key chart-key-${kind}`} style={{ background: color }} />
      <b>{value}</b>
      <span className="muted">{label}</span>
    </div>
  );
}

export function DataTable({ summary, head, rows }: { summary: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <details className="chart-table">
      <summary>{summary}</summary>
      <table className="table">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className={typeof c === 'number' ? 'num' : ''}>{typeof c === 'number' ? fmtNumber(c) : c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

const M = { top: 12, right: 16, bottom: 28, left: 40 };

function GridY({ ticks, y, width }: { ticks: number[]; y: (v: number) => number; width: number }) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'chart-baseline' : 'chart-grid'} />
          <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="chart-tick">{fmtNumber(t)}</text>
        </g>
      ))}
    </g>
  );
}

// ---------------------------------------------------------------- Burndown

export interface BurnPoint {
  t: number;
  remaining: number;
  scope: number;
  change?: string;
}

/**
 * Step lines for remaining work and scope, plus the straight "ideal" guideline from the
 * commitment at the start to zero at the planned end.
 */
export function BurndownChart({
  points,
  start,
  end,
  committed,
  today,
  unit,
  height = 300,
}: {
  points: BurnPoint[];
  start: number;
  end: number;
  committed: number;
  today?: number;
  unit: string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ x: number; y: number; t: number } | null>(null);
  const tMax = Math.max(end, points[points.length - 1]?.t ?? end);
  const { max, ticks } = niceTicks(Math.max(committed, ...points.map((p) => Math.max(p.scope, p.remaining))));
  const x = (t: number) => M.left + ((t - start) / (tMax - start || 1)) * (width - M.left - M.right);
  const y = (v: number) => M.top + (1 - v / max) * (height - M.top - M.bottom);

  const step = (key: 'remaining' | 'scope') =>
    points.map((p, i) => (i === 0 ? `M${x(p.t)},${y(p[key])}` : `H${x(p.t)}V${y(p[key])}`)).join('');
  const valueAt = (t: number) => {
    let current = points[0];
    for (const p of points) if (p.t <= t) current = p;
    return current;
  };
  const idealAt = (t: number) => Math.max(0, committed * (1 - (t - start) / (end - start || 1)));

  // ~6 date ticks, one per day at most.
  const days = Math.max(1, Math.round((tMax - start) / 86_400_000));
  const every = Math.ceil(days / 6);
  const xTicks: number[] = [];
  for (let d = 0; d <= days; d += every) xTicks.push(start + d * 86_400_000);

  const onMove = (e: ReactPointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = Math.min(Math.max(e.clientX - box.left, M.left), width - M.right);
    const t = start + ((px - M.left) / (width - M.left - M.right)) * (tMax - start);
    setHover({ x: px, y: e.clientY - box.top, t });
  };
  const at = hover ? valueAt(hover.t) : null;
  const events = points.filter((p) => p.change);

  return (
    <div className="chart" ref={ref}>
      <Legend
        items={[
          { label: 'Restante', color: SERIES[0] },
          { label: 'Escopo', color: SERIES[1] },
          { label: 'Ideal', color: 'var(--chart-ref)', kind: 'ref' },
        ]}
      />
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Burndown em ${unit}`}>
          <GridY ticks={ticks} y={y} width={width} />
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={height - 8} textAnchor="middle" className="chart-tick">{fmtDay(t)}</text>
          ))}
          <line x1={x(end)} x2={x(end)} y1={M.top} y2={height - M.bottom} className="chart-grid" />
          {today !== undefined && today <= tMax && (
            <g>
              <line x1={x(today)} x2={x(today)} y1={M.top} y2={height - M.bottom} className="chart-today" />
              <text x={x(today)} y={M.top - 2} textAnchor="middle" className="chart-tick">Hoje</text>
            </g>
          )}
          <line x1={x(start)} y1={y(committed)} x2={x(end)} y2={y(0)} className="chart-ref-line" />
          <path d={step('scope')} className="chart-line" style={{ stroke: SERIES[1] }} />
          <path d={step('remaining')} className="chart-line" style={{ stroke: SERIES[0] }} />
          {events.map((p, i) => (
            <circle key={i} cx={x(p.t)} cy={y(p.remaining)} r={4} className="chart-dot" style={{ fill: SERIES[0] }} />
          ))}
          {hover && <line x1={hover.x} x2={hover.x} y1={M.top} y2={height - M.bottom} className="chart-crosshair" />}
          <rect
            x={M.left}
            y={0}
            width={Math.max(0, width - M.left - M.right)}
            height={height - M.bottom}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      )}
      {hover && at && (
        <Tooltip x={hover.x} y={hover.y} width={width}>
          <div className="chart-tooltip-title">{new Date(hover.t).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
          <TooltipRow color={SERIES[0]} label={`${unit} restantes`} value={fmtNumber(at.remaining)} />
          <TooltipRow color={SERIES[1]} label={`${unit} no escopo`} value={fmtNumber(at.scope)} />
          {hover.t <= end && <TooltipRow color="var(--chart-ref)" kind="ref" label="ideal" value={fmtNumber(Math.round(idealAt(hover.t) * 10) / 10)} />}
          {at.change && Math.abs(x(at.t) - hover.x) < 24 && <div className="chart-tooltip-note">{at.change}</div>}
        </Tooltip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Two daily lines

export function DailyLinesChart({
  days,
  series,
  height = 220,
}: {
  days: string[];
  series: { label: string; values: number[] }[];
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; y: number } | null>(null);
  const { max, ticks } = niceTicks(Math.max(1, ...series.flatMap((s) => s.values)));
  const step = (width - M.left - M.right) / Math.max(1, days.length - 1);
  const x = (i: number) => M.left + i * step;
  const y = (v: number) => M.top + (1 - v / max) * (height - M.top - M.bottom);
  const label = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

  const onMove = (e: ReactPointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const i = Math.round((e.clientX - box.left - M.left) / step);
    setHover({ i: Math.min(days.length - 1, Math.max(0, i)), y: e.clientY - box.top });
  };

  return (
    <div className="chart" ref={ref}>
      <Legend items={series.map((s, i) => ({ label: s.label, color: SERIES[i] }))} />
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={series.map((s) => s.label).join(' e ')}>
          <GridY ticks={ticks} y={y} width={width} />
          {days.map((d, i) => (i % 5 === 0 || i === days.length - 1 ? (
            <text key={d} x={x(i)} y={height - 8} textAnchor="middle" className="chart-tick">{label(d)}</text>
          ) : null))}
          {hover && <line x1={x(hover.i)} x2={x(hover.i)} y1={M.top} y2={height - M.bottom} className="chart-crosshair" />}
          {series.map((s, si) => (
            <path
              key={s.label}
              d={s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('')}
              className="chart-line"
              style={{ stroke: SERIES[si] }}
            />
          ))}
          {hover && series.map((s, si) => (
            <circle key={s.label} cx={x(hover.i)} cy={y(s.values[hover.i])} r={4} className="chart-dot" style={{ fill: SERIES[si] }} />
          ))}
          <rect x={M.left - step / 2} y={0} width={Math.max(0, width - M.left - M.right + step)} height={height - M.bottom} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {hover && (
        <Tooltip x={x(hover.i)} y={hover.y} width={width}>
          <div className="chart-tooltip-title">{new Date(`${days[hover.i]}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })}</div>
          {series.map((s, si) => <TooltipRow key={s.label} color={SERIES[si]} label={s.label.toLowerCase()} value={fmtNumber(s.values[hover.i])} />)}
        </Tooltip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Grouped columns

/** Rect with only the top corners rounded (data end), square at the baseline. */
function columnPath(x: number, y: number, w: number, h: number, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function GroupedColumns({
  groups,
  series,
  reference,
  height = 280,
}: {
  groups: { label: string; values: number[]; note?: string }[];
  series: string[];
  reference?: { label: string; value: number };
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const bottom = M.bottom + 14;
  const { max, ticks } = niceTicks(Math.max(1, reference?.value ?? 0, ...groups.flatMap((g) => g.values)));
  const band = (width - M.left - M.right) / Math.max(1, groups.length);
  const barW = Math.min(24, (band * 0.7 - 2 * (series.length - 1)) / series.length);
  const y = (v: number) => M.top + 12 + (1 - v / max) * (height - M.top - 12 - bottom);
  const groupX = (i: number) => M.left + i * band + (band - (barW * series.length + 2 * (series.length - 1))) / 2;

  return (
    <div className="chart" ref={ref}>
      <Legend items={[...series.map((s, i) => ({ label: s, color: SERIES[i], kind: 'rect' as const })), ...(reference ? [{ label: reference.label + ': ' + fmtNumber(reference.value), color: 'var(--chart-ref)', kind: 'ref' as const }] : [])]} />
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={series.join(' e ')}>
          <GridY ticks={ticks} y={y} width={width} />
          {groups.map((g, i) => {
            const gx = groupX(i);
            return (
              <g
                key={g.label}
                className={hover?.i === i ? 'chart-group hovered' : 'chart-group'}
                onPointerMove={(e) => {
                  const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  setHover({ i, x: e.clientX - box.left, y: e.clientY - box.top });
                }}
                onPointerLeave={() => setHover(null)}
              >
                <rect x={M.left + i * band} y={M.top} width={band} height={height - M.top - bottom} fill="transparent" />
                {g.values.map((v, si) => {
                  const bx = gx + si * (barW + 2);
                  return (
                    <g key={si}>
                      <path d={columnPath(bx, y(v), barW, y(0) - y(v))} style={{ fill: SERIES[si] }} />
                      <text x={bx + barW / 2} y={y(v) - 5} textAnchor="middle" className="chart-value">{fmtNumber(v)}</text>
                    </g>
                  );
                })}
                <text x={M.left + i * band + band / 2} y={height - bottom + 16} textAnchor="middle" className="chart-tick">{g.label}</text>
                {g.note && <text x={M.left + i * band + band / 2} y={height - bottom + 30} textAnchor="middle" className="chart-tick">{g.note}</text>}
              </g>
            );
          })}
          {reference && (
            <g>
              <line x1={M.left} x2={width - M.right} y1={y(reference.value)} y2={y(reference.value)} className="chart-ref-line" />
            </g>
          )}
        </svg>
      )}
      {hover && (
        <Tooltip x={hover.x} y={hover.y} width={width}>
          <div className="chart-tooltip-title">{groups[hover.i].label}{groups[hover.i].note ? ` (${groups[hover.i].note})` : ''}</div>
          {series.map((s, si) => <TooltipRow key={s} kind="rect" color={SERIES[si]} label={s.toLowerCase()} value={fmtNumber(groups[hover.i].values[si])} />)}
        </Tooltip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Horizontal bar list (one series)

export function BarList({ rows, total }: { rows: { key: string; label: ReactNode; value: number; title?: string }[]; total?: number }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="bar-list">
      {rows.map((r) => (
        <li key={r.key} title={r.title ?? `${r.value}${total ? ` de ${total} (${Math.round((r.value / total) * 100)}%)` : ''}`}>
          <span className="bar-list-label">{r.label}</span>
          <span className="bar-list-track">
            <span className="bar-list-bar" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="bar-list-value">
            {fmtNumber(r.value)}
            {total ? <span className="muted"> · {Math.round((r.value / total) * 100)}%</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
