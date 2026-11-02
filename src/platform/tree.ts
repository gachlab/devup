import type { ProcessStats } from './types.js';

export interface ProcessRow {
  pid: number;
  ppid: number;
  rss: number;        // KB
  cpuSeconds: number;
  /** Start time, any monotonic unit, when the platform reports it. */
  started?: number;
}

/** Stats for each root pid, summed over its whole process tree.
 *
 *  A service is rarely one process: `cmd: 'npm'` or `npx` is a wrapper around
 *  the real server, and on Windows a shim runs under `cmd.exe`. Sampling only
 *  the root measured the wrapper — a few MB — while the server beneath it used
 *  the memory. Roots with no row are absent from the result, the same as a
 *  pid the platform could not see. */
export function sumProcessTrees(rows: ProcessRow[], roots: number[]): Map<number, ProcessStats> {
  const children = new Map<number, ProcessRow[]>();
  const byPid = new Map<number, ProcessRow>();
  for (const r of rows) {
    byPid.set(r.pid, r);
    const list = children.get(r.ppid);
    if (list) list.push(r); else children.set(r.ppid, [r]);
  }
  const out = new Map<number, ProcessStats>();
  for (const root of roots) {
    const top = byPid.get(root);
    if (!top) continue;
    let rss = 0, cpuSeconds = 0;
    const seen = new Set<number>();
    const stack = [top];
    while (stack.length) {
      const r = stack.pop()!;
      // A recycled pid can make a parent link point back up the tree.
      if (seen.has(r.pid)) continue;
      seen.add(r.pid);
      rss += r.rss;
      cpuSeconds += r.cpuSeconds;
      for (const c of children.get(r.pid) ?? []) {
        if (c.pid === r.pid) continue;
        // A "child" older than its parent is a stale link to a recycled pid
        // (Windows never updates ParentProcessId), not a child.
        if (c.started !== undefined && r.started !== undefined && c.started < r.started) continue;
        stack.push(c);
      }
    }
    out.set(root, { rss, cpuSeconds });
  }
  return out;
}

/** `ps` TIME: `[DD-]HH:MM:SS`, `MM:SS` or `M:SS.ss` (macOS). The day prefix
 *  used to parse as NaN, so a service up for a day reported NaN CPU. */
export function parsePsTime(time: string): number {
  let days = 0;
  let rest = time.trim();
  const dash = rest.indexOf('-');
  if (dash !== -1) { days = Number(rest.slice(0, dash)); rest = rest.slice(dash + 1); }
  const parts = rest.split(':').map(Number);
  if (parts.some(n => Number.isNaN(n)) || Number.isNaN(days)) return 0;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return days * 86_400 + secs;
}
