import { useEffect } from 'react';
import type { ProcessManager } from '../../process/manager.js';
import type { CliArgs } from '../../config/cli.js';
import { findConfigFile } from '../../config/loader.js';
import { watchConfig } from '../../orchestrator/config-watcher.js';

/** Watches the resolved config file when --watch-config is on. Bridge between
 *  React's lifecycle and the pure `watchConfig` helper used by the daemon. */
export function useHotReload(
  manager: ProcessManager | null,
  cliArgs: CliArgs,
  baseCwd: string,
  pushLog: (svc: string, msg: string, colorIdx?: number) => void,
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
    return watchConfig({
      configPath, baseCwd, manager,
      log: msg => pushLog('devup', msg, msg.startsWith('⚠') ? 5 : 12),
    });
  }, [cliArgs.watchConfig, cliArgs.configPath, baseCwd, manager, pushLog]);
}
