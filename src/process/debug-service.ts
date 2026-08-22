import type { StartServiceHost } from './start-service.js';
import { startService } from './start-service.js';

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
): Promise<DebugResult> {
  const st = host.state.get(name);
  if (!st) throw new Error(`unknown service: ${name}`);
  if (st.svc.cmd !== 'node') {
    throw new Error(`${name} does not run node (cmd: ${st.svc.cmd}) — nothing to inspect`);
  }

  st.svc = { ...st.svc, debug: enable ? (inspectPort ?? true) : undefined };
  // Stale the moment the process restarts; the new one announces its own.
  st.debugPort = null;

  host.stop(name);
  const ok = await startService(host, lazyProxies, name);
  return { debug: enable, port: host.state.get(name)?.debugPort ?? null, ok };
}
