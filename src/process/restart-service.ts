import type { ProcessState } from './types.js';
import { startService, type StartServiceHost } from './start-service.js';

export interface RestartServiceHost extends StartServiceHost {
  stop(name: string): void;
}

export interface RestartOutcome {
  /** Whether the service is running again — the outcome, not an
   *  acknowledgement. */
  ok: boolean;
  /** True when the service was lazy and idle, so there was nothing to restart.
   *  Worth saying: "restarted" would be a lie, and waking it is not what
   *  someone resetting state between suites asked for. */
  skippedIdle: boolean;
}

/** Restart one service: stop it, then start it the way `start` starts it.
 *
 *  Deliberately **not** `ProcessManager.restart`, and deliberately the same
 *  shape as `debugService`, which has always restarted this way. Going
 *  straight to the spawner skips four things that each bite:
 *
 *  1. **The lazy proxy.** It owns the public port and tracks whether the
 *     service behind it is up; spawning around it leaves that flag false, so
 *     the next request starts a *second* process. An API survives on
 *     `isPortBindable`; a lazy web has no such guard, and the two then fight
 *     over the port until the daemon loses its handle on the one serving.
 *  2. **Waiting for the old process to actually exit.** `stop()` only sends
 *     SIGTERM, and a service that drains on shutdown is still listening
 *     afterwards. `startService` waits for the exit; calling
 *     `proxy.ensureStarted()` straight after the stop does something worse
 *     than race it — `ensureStarted` short-circuits on
 *     `serviceReady && isAlive() && checkPort()`, all three of which still
 *     hold in that window, so it returns `true` **without respawning** and the
 *     service is left down once it finishes draining.
 *  3. **A queued auto-restart.** One already scheduled fires seconds later and
 *     spawns a second process for the same name.
 *  4. **The restart budget.** A manual restart earns a fresh one, or a service
 *     that exhausted `MAX_RESTARTS` never auto-restarts again.
 *
 *  It also means `ok` is real: `Restarter.restart` returns `void` and swallows
 *  a failed `preBuild`, a missing watch path and a port already taken, so the
 *  old path answered `ok: true` over a service that never came back. */
export async function restartService(
  host: RestartServiceHost,
  lazyProxies: Map<string, { ensureStarted(): Promise<boolean> }> | undefined,
  name: string,
): Promise<RestartOutcome> {
  const st: ProcessState | undefined = host.state.get(name);
  if (!st) throw new Error(`unknown service: ${name}`);

  // Asleep: there is no process to restart, and its state is already fresh.
  // Waking it is the opposite of what `restart --all` between suites is for.
  if (lazyProxies?.has(name) && st.status === 'idle') {
    return { ok: true, skippedIdle: true };
  }

  host.stop(name);
  return { ok: await startService(host, lazyProxies, name), skippedIdle: false };
}
