import type { ProcessState } from './types.js';
import type { ServiceConfig } from '../config/types.js';
import { isRunning, waitForExit } from './liveness.js';
import { waitForPort } from './health.js';
import { startsSuspended } from '../utils/process-args.js';
import type { StartResult } from '../control-plane/types.js';

/** How long to let a service finish a graceful shutdown before giving up. */
const STOP_GRACE_MS = 5_000;
/** Matches what `bootNormal` allows an API to become reachable. */
const READY_TIMEOUT_MS = 45_000;

export interface StartServiceHost {
  state: Map<string, ProcessState>;
  install(svc: ServiceConfig, colorIdx?: number): Promise<boolean>;
  start(svc: ServiceConfig, colorIdx: number, isRestart?: boolean): Promise<void>;
  cancelPendingRestart(name: string): void;
}

/** Start one stopped service, and report whether it actually came up.
 *
 *  Shared by the daemon and the TUI: both expose this as the control plane's
 *  `start`, and duplicating the policy meant a fix could land in one and
 *  silently miss the other — `devup` foreground and `devup up -d` would then
 *  answer the same command differently. */
export async function startService(
  host: StartServiceHost,
  lazyProxies: Map<string, { ensureStarted(): Promise<boolean> }> | undefined,
  name: string,
): Promise<StartResult> {
  const st = host.state.get(name);
  if (!st) throw new Error(`unknown service: ${name}`);

  // Nothing to start: the environment is serving it, and `Spawner.start`
  // refuses anyway. Returning `ok: true` without saying why would report a
  // spawn that never happened — and `ok: false` would call a service that is
  // answering perfectly a failure.
  if (st.remote) return { ok: true, skippedRemote: st.remote.envName };

  if (isRunning(st)) {
    // Liveness is read from the process, not from `pid`: a stopped service
    // keeps a dead pid, so a pid-based guard is a permanent no-op.
    if (!st.intentionalStop) return { ok: true };
    // A stop is in flight. `stop()` only sends SIGTERM, so a service that
    // drains still looks alive. Spawning now would race it for the port and
    // land in `recordCrashedState`, which drops the daemon's handle on the
    // child that is still running.
    if (!await waitForExit(st, STOP_GRACE_MS)) return { ok: false };
  }

  // A config reload can drop the service while we wait above.
  if (!host.state.has(name)) return { ok: false };

  // Or a queued auto-restart spawns a second process moments after this one.
  host.cancelPendingRestart(name);
  // Same intent as a manual restart: an explicit start earns a fresh budget,
  // otherwise a service that exhausted MAX_RESTARTS never auto-restarts again.
  st.restarts = 0;

  const proxy = lazyProxies?.get(name);
  // Through the proxy, never around it: starting directly leaves its readiness
  // flag false and the next request to the public port starts a second process.
  if (proxy) return { ok: await proxy.ensureStarted() };

  await host.install(st.svc, st.colorIdx);
  if (!host.state.has(name)) return { ok: false };
  await host.start(st.svc, st.colorIdx);

  const after = host.state.get(name);
  // The spawner returns normally after recording a crash — failed pre-build,
  // missing watch path, port already taken — so "no exception" is not success.
  if (!after || after.status === 'crashed') return { ok: false };
  // A service started with `--inspect-brk` is stopped before its first line
  // and will not open its port until a person attaches and resumes it. Waiting
  // for the port here would report failure after 45 s on a service that
  // started exactly as asked — and `debugService` would then roll the debug
  // flag back, leaving the process suspended while state says debugging is off.
  if (startsSuspended(after.svc)) return { ok: true };
  // And it returns as soon as the child is spawned, so for an API "up" means
  // the port answers, the same bar `bootNormal` uses. A web service has no
  // equivalent signal at this level; boot treats it as started too.
  if (after.svc.type === 'api') return { ok: await waitForPort(after.svc.port, { timeout: READY_TIMEOUT_MS }) };
  return { ok: true };
}
