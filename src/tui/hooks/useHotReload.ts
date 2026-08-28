import { useEffect } from 'react';
import type { ProcessManager } from '../../process/manager.js';
import type React from 'react';
import type { LazyProxy } from '../../lazy/proxy.js';
import type { CliArgs } from '../../config/cli.js';
import { findConfigFile } from '../../config/loader.js';
import { watchConfig, type LazyWatchOpts } from '../../orchestrator/config-watcher.js';
import type { ServiceConfig } from '../../config/types.js';

/** Watches the resolved config file when --watch-config is on. Bridge between
 *  React's lifecycle and the pure `watchConfig` helper used by the daemon. */
export function useHotReload(
  manager: ProcessManager | null,
  cliArgs: CliArgs,
  baseCwd: string,
  pushLog: (svc: string, msg: string, colorIdx?: number) => void,
  /** Services as the config file declares them right now — the baseline the
   *  reload diffs against. See ConfigWatchOpts.baseline. */
  services: ServiceConfig[],
  /** The lazy proxies. A reload that respawns a lazy service has to go through
   *  its proxy, or it lands on the public port the proxy is holding. */
  lazyProxies?: React.RefObject<Map<string, LazyProxy>>,
): void {
  useEffect(() => {
    if (!cliArgs.watchConfig || !manager) return;
    let configPath: string;
    try {
      configPath = findConfigFile(baseCwd, cliArgs.configPath);
    } catch (e: any) {
      pushLog('devup', `⚠ watch-config disabled: ${e.message}`, 5);
      return;
    }
    pushLog('devup', `👀 watching ${configPath}`, 12);
    // The pair or neither — annotated, because a conditional spread widens to
    // "both optional", which is neither arm of the union.
    const lazyOpts: LazyWatchOpts = lazyProxies?.current
      ? { lazyProxies: lazyProxies.current, lazyTimeout: cliArgs.lazyTimeout }
      : {};
    return watchConfig({
      configPath, baseCwd, manager,
      ...lazyOpts,
      baseline: services,
      log: msg => pushLog('devup', msg, msg.startsWith('⚠') ? 5 : 12),
    });
  }, [cliArgs.watchConfig, cliArgs.configPath, baseCwd, manager, pushLog, services, lazyProxies]);
}
