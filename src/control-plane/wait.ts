/** "Is this stack ready?" — the question every harness re-answers badly.
 *
 *  Part of the public surface (`@gachlab/devup/client`), because the tricky
 *  half is knowing what the snapshot means, not writing a polling loop:
 *
 *  - A lazy service that nobody has asked for is **`idle`, not `down`**, and
 *    it is ready in the sense that matters — its proxy is listening and the
 *    first connection starts it. Polling its port for readiness is a false
 *    positive: the proxy answers whether or not the service is up.
 *  - A service in `timeout` never recovers on its own. The health poller skips
 *    that status outright, so waiting out the clock on one only wastes the
 *    clock.
 *  - Readiness is `health`, not `type`. A web with a `readyPattern` announces
 *    itself exactly like an API does. */
import type { DevupClient } from './client.js';
import type { ServiceSnapshot, ProcessStatus, HealthStatus } from './types.js';

/** How long `waitForServices` waits when the caller says nothing. Generous on
 *  purpose: a cold `ng serve` is the slowest thing in a typical stack. */
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 500;

export type Readiness = 'ready' | 'waiting' | 'failed';

export interface WaitServiceResult {
  name: string;
  readiness: Readiness;
  status: ProcessStatus;
  health: HealthStatus;
  /** ms from the start of the wait to the moment it first read as ready.
   *  `null` if it never did. */
  readyAfterMs: number | null;
  /** Present when `readiness` is not `ready`: what the daemon is reporting. */
  reason?: string;
}

export interface WaitResult {
  ok: boolean;
  elapsedMs: number;
  /** Every selected service, in the order the daemon reported them. */
  services: WaitServiceResult[];
  /** The ones that were not ready — empty when `ok`. */
  notReady: WaitServiceResult[];
  /** True when the wait ended because a service reached a state it cannot
   *  leave, rather than because the clock ran out. */
  failedFast: boolean;
}

export interface WaitOptions {
  /** Only these services. Default: every service the daemon reports.
   *  An unknown name throws rather than waiting for something that cannot
   *  arrive. */
  services?: string[];
  /** Start anything not already up before waiting, in ascending phase order,
   *  and then require `up` rather than accepting `idle`.
   *
   *  This is the difference between "the stack will serve" and "the stack will
   *  serve *now*": without it the first request to a lazy service pays its
   *  cold start, which is how a suite with a 10 s action timeout fails on its
   *  first test and passes on the retry. */
  start?: boolean;
  timeoutMs?: number;
  intervalMs?: number;
  /** Called the first time each service settles, ready or failed. */
  onSettled?: (svc: WaitServiceResult) => void;
  /** Testing seam. */
  now?: () => number;
}

/** Where one service stands, given what "ready" means for this wait.
 *
 *  Pure, and the only place the policy lives. */
export function classify(svc: ServiceSnapshot, requireUp: boolean): { readiness: Readiness; reason?: string } {
  if (svc.health === 'up') return { readiness: 'ready' };
  if (svc.status === 'timeout') {
    return {
      readiness: 'failed',
      reason: `never became healthy on :${svc.port} and will not be probed again`,
    };
  }
  if (svc.status === 'idle') {
    // Lazy and asleep. Its proxy holds `originalPort`, so the stack serves —
    // the first request just pays the start. `--start` is how you ask for that
    // to have happened already.
    return requireUp
      ? { readiness: 'waiting', reason: 'lazy, not started yet' }
      : { readiness: 'ready' };
  }
  return { readiness: 'waiting', reason: `${svc.status}/${svc.health}` };
}

/** Narrow a snapshot to the requested names, or throw naming what exists. */
export function selectServices(all: ServiceSnapshot[], wanted?: string[]): ServiceSnapshot[] {
  if (!wanted?.length) return all;
  const byName = new Map(all.map(s => [s.name, s]));
  const missing = wanted.filter(n => !byName.has(n));
  if (missing.length) {
    throw new Error(
      `unknown service${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ` +
      `Running: ${all.map(s => s.name).join(', ') || '(none)'}`,
    );
  }
  return wanted.map(n => byName.get(n)!);
}

export async function waitForServices(client: DevupClient, opts: WaitOptions = {}): Promise<WaitResult> {
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const requireUp = opts.start === true;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;

  const first = await client.status();
  const wanted = selectServices(first.services, opts.services).map(s => s.name);

  if (opts.start) await warmUp(client, first.services, wanted, deadline, now);

  const readyAt = new Map<string, number>();
  const settled = new Set<string>();
  let snapshot = opts.start ? (await client.status()).services : first.services;

  for (;;) {
    const rows: WaitServiceResult[] = [];
    const byName = new Map(snapshot.map(s => [s.name, s]));
    let failedFast = false;

    for (const name of wanted) {
      const svc = byName.get(name);
      if (!svc) {
        // A config reload dropped it mid-wait. Waiting for a service the
        // daemon no longer has is waiting for ever.
        rows.push({
          name, readiness: 'failed', status: 'stopped', health: 'down',
          readyAfterMs: null, reason: 'no longer in the running set',
        });
        failedFast = true;
        continue;
      }
      const { readiness, reason } = classify(svc, requireUp);
      if (readiness === 'ready' && !readyAt.has(name)) readyAt.set(name, now() - startedAt);
      if (readiness === 'failed') failedFast = true;
      const row: WaitServiceResult = {
        name, readiness, status: svc.status, health: svc.health,
        readyAfterMs: readyAt.get(name) ?? null,
        ...(reason ? { reason } : {}),
      };
      rows.push(row);
      if (readiness !== 'waiting' && !settled.has(name)) {
        settled.add(name);
        opts.onSettled?.(row);
      }
    }

    const notReady = rows.filter(r => r.readiness !== 'ready');
    if (!notReady.length || failedFast || now() >= deadline) {
      return {
        ok: notReady.length === 0,
        elapsedMs: now() - startedAt,
        services: rows,
        notReady,
        failedFast,
      };
    }

    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
    snapshot = (await client.status()).services;
  }
}

/** Start everything not already up, phase by phase.
 *
 *  Ascending phase order, parallel within a phase: the config's own ordering
 *  is the only statement anyone has made about what needs what, and warming
 *  eight lazy services one at a time is most of the reason people write their
 *  own loop instead. */
async function warmUp(
  client: DevupClient,
  snapshot: ServiceSnapshot[],
  wanted: string[],
  deadline: number,
  now: () => number,
): Promise<void> {
  const want = new Set(wanted);
  const todo = snapshot.filter(s => want.has(s.name) && s.health !== 'up');
  const phases = [...new Set(todo.map(s => s.phase))].sort((a, b) => a - b);

  for (const phase of phases) {
    if (now() >= deadline) return;
    const batch = todo.filter(s => s.phase === phase);
    await Promise.all(batch.map(async s => {
      // Failures are not raised here: `start` reporting false is one more
      // reading, and the poll below is the authority on whether the service
      // ended up serving. Losing the deadline to a hung start is the risk
      // worth guarding, so the remaining budget is the timeout.
      try { await client.start(s.name, { timeoutMs: Math.max(1, deadline - now()) }); }
      catch { /* the poll decides */ }
    }));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
