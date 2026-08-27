/** Returns a copy of `names` sorted by the requested mode.
 *  - `'name'` → alphabetical
 *  - `'mem'` → highest mem first (string-parsed)
 *  - any other (treated as `'errors'`) → highest error count first */
export function sortServiceNames(
  names: string[], sortMode: string,
  statsMap: Record<string, { cpu?: string; mem?: string }>,
  procState: Record<string, { errors?: number }>,
): string[] {
  if (sortMode === 'name') return names.slice().sort();
  return names.slice().sort((a, b) => {
    if (sortMode === 'mem') {
      return (parseFloat(statsMap[b]?.mem ?? '0') || 0) - (parseFloat(statsMap[a]?.mem ?? '0') || 0);
    }
    return (procState[b]?.errors ?? 0) - (procState[a]?.errors ?? 0);
  });
}

/** Converts cumulative CPU seconds into a percentage of wall-clock time
 *  elapsed since the previous sample. */
export function calcCpuPercent(totalCpuSec: number, prevCpu: number, prevTime: number): number {
  const elapsed = (Date.now() - prevTime) / 1000;
  const cpuDelta = totalCpuSec - prevCpu;
  return elapsed > 0 ? (cpuDelta / elapsed) * 100 : 0;
}

/** Hysteresis state machine for the "RAM pressure" banner.
 *  - turns on when usagePct ≥ highWatermark
 *  - turns off when usagePct < lowWatermark
 *  - stays as-is in the dead band between watermarks */
export function nextRamBannerVisibility(
  usagePct: number,
  previousVisible: boolean,
  highWatermark = 80,
  lowWatermark = 75,
): boolean {
  if (usagePct >= highWatermark) return true;
  if (usagePct < lowWatermark) return false;
  return previousVisible;
}

/** Which services `stats` should carry an entry for, and the pids to sample.
 *
 *  Shared because the daemon and the TUI each built this inline and the two
 *  have to agree — `devup` in the foreground and `devup up -d` answering the
 *  same RPC differently is the failure this kind of duplication produces.
 *
 *  A service with no process is **left out**, not seeded at zero. 0% CPU and
 *  0 MB is a measurement nobody took: a client cannot tell it apart from a
 *  service that is genuinely idle, every total it feeds is quietly wrong, and
 *  `docs/control-plane.md` promises absence for a remote service. Everything
 *  else starts at zero, because a service that is running but whose pid the
 *  platform could not sample this round is a different thing from one that has
 *  no pid to sample. */
export function seedServiceStats<T extends { pid: number | null; remote?: unknown }>(
  states: Iterable<[string, T]>,
): { services: Record<string, { cpu: number; memMB: number }>; pids: number[]; pidToName: Map<number, string> } {
  const services: Record<string, { cpu: number; memMB: number }> = {};
  const pids: number[] = [];
  const pidToName = new Map<number, string>();
  for (const [name, st] of states) {
    if (st.remote) continue;
    services[name] = { cpu: 0, memMB: 0 };
    if (st.pid) { pids.push(st.pid); pidToName.set(st.pid, name); }
  }
  return { services, pids, pidToName };
}

/** The `stats` result's service half, from a platform sample.
 *
 *  Shared for the same reason as `seedServiceStats`: the daemon and the TUI
 *  each built this inline, and two implementations of one RPC is how `devup
 *  ctl stats` comes to answer differently under `up -d` than under the TUI.
 *  The CPU baseline map is passed in because each host owns its own. */
export function computeServiceStats(
  services: Record<string, { cpu: number; memMB: number }>,
  raw: Map<number, { cpuSeconds: number; rss: number }>,
  pidToName: Map<number, string>,
  prevCpu: Map<string, { time: number; cpu: number }>,
  calcCpuPercent: (totalCpuSec: number, prevCpu: number, prevTime: number) => number,
): Record<string, { cpu: number; memMB: number }> {
  for (const [pid, data] of raw) {
    const name = pidToName.get(pid);
    if (!name) continue;
    const prev = prevCpu.get(name) ?? { time: Date.now(), cpu: 0 };
    const cpu = calcCpuPercent(data.cpuSeconds, prev.cpu, prev.time);
    prevCpu.set(name, { time: Date.now(), cpu: data.cpuSeconds });
    services[name] = { cpu: Math.round(cpu * 10) / 10, memMB: Math.round((data.rss / 1024) * 10) / 10 };
  }
  return services;
}

/** The `proxy` half of `status` / `info`.
 *
 *  `active` is a parameter because the two hosts answer it differently and one
 *  of them was wrong: the daemon gates on `--proxy`, while the TUI reported
 *  `active: true` regardless of its own `p` toggle — so turning proxy-file
 *  writing off left `info` and `status` still claiming it was on. */
export function buildProxyInfo(
  provider: { name: string } | null | undefined,
  opts: { domain: string; tls: boolean; routes: Record<string, string> } | null | undefined,
  active: boolean,
): { active: boolean; provider: string; domain: string; tls: boolean; routes: Record<string, string> } | null {
  if (!provider || !opts || !active) return null;
  return { active: true, provider: provider.name, domain: opts.domain, tls: opts.tls, routes: opts.routes };
}
