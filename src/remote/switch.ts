import type { DevStackConfig, ServiceConfig } from '../config/types.js';
import type { ProcessManager } from '../process/manager.js';
import type { RemoteInfo, RemoteResult } from '../control-plane/types.js';
import { isPortBindable } from '../process/health.js';
import { startService } from '../process/start-service.js';
import { releaseLazyProxy } from '../lazy/classifier.js';
import { releaseRemoteProxy } from './classifier.js';
import { createRemoteProxy, type RemoteProxy } from './proxy.js';
import { buildOriginMap, resolveRemoteTarget } from './target.js';

/** How long to wait for a port to come free after stopping what held it.
 *
 *  A service gets SIGTERM and drains; binding before it is done fails with
 *  EADDRINUSE, and the switch would report an error for something that was
 *  half a second from working. */
const PORT_RELEASE_TIMEOUT_MS = 8_000;
const PORT_POLL_MS = 200;

export interface SwitchDeps {
  mgr: ProcessManager;
  config: DevStackConfig;
  remoteProxies: Map<string, RemoteProxy>;
  lazyProxies?: Map<string, { destroy: () => void; ensureStarted(): Promise<boolean> }>;
  processEnv?: Record<string, string | undefined>;
  onLog: (svc: string, msg: string, colorIdx: number) => void;
}

/** The wire shape — see the note on `RestartOutcome`. */
export type SwitchResult = RemoteResult;


/** Move one service between running here and being served from an environment,
 *  without restarting the stack.
 *
 *  This is the step that makes the feature usable in the middle of an
 *  afternoon: "this API I want mine, leave the rest on QA" — and back again
 *  twenty minutes later, without losing the twenty services that are up.
 *
 *  The whole thing turns on one ordering rule. **Exactly one owner of the port
 *  at a time**: whatever holds it is released and confirmed gone before the
 *  next owner binds. Skipping the confirmation trades a clear error for an
 *  EADDRINUSE from inside a proxy nobody is watching. */
export async function switchService(
  deps: SwitchDeps,
  name: string,
  envName: string | null,
): Promise<SwitchResult> {
  const { mgr, config } = deps;
  const st = mgr.state.get(name);
  if (!st) return fail(`unknown service: ${name}`);

  // From the config rather than from `state.svc`: a lazy service's `svc` has
  // been through `rewriteServicePort`, so its `port` is the internal one and
  // binding a remote proxy there would leave the public port unanswered.
  const svc = config.services.find(s => s.name === name);
  if (!svc) return fail(`${name} is not in the config`);

  return envName === null
    ? toLocal(deps, name, svc)
    : toRemote(deps, name, svc, envName);
}

async function toRemote(
  deps: SwitchDeps, name: string, svc: ServiceConfig, envName: string,
): Promise<SwitchResult> {
  const { mgr, config, remoteProxies, onLog } = deps;
  const st = mgr.state.get(name)!;

  const env = config.environments?.[envName];
  if (!env) {
    const available = Object.keys(config.environments ?? {});
    return fail(available.length
      ? `unknown environment: "${envName}". Available: ${available.join(', ')}`
      : `unknown environment: "${envName}". No environments defined in config.`);
  }

  const target = resolveRemoteTarget(name, env, config.proxy?.routes);
  if (!target) {
    return fail(`no target for ${name} in "${envName}" — absent from proxy.routes and from environments.${envName}.targets`);
  }

  if (st.remote?.envName === envName) {
    return { ok: true, remote: { ...st.remote } };
  }

  // Order matters, and every step here is releasing a claim on the port.
  // A queued auto-restart first: it would otherwise spawn the process again
  // seconds after the proxy took its place.
  mgr.cancelPendingRestart(name);
  releaseLazyProxy(deps.lazyProxies, name);
  releaseRemoteProxy(remoteProxies, name);
  mgr.stop(name);

  if (!await waitForPortFree(svc.port)) {
    return fail(`:${svc.port} is still held ${PORT_RELEASE_TIMEOUT_MS}ms after stopping ${name}`);
  }

  const proxy = createRemoteProxy({
    listenPort: svc.port,
    target,
    envName,
    env,
    // Rebuilt from what is remote *now*, this service included: a redirect
    // that crosses to another remote service is only localized if that
    // service's origin is in the map.
    originMap: currentOriginMap(deps, { name, target, port: svc.port }),
    processEnv: deps.processEnv,
    onLog: msg => onLog(name, msg, st.colorIdx),
    onUpstreamError: () => { const s = mgr.state.get(name); if (s) s.errors++; },
    onHealth: reachable => {
      const s = mgr.state.get(name);
      if (!s || !s.remote) return;
      const next = reachable ? 'up' : 'down';
      if (s.health === next) return;
      s.health = next;
      mgr.notifyStateChange(name);
    },
  });
  remoteProxies.set(name, proxy);

  st.svc = svc;
  st.proc = null;
  st.pid = null;
  st.status = 'running';
  st.health = 'wait';
  st.startedAt = Date.now();
  st.debugPort = null;
  // `intentionalStop` is deliberately **not** cleared here. `Lifecycle.stop`
  // set it, and the spawner's close handler is what consumes it — on the same
  // state object, because this mutates in place.
  //
  // The two do not happen in that order. A service that closes its listening
  // socket on SIGTERM and then drains frees the port before `proc` emits
  // `close`, so `waitForPortFree` returns and we get here first. Clearing the
  // flag then makes the close handler read a non-zero exit as a crash: it
  // writes `crashed`/`down` over the state we just marked remote, and calls
  // `onCrash`, which schedules an auto-restart *after* the
  // `cancelPendingRestart` above. When that timer fires, the port is held by
  // the new proxy, so the spawner lands in `recordCrashedState` — which
  // replaces the whole state object and drops `remote` with it. The proxy
  // keeps serving while every client shows the service as crashed.
  st.remote = { envName, target, readOnly: env.readOnly === true };
  mgr.notifyStateChange(name);
  onLog(name, `🌐 :${svc.port} → ${target}`, st.colorIdx);
  if (!env.readOnly) onLog(name, `⚠ writes now reach ${envName}`, st.colorIdx);

  return { ok: true, remote: { ...st.remote } };
}

async function toLocal(deps: SwitchDeps, name: string, svc: ServiceConfig): Promise<SwitchResult> {
  const { mgr, remoteProxies, onLog } = deps;
  const st = mgr.state.get(name)!;
  if (!st.remote) return { ok: true, remote: null };

  const from = st.remote.envName;
  // Before anything else: the proxy holds the port the process is about to
  // want, and it answers for the service until it is destroyed.
  releaseRemoteProxy(remoteProxies, name);
  if (!await waitForPortFree(svc.port)) {
    return fail(`:${svc.port} did not come free after releasing the ${from} proxy`);
  }

  // Cleared here even though every path that reaches the spawner replaces the
  // whole state object anyway — `Spawner.start` and `recordCrashedState` both
  // build a fresh one, and neither carries `remote`. What this covers is the
  // paths that never get there: `startService` gives up before spawning if the
  // service left the map, or if a stop already in flight does not finish
  // draining. Leaving the marker set there would show a service as served from
  // qa with nothing at all behind its port. Not reachable from a test, which
  // is why it is written down rather than asserted.
  st.remote = undefined;
  st.svc = svc;
  st.status = 'stopped';
  st.health = 'down';
  st.startedAt = null;
  st.errors = 0;

  // Announced before the spawn, not after: between the two the service is
  // neither proxied nor running, and a follower left on the old frame shows it
  // as still served from the environment.
  mgr.notifyStateChange(name);
  onLog(name, `⬅ back to local from ${from}`, st.colorIdx);
  // Deliberately started outright rather than handed back to lazy mode. A
  // service is brought local to work on it, and going straight back to sleep
  // is the opposite of that — `--lazy` decides how a stack *boots*, not what a
  // person just asked for.
  const ok = await startService(mgr, undefined, name);
  return ok ? { ok: true, remote: null } : fail(`${name} did not come up locally`);
}

/** Every remote origin currently served, with `extra` folded in — used when
 *  building a proxy for a service that is not in the map yet. */
function currentOriginMap(
  deps: SwitchDeps,
  extra?: { name: string; target: string; port: number },
): Map<string, string> {
  const entries = new Map<string, { target: string; port: number }>();
  for (const [name, proxy] of deps.remoteProxies) {
    const st = deps.mgr.state.get(name);
    if (st) entries.set(name, { target: proxy.target, port: st.svc.port });
  }
  if (extra) entries.set(extra.name, { target: extra.target, port: extra.port });
  return buildOriginMap(entries);
}

async function waitForPortFree(port: number): Promise<boolean> {
  const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
  for (;;) {
    if (await isPortBindable(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, PORT_POLL_MS));
  }
}

function fail(error: string): SwitchResult {
  return { ok: false, remote: null, error };
}
