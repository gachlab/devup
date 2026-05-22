import { useEffect } from 'react';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import type { ProcessManager } from '../../process/manager.js';
import type { CliArgs } from '../../config/cli.js';
import { loadConfig, findConfigFile } from '../../config/loader.js';
import { validateConfig, formatValidationErrors } from '../../config/validator.js';
import { diffServices, summariseDiff } from '../../config/diff.js';

/** Watches the resolved config file when --watch-config is on. On each save:
 *  re-load, validate, diff against the running set, apply add/remove/restart.
 *  A failed validation leaves the running set untouched. 250 ms debounce. */
export function useHotReload(
  manager: ProcessManager | null,
  cliArgs: CliArgs,
  baseCwd: string,
  pushLog: (svc: string, msg: string, colorIdx?: number) => void,
): void {
  useEffect(() => {
    if (!cliArgs.watchConfig || !manager) return;
    let watcher: FSWatcher | null = null;
    let configPath: string;
    try {
      configPath = findConfigFile(baseCwd, cliArgs.configPath);
    } catch (e: any) {
      pushLog('devup', `⚠ watch-config disabled: ${e.message}`, 5);
      return;
    }
    pushLog('devup', `👀 watching ${configPath}`, 12);

    let reloadInFlight = false;
    let reloadAgain = false;
    const reload = async () => {
      if (reloadInFlight) { reloadAgain = true; return; }
      reloadInFlight = true;
      try {
        const nextCfg = await loadConfig(configPath);
        const errs = validateConfig(nextCfg, baseCwd);
        if (errs.length) {
          pushLog('devup', `⚠ config reload failed:\n${formatValidationErrors(errs)}`, 5);
          return;
        }
        const currentSvcs = [...manager.state.values()].map(s => s.svc);
        const diff = diffServices(currentSvcs, nextCfg.services);
        if (!diff.added.length && !diff.removed.length && !diff.changed.length) return;

        // Apply: stop removed + changed, start added + changed.
        for (const name of diff.removed) {
          manager.stop(name);
          manager.state.delete(name);
        }
        let colorIdx = currentSvcs.length;
        for (const { next } of diff.changed) {
          const prev = manager.state.get(next.name);
          const ci = prev?.colorIdx ?? colorIdx++;
          manager.stop(next.name);
          await new Promise(r => setTimeout(r, 800));
          await manager.install(next, ci);
          await manager.start(next, ci, true);
        }
        for (const next of diff.added) {
          const ci = colorIdx++;
          await manager.install(next, ci);
          await manager.start(next, ci);
        }
        pushLog('devup', `🔁 config reloaded: ${summariseDiff(diff)}`, 12);
      } catch (e: any) {
        pushLog('devup', `⚠ config reload error: ${e.message}`, 5);
      } finally {
        reloadInFlight = false;
        if (reloadAgain) { reloadAgain = false; void reload(); }
      }
    };

    // Debounce: editors often emit several change events per save.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    watcher = fsWatch(configPath, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void reload(), 250);
    });
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher?.close();
    };
  }, [cliArgs.watchConfig, cliArgs.configPath, baseCwd, manager, pushLog]);
}
