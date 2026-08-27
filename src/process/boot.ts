import type { ServiceConfig, LazyConfig } from '../config/types.js';
import type { ProcessManager } from './manager.js';
import type { ProcessState } from './types.js';
import { groupByPhase } from '../utils.js';
import { waitForPort } from './health.js';
import { startsSuspended } from '../utils/process-args.js';
import { classifyServices, rewriteServicePort } from '../lazy/classifier.js';
import { createLazyProxy, type LazyProxy } from '../lazy/proxy.js';

/** A service suspended on its first line waits for a person, not for a port.
 *
 *  `--inspect-brk` stops before the service's own code, so it does not listen
 *  until someone attaches and resumes it. Timing that out would put it in
 *  `timeout`, a state the health poller skips for good. */
export const SUSPENDED_READY_TIMEOUT_MS = 10 * 60_000;

/** How long an API gets to open its port before the phase moves on. */
const READY_TIMEOUT_MS = 45_000;

export interface BootOpts {
  mgr: ProcessManager;
  /** The services to run **here** — the local set, after any remote ones have
   *  been taken out. */
  services: ServiceConfig[];
  /** Lazy config, when lazy mode is on. Absent means start everything. */
  lazy?: LazyConfig;
  lazyTimeout: number;
  lazyProxies: Map<string, LazyProxy>;
  /** First colour index to hand out. */
  colorIdxStart?: number;
  /** Where a lazy proxy's own messages go — a failed bind above all. */
  onLog?: (svc: string, msg: string) => void;
}

/** Boot a stack: phases in ascending order, lazy services registered behind
 *  their proxies.
 *
 *  One implementation for the interactive boots. The daemon and the TUI had a
 *  copy each — near-identical, down to the Spanish comments, with
 *  `SUSPENDED_READY_TIMEOUT_MS` declared twice — and this repo has been bitten
 *  by that shape before: `tailLogs` was two copies, so `--since` worked
 *  against `up -d` and silently did nothing against the TUI.
 *
 *  `--once` keeps its own loop on purpose; the note in `once.ts` says why.
 *
 *  Returns the next free colour index. */
export async function bootStack(opts: BootOpts): Promise<number> {
  const { mgr, lazyProxies, lazyTimeout } = opts;
  const lazyMode = !!opts.lazy;
  const { alwaysOn, lazy } = lazyMode
    ? classifyServices(opts.services, opts.lazy)
    : { alwaysOn: opts.services, lazy: [] as ServiceConfig[] };

  let colorIdx = opts.colorIdxStart ?? 0;
  const phases = groupByPhase(alwaysOn);

  for (const num of Object.keys(phases).map(Number).sort((a, b) => a - b)) {
    const svcs = phases[num]!;
    for (const svc of svcs) {
      const ci = colorIdx++;
      await mgr.install(svc, ci);
      await mgr.start(svc, ci);
    }

    const apis = svcs.filter(s => s.type === 'api');
    if (apis.length) await Promise.all(apis.map(s => waitForPort(s.port, { timeout: READY_TIMEOUT_MS })));

    // A web has no port-independent readiness signal at this level, so an
    // interactive boot calls it running once it is spawned. `--once` needs a
    // stronger bar and has its own loop — see the note there.
    svcs.filter(s => s.type === 'web').forEach(s => {
      const st = mgr.state.get(s.name);
      if (st) st.status = 'running';
    });
  }

  for (const svc of lazy) {
    registerLazy(mgr, svc, colorIdx++, lazyTimeout, lazyProxies, opts.onLog && ((m: string) => opts.onLog!(svc.name, m)));
  }
  return colorIdx;
}

/** Put a lazy service behind its on-demand proxy, idle until something asks.
 *
 *  Exported so a config reload can re-register one whose **port** changed: the
 *  proxy binds the configured port at creation, so a new port needs a new
 *  proxy — reading the live config covers everything else. */
export function registerLazy(
  mgr: ProcessManager,
  svc: ServiceConfig,
  ci: number,
  lazyTimeout: number,
  lazyProxies: Map<string, LazyProxy>,
  onLog?: (msg: string) => void,
): void {
  const rewritten = rewriteServicePort(svc);
  const state: ProcessState = {
    svc: rewritten, proc: null, pid: null,
    status: 'idle', health: 'idle',
    errors: 0, restarts: 0, startedAt: null,
    intentionalStop: false, colorIdx: ci, crashLog: null,
  };
  mgr.state.set(svc.name, state);

  const proxy = createLazyProxy({
    listenPort: svc.port,
    targetPort: rewritten.realPort,
    timeoutMin: lazyTimeout,
    onDemandStart: async () => {
      // The **live** config from state, not the one captured at boot.
      //
      // This used to close over `rewritten` and read back only `debug`, for a
      // reason that was true then: a `--watch-config` reload wrote the *raw*
      // file config into state, and starting from that would put the process
      // on the public port its own proxy is listening on. The reload writes
      // the rewritten config now, so reading state is both safe and the only
      // way an edit ever reaches the process — otherwise a reload of a lazy
      // service changes the snapshot and nothing else.
      //
      // The fallback matters: a service removed mid-flight has no state left.
      const cfg = mgr.state.get(svc.name)?.svc ?? rewritten;
      await mgr.install(cfg, ci);
      await mgr.start(cfg, ci);
      const suspended = startsSuspended(cfg);
      const ok = await waitForPort(cfg.realPort ?? rewritten.realPort, {
        timeout: suspended ? SUSPENDED_READY_TIMEOUT_MS : READY_TIMEOUT_MS,
      });
      const st = mgr.state.get(svc.name);
      if (!st) return;
      if (ok) { st.status = 'running'; st.health = 'up'; }
      // `timeout` is a state nothing comes back from: the health poller skips
      // it, so a suspended start that takes longer than the clock would be
      // marked down for ever even once it serves. It stays `starting`, which
      // is what it is.
      else if (!suspended) st.status = 'timeout';
    },
    onIdleStop: () => {
      mgr.stop(svc.name);
      const st = mgr.state.get(svc.name);
      if (!st) return;
      st.status = 'idle'; st.health = 'idle';
      st.pid = null; st.proc = null; st.startedAt = null; st.debugPort = null;
      // Announced, not just written. This is made from outside the manager,
      // and a `status.follow` client has no other way to learn a service went
      // to sleep — the snapshot is right either way, which is what made the
      // gap easy to miss.
      mgr.notifyStateChange(svc.name);
    },
    // Its only output. Without this the EADDRINUSE guard inside the proxy
    // logs into nothing, which is worse than the uncaught exception it
    // replaced: the daemon stays up and says nothing while the port answers
    // somebody else.
    onLog,
    isDebugging: () => typeof mgr.state.get(svc.name)?.debugPort === 'number',
    isAlive: () => {
      const st = mgr.state.get(svc.name);
      return !!st && !!st.proc && !st.proc.killed && st.health === 'up';
    },
  });

  lazyProxies.set(svc.name, proxy);
}
