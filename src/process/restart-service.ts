import type { ProcessState } from './types.js';

export interface RestartServiceHost {
  state: Map<string, ProcessState>;
  restart(name: string): Promise<void>;
  stop(name: string): void;
}

export interface RestartOutcome {
  /** Whether the service is running again. A lazy service left asleep counts
   *  as fine: nothing was wrong with it. */
  ok: boolean;
  /** True when the service was lazy and idle, so there was nothing to restart.
   *  Worth saying — "restarted" would be a lie, and waking it is not what
   *  someone resetting state between suites asked for. */
  skippedIdle: boolean;
}

/** Restart one service, through its lazy proxy when it has one.
 *
 *  `ProcessManager.restart` goes straight to the spawner, which is right for
 *  an always-on service and wrong for a lazy one: the proxy owns the public
 *  port and tracks whether the service behind it is up. Spawning around it
 *  leaves `serviceReady` false, so the next request through the proxy starts a
 *  **second** process — for an API the `isPortBindable` pre-flight catches it,
 *  but a lazy web has no such guard and the two fight over the port until the
 *  daemon loses its handle on the one that is actually serving. The idle timer
 *  is re-armed inside `ensureStarted` too, so a service restarted around the
 *  proxy never idles again either.
 *
 *  Same invariant `startService` and `debugService` already follow, and the
 *  one `lazy/proxy.ts` states on `ensureStarted`. It became load-bearing when
 *  `devup ctl restart --all` turned "restart one service" into "restart every
 *  lazy service in the stack". */
export async function restartService(
  host: RestartServiceHost,
  lazyProxies: Map<string, { ensureStarted(): Promise<boolean> }> | undefined,
  name: string,
): Promise<RestartOutcome> {
  const st = host.state.get(name);
  if (!st) throw new Error(`unknown service: ${name}`);

  const proxy = lazyProxies?.get(name);
  if (!proxy) {
    await host.restart(name);
    return { ok: true, skippedIdle: false };
  }

  // Asleep: there is no process to restart, and its state is already fresh.
  // Waking it here would be the opposite of what `restart --all` between test
  // suites is for.
  if (st.status === 'idle') return { ok: true, skippedIdle: true };

  host.stop(name);
  // Through the proxy, never around it — see above.
  return { ok: await proxy.ensureStarted(), skippedIdle: false };
}
