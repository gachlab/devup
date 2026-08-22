import { watchFile, unwatchFile, type Stats } from 'node:fs';
import { loadConfig } from '../config/loader.js';
import { validateConfig, formatValidationErrors } from '../config/validator.js';
import { diffServices, summariseDiff } from '../config/diff.js';
import type { ProcessManager } from '../process/manager.js';

export interface ConfigWatchOpts {
  configPath: string;
  baseCwd: string;
  manager: ProcessManager;
  /** Receives status lines: success, validation errors, reload errors. */
  log: (msg: string) => void;
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
    const currentSvcs = [...manager.state.values()].map(s => s.svc);
    const diff = diffServices(currentSvcs, nextCfg.services);
    if (!diff.added.length && !diff.removed.length && !diff.changed.length) return;

    for (const name of diff.removed) {
      manager.remove(name);
    }
    let colorIdx = currentSvcs.length;
    for (const { next: fileSvc } of diff.changed) {
      const prev = manager.state.get(fileSvc.name);
      const ci = prev?.colorIdx ?? colorIdx++;
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
