/*
 * Jira-style durations (same rules as the server): "1w 2d 3h 30m", 1d = 8h, 1w = 5d.
 * A bare number means hours ("2" = 2h, "1,5" = 1h 30m).
 */

const MINUTES = { w: 5 * 8 * 60, d: 8 * 60, h: 60, m: 1 } as const;

export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replace(',', '.');
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60);
  let total = 0;
  let rest = s;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*([wdhm])/g)) {
    total += Number(m[1]) * MINUTES[m[2] as keyof typeof MINUTES];
    rest = rest.replace(m[0], '');
  }
  return rest.trim() ? null : Math.round(total);
}

export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null) return '';
  if (minutes === 0) return '0m';
  const parts: string[] = [];
  let left = minutes;
  for (const [unit, size] of Object.entries(MINUTES)) {
    const n = Math.floor(left / size);
    if (n) parts.push(`${n}${unit}`);
    left -= n * size;
  }
  return parts.join(' ');
}
