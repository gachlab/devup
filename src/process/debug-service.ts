import type { StartServiceHost } from './start-service.js';
import { startService } from './start-service.js';

/** Same range the config validator enforces: a bad value reaches
 *  `--inspect=<n>`, Node refuses to start, and the flag persists on the service
 *  so every later restart fails the same way. */
function isInspectPort(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p > 0 && p <= 65535;
}

export interface DebugResult {
  /** Whether the service is now running under the inspector. */
  debug: boolean;
  /** Port the inspector bound to, once Node has announced it. Null while the
   *  service is still starting, or when debugging was turned off. */
  port: number | null;
  /** False when the restart did not bring the service back up. */
  ok: boolean;
}

export interface DebugServiceHost extends StartServiceHost {
  stop(name: string): void;
}

/** Turn the Node inspector on or off for one service, restarting it.
 *
 *  The flag lives on the service config in `state`, so it survives until
 *  changed back — a debugging session outlives the crash and auto-restart that
 *  usually prompt one. Config-declared `debug` is the same field, so a
 *  transient toggle and a permanent setting cannot disagree. */
export async function debugService(
  host: DebugServiceHost,
  lazyProxies: Map<string, { ensureStarted(): Promise<boolean> }> | undefined,
  name: string,
  enable: boolean,
  inspectPort?: number,
  brk = false,
): Promise<DebugResult> {
  const st = host.state.get(name);
  if (!st) throw new Error(`unknown service: ${name}`);
  if (inspectPort !== undefined && !isInspectPort(inspectPort)) {
    throw new Error(`invalid inspector port: ${inspectPort} (must be 1-65535)`);
  }
  if (st.svc.cmd !== 'node') {
    throw new Error(`${name} does not run node (cmd: ${st.svc.cmd}) — nothing to inspect`);
  }

  const before = st.svc;
  // The object form only when it says something the shorthands cannot: `brk`.
  // Keeping `true` / `<port>` otherwise leaves the common config untouched.
  const debug = brk ? { port: inspectPort, brk: true } : (inspectPort ?? true);
  st.svc = { ...st.svc, debug: enable ? debug : undefined };
  // Stale the moment the process restarts; the new one announces its own.
  st.debugPort = null;

  host.stop(name);
  const ok = await startService(host, lazyProxies, name);
  // Only when enabling. Turning the flag *off* is never what makes a service
  // unstartable, and rolling back there would re-arm the inspector the user
  // just disabled — the next restart would bring `--inspect` back.
  if (!ok && enable) {
    // Leaving the flag on a service that would not start makes it unstartable:
    // every later `ctl start` reuses the same bad value — a port already in
    // use, most likely — until someone thinks to run `ctl debug --off`.
    //
    // The queued auto-restart has to go with it: Restarter re-spawns the
    // config captured at crash time, so it would keep retrying with the bad
    // flag regardless of what state says.
    host.cancelPendingRestart(name);
    const now = host.state.get(name);
    if (now) now.svc = before;
    return { debug: false, port: null, ok: false };
  }
  // `ok` is the real outcome: turning the inspector *off* can fail too, and
  // that path deliberately does not roll back, so it must not fall through to
  // a hardcoded success.
  return { debug: enable, port: host.state.get(name)?.debugPort ?? null, ok };
}
