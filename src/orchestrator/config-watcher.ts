import { watchFile, unwatchFile, type Stats } from 'node:fs';
import { loadConfig } from '../config/loader.js';
import { validateConfig, formatValidationErrors } from '../config/validator.js';
import { diffServices, summariseDiff } from '../config/diff.js';
import type { ProcessManager } from '../process/manager.js';
import type { ServiceConfig } from '../config/types.js';
import type { LazyProxy } from '../lazy/proxy.js';
import { rewriteServicePort } from '../lazy/classifier.js';
import { restartService } from '../process/restart-service.js';
import { registerLazy } from '../process/boot.js';
import { releaseLazyProxy } from '../lazy/classifier.js';
import { isRunning, waitForExit } from '../process/liveness.js';

/** Matches `start-service.ts`: long enough for a drain, short enough to notice. */
const STOP_GRACE_MS = 5_000;

/** The lazy half of the options: both or neither.
 *
 *  A union rather than two optional fields, because they are only meaningful
 *  together. `lazyTimeout` alone would be ignored; `lazyProxies` alone means a
 *  proxy this reload re-creates gets a **different idle timeout from every
 *  other one in the stack**, silently — which is what happened when the field
 *  was added optional and neither production caller passed it.
 *
 *  Written this way so the compiler asks, instead of a default papering over
 *  it. */
export type LazyWatchOpts =
  | { lazyProxies: Map<string, LazyProxy & { ensureStarted(): Promise<boolean> }>; lazyTimeout: number }
  | { lazyProxies?: undefined; lazyTimeout?: undefined };

export type ConfigWatchOpts = LazyWatchOpts & {
  configPath: string;
  baseCwd: string;
  manager: ProcessManager;
  /** Receives status lines: success, validation errors, reload errors. */
  log: (msg: string) => void;
  /** Services as the *file* last declared them.
   *
   *  Diffing against `manager.state` instead compares apples to oranges: a
   *  lazy service's live config carries the port rewrite (`port + 10000`,
   *  rewritten args and env), and a `ctl debug` toggle adds a flag the file
   *  never had — so those services compare as changed on every single save and
   *  get restarted, the lazy ones onto the port their own proxy holds.
   *
   *  Updated in place after each successful reload. */
  baseline: ServiceConfig[];
};

/** Re-loads the config, validates it, diffs against the running set, and
 *  applies add/remove/restart at the service level. A failed validation
 *  leaves the running set untouched. Pure (idempotent given the same
 *  config file + manager state), so both the TUI hook and the daemon
 *  can call it directly. */
export async function applyConfigChange(opts: ConfigWatchOpts): Promise<void> {
  const { configPath, baseCwd, manager, log } = opts;
  // Narrowed once, as a pair. Destructuring the two separately loses the
  // union's guarantee and TypeScript is right to complain: `lazyTimeout` is
  // only a number on the arm where `lazyProxies` exists.
  const lazy = opts.lazyProxies ? { proxies: opts.lazyProxies, timeout: opts.lazyTimeout } : null;
  try {
    const nextCfg = await loadConfig(configPath);
    const errs = validateConfig(nextCfg, baseCwd);
    if (errs.length) {
      log(`⚠ config reload failed:\n${formatValidationErrors(errs)}`);
      return;
    }
    const diff = diffServices(opts.baseline, nextCfg.services);
    if (!diff.added.length && !diff.removed.length && !diff.changed.length) return;

    for (const name of diff.removed) {
      manager.remove(name);
    }
    let colorIdx = manager.state.size;
    for (const { next: fileSvc } of diff.changed) {
      const prev = manager.state.get(fileSvc.name);
      const ci = prev?.colorIdx ?? colorIdx++;
      // A service served from a remote environment has no process to restart,
      // and starting one would be worse than a no-op: `manager.stop` does
      // nothing (there is no child), and `start(..., isRestart: true)` skips
      // the `isPortBindable` guard entirely — so it would spawn onto the port
      // the remote proxy is listening on, and the fresh state object the
      // spawner builds carries no `remote`, losing the marker while the proxy
      // keeps answering.
      if (prev?.remote) {
        log(`↷ ${fileSvc.name} changed in the config but is served from "${prev.remote.envName}" — bring it local (\`devup ctl remote ${fileSvc.name} --local\`) for the change to take effect`);
        continue;
      }
      // A runtime `devup ctl debug` toggle lives on the service, not in the
      // file, so a reload would silently drop it — disconnecting an attached
      // debugger. The file wins when it says something; otherwise the toggle
      // survives, which is what the control plane promises.
      const next = fileSvc.debug === undefined && prev?.svc.debug !== undefined
        ? { ...fileSvc, debug: prev.svc.debug }
        : fileSvc;
      // A lazy service runs on `port + LAZY_PORT_OFFSET` while its on-demand
      // proxy holds the configured one (CLAUDE.md §3). Spawning the **file**
      // config here put the process on the public port its own proxy is
      // listening on — and `isRestart: true` skips the `isPortBindable` guard,
      // so nothing caught it: the child died with EADDRINUSE, spent its
      // restart budget and ended `crashed`, while `state.svc` was left holding
      // the un-rewritten config so the snapshot reported a port that no longer
      // matched what the proxy targets.
      //
      // Routed through `restartService`, which owns the lazy proxy and
      // documents the four traps this loop was walking into — including
      // waiting for the old process to actually exit, which the fixed 800 ms
      // below was standing in for.
      const st = manager.state.get(next.name);
      const isLazy = lazy?.proxies.has(next.name) ?? false;

      // Read **before** anything writes `st.svc`: `st` and `prev` are the same
      // object, and `rewriteServicePort` sets `originalPort` to the new port —
      // so comparing afterwards compares the new port with itself and the
      // rebind below never ran at all.
      const previousPort = st?.svc.originalPort ?? st?.svc.port;
      const portChanged = previousPort !== undefined && previousPort !== next.port;

      if (!isLazy) {
        // No write to `st.svc` here: the spawner builds a fresh state entry
        // with this config, so advancing it by hand would only advertise a
        // config the running — or crashed — process never had.
        manager.stop(next.name);
        // Brief pause so the previous process releases its port before the new one starts.
        await new Promise(r => setTimeout(r, 800));
        await manager.install(next, ci);
        await manager.start(next, ci, true);
        continue;
      }

      // A lazy service's state has to carry the *rewritten* config, or the
      // snapshot reports a port that no longer matches what its proxy targets.
      if (st) st.svc = rewriteServicePort(next);

      // A changed **port** needs a new proxy: the old one bound the old
      // configured port at creation, and nothing re-binds it. Everything else
      // reaches the process through `onDemandStart`, which reads the live
      // config from state.
      if (portChanged) {
        // Stop the running child **first**, and wait for it to go.
        // `registerLazy` replaces the state entry with a fresh idle one, so an
        // awake service would be orphaned: `Lifecycle.stop` reads the map,
        // making every later stop a permanent no-op, the close handler still
        // holds the old state object and would write `crashed` over the new
        // entry, and the restarter would respawn the *old* rewritten config.
        // All four are CLAUDE.md §1 rows.
        if (prev && isRunning(prev)) {
          manager.stop(next.name);
          await waitForExit(prev, STOP_GRACE_MS);
        }
        manager.cancelPendingRestart(next.name);
        // The failure streak is per name and would be inherited by the entry
        // we are about to create — `forget` only runs via `remove()`.
        manager.forgetHealth(next.name);
        releaseLazyProxy(lazy!.proxies, next.name);
        registerLazy(manager, next, ci, lazy!.timeout, lazy!.proxies,
          msg => log(`[${next.name}] ${msg}`));
        log(`↻ ${next.name}: port changed, proxy rebound on :${next.port}`);
        continue;
      }

      // `ok` is the real outcome — see the note on `restartService`. Dropping
      // it leaves a service that failed to come back under a cheerful
      // "config reloaded" and nothing else.
      const outcome = await restartService(manager, lazy!.proxies, next.name);
      if (!outcome.ok) log(`⚠ ${next.name} did not come back after the reload`);
    }
    for (const next of diff.added) {
      const ci = colorIdx++;
      // Lazy mode applies to a service added at runtime too. Starting it
      // eagerly would put it on its configured port with no proxy and no idle
      // stop — permanently different from how the same service behaves after a
      // restart of devup, which is the kind of divergence nobody thinks to
      // look for.
      if (lazy && !nextCfg.lazy?.alwaysOn.includes(next.name)) {
        registerLazy(manager, next, ci, lazy.timeout, lazy.proxies,
          msg => log(`[${next.name}] ${msg}`));
        log(`＋ ${next.name}: registered lazy on :${next.port}`);
        continue;
      }
      await manager.install(next, ci);
      await manager.start(next, ci);
    }
    opts.baseline = nextCfg.services;
    log(`🔁 config reloaded: ${summariseDiff(diff)}`);
  } catch (e: any) {
    log(`⚠ config reload error: ${e.message}`);
  }
}

/** Watch a config file and call applyConfigChange on each save, debounced
 *  to 250 ms. Uses `fs.watchFile` (polling, 500 ms) rather than `fs.watch`
 *  for cross-platform reliability — `fs.watch` on a single file is flaky
 *  on macOS (FSEvents) and has its own quirks on Windows. Polling a single
 *  file every 500 ms is negligible cost for a long-running daemon.
 *  In-flight guard coalesces back-to-back saves. Returns a cleanup function. */
export function watchConfig(opts: ConfigWatchOpts): () => void {
  let debounceTimer: NodeJS.Timeout | null = null;
  let reloadInFlight = false;
  let reloadAgain = false;

  const trigger = async () => {
    if (reloadInFlight) { reloadAgain = true; return; }
    reloadInFlight = true;
    try {
      await applyConfigChange(opts);
    } finally {
      reloadInFlight = false;
      if (reloadAgain) { reloadAgain = false; void trigger(); }
    }
  };

  const listener = (curr: Stats, prev: Stats) => {
    // watchFile fires on every poll; skip when nothing actually changed.
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void trigger(), 250);
  };

  watchFile(opts.configPath, { interval: 500 }, listener);

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    unwatchFile(opts.configPath, listener);
  };
}
