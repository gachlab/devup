import { watchFile, unwatchFile, type Stats } from 'node:fs';
import { loadConfig } from '../config/loader.js';
import { validateConfig, formatValidationErrors } from '../config/validator.js';
import { diffServices, summariseDiff } from '../config/diff.js';
import type { ProcessManager } from '../process/manager.js';
import type { ServiceConfig } from '../config/types.js';

export interface ConfigWatchOpts {
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
}

/** Re-loads the config, validates it, diffs against the running set, and
 *  applies add/remove/restart at the service level. A failed validation
 *  leaves the running set untouched. Pure (idempotent given the same
 *  config file + manager state), so both the TUI hook and the daemon
 *  can call it directly. */
export async function applyConfigChange(opts: ConfigWatchOpts): Promise<void> {
  const { configPath, baseCwd, manager, log } = opts;
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
      manager.stop(next.name);
      // Brief pause so the previous process releases its port before the new one starts.
      await new Promise(r => setTimeout(r, 800));
      await manager.install(next, ci);
      await manager.start(next, ci, true);
    }
    for (const next of diff.added) {
      const ci = colorIdx++;
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
