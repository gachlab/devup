/** "Is this stack ready?" — the question every harness re-answers badly.
 *
 *  Part of the public surface (`@gachlab/devup/client`), because the tricky
 *  half is knowing what the snapshot means, not writing a polling loop:
 *
 *  - A lazy service that nobody has asked for is **`idle`, not `down`**, and
 *    it is ready in the sense that matters — its proxy is listening and the
 *    first connection starts it. Polling its port for readiness is a false
 *    positive: the proxy answers whether or not the service is up.
 *  - `status: 'timeout'` is **not** terminal, and treating it as such caps
 *    every wait at the startup timeout — 45 s by default, well under the two
 *    minutes a cold front end can need. It only means the startup timer gave
 *    up first.
 *  - A crash fails the wait only once **nothing can bring it back**: crashed,
 *    out of restart budget, and with no attempt queued. All three, because
 *    `Restarter` raises `restarts` to the maximum *before* scheduling the last
 *    attempt — so the first two alone also describe a service that is eight
 *    seconds from recovering, and aborting there kills a run that was about to
 *    succeed.
 *  - Readiness is `health`, and the daemon computes that from the service's
 *    own `readyPattern` when it declares one — see `HealthPoller.checkAll`,
 *    which deliberately does not let a bare port probe speak for a service
 *    that said how it announces itself. */
import type { DevupClient } from './client.js';
import type { ServiceSnapshot, ProcessStatus, HealthStatus } from './types.js';
// One number, from the daemon's own definition of it — copying it here would
// be a second source of truth for how many times a service gets to crash.
import { MAX_RESTARTS } from '../process/internals.js';

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
  /** True when the caller's `signal` ended it. Neither ready nor timed out. */
  aborted: boolean;
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
  /** Give up early. Checked once per poll, so a Ctrl-C during a two-minute
   *  wait is acted on in well under a second rather than at the deadline.
   *  Structurally an `AbortSignal`, but anything with `aborted` will do. */
  signal?: { readonly aborted: boolean };
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
  if (svc.status === 'crashed') {
    const crashCount = `crashed ${svc.crashes} time${svc.crashes === 1 ? '' : 's'}`;
    // Still queued, so it is on its way back — whatever the budget says.
    if (svc.restartPendingIn != null) {
      return {
        readiness: 'waiting',
        reason: `${crashCount}, restarting in ${Math.round(svc.restartPendingIn / 1000)}s`,
      };
    }
    // Out of budget with nothing queued: the restarter is done with it, so
    // nothing can change and waiting out the clock only wastes the clock.
    if (svc.restarts >= MAX_RESTARTS) {
      return {
        readiness: 'failed',
        reason: `${crashCount} and will not be restarted again — see \`devup ctl logs ${svc.name}\``,
      };
    }
    return {
      readiness: 'waiting',
      reason: `${crashCount} — see \`devup ctl logs ${svc.name}\``,
    };
  }
  if (svc.status === 'timeout') {
    // Its startup timer gave up, not devup. The health poller keeps probing,
    // and a `readyPattern` can still land, so this is somewhere to wait — just
    // somewhere worth naming, since 45 s have already gone by.
    return {
      readiness: 'waiting',
      reason: `startup timeout elapsed on :${svc.port}, still watching`,
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

/** Thrown when a caller asks for a service the daemon does not have.
 *
 *  Its own type so a caller can tell it from the transport failures
 *  `waitForServices` can also raise — a dead socket is not a typo in a profile,
 *  and telling someone to fix their service selection when their daemon just
 *  died is worse than saying nothing. */
export class UnknownServicesError extends Error {
  constructor(message: string, readonly missing: string[], readonly running: string[]) {
    super(message);
    this.name = 'UnknownServicesError';
  }
}

/** Narrow a snapshot to the requested names, or throw naming what exists. */
export function selectServices(all: ServiceSnapshot[], wanted?: string[]): ServiceSnapshot[] {
  if (!wanted?.length) return all;
  const byName = new Map(all.map(s => [s.name, s]));
  const missing = wanted.filter(n => !byName.has(n));
  if (missing.length) {
    const running = all.map(s => s.name);
    throw new UnknownServicesError(
      `unknown service${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ` +
      `Running: ${running.join(', ') || '(none)'}`,
      missing, running,
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

  if (opts.start) await warmUp(client, first.services, wanted, deadline, now, opts.signal);

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
    const aborted = opts.signal?.aborted === true;
    if (!notReady.length || failedFast || aborted || now() >= deadline) {
      return {
        ok: notReady.length === 0,
        elapsedMs: now() - startedAt,
        services: rows,
        notReady,
        failedFast,
        aborted,
      };
    }

    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
    snapshot = (await client.status()).services;
  }
}

/** Start everything not already up, phase by phase. */
async function warmUp(
  client: DevupClient,
  snapshot: ServiceSnapshot[],
  wanted: string[],
  deadline: number,
  now: () => number,
  signal?: { readonly aborted: boolean },
): Promise<void> {
  const want = new Set(wanted);
  const todo = snapshot.filter(s => want.has(s.name) && s.health !== 'up').map(s => s.name);
  await forEachInPhaseOrder(snapshot, todo, async name => {
    // Failures are not raised here: `start` reporting false is one more
    // reading, and the poll that follows is the authority on whether the
    // service ended up serving. Losing the deadline to a hung start is the
    // risk worth guarding, so the remaining budget is the timeout.
    try { await client.start(name, { timeoutMs: Math.max(1, deadline - now()) }); }
    catch { /* the poll decides */ }
  }, () => now() >= deadline || signal?.aborted === true);
}

export interface PhaseResult<T> {
  name: string;
  value: T | null;
  error: Error | null;
}

/** Run `fn` over the named services in ascending config phase, concurrently
 *  within each phase.
 *
 *  The phase order is the only statement anyone has made about what needs
 *  what, so a batch that ignores it starts a phase-4 web before its phase-0
 *  API — which is how a warm-up turns into a crash loop. Concurrency inside a
 *  phase is the point: doing eight lazy services one at a time is most of the
 *  reason people write their own loop instead of using this.
 *
 *  Never rejects. Each entry carries its own outcome, because "six started and
 *  two did not" is the normal answer and the caller has to be able to say
 *  which two. */
export async function forEachInPhaseOrder<T>(
  snapshot: ServiceSnapshot[],
  names: string[],
  fn: (name: string) => Promise<T>,
  /** Checked between phases, to stop early. */
  stop?: () => boolean,
): Promise<Array<PhaseResult<T>>> {
  const phaseOf = new Map(snapshot.map(s => [s.name, s.phase]));
  const want = names.filter(n => phaseOf.has(n));
  const phases = [...new Set(want.map(n => phaseOf.get(n)!))].sort((a, b) => a - b);

  const results: Array<PhaseResult<T>> = [];
  for (const phase of phases) {
    if (stop?.()) break;
    const batch = want.filter(n => phaseOf.get(n) === phase);
    const settled = await Promise.all(batch.map(async name => {
      try { return { name, value: await fn(name), error: null }; }
      catch (e: any) { return { name, value: null, error: e instanceof Error ? e : new Error(String(e)) }; }
    }));
    results.push(...settled);
  }
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
