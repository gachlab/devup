import { useEffect, useState } from 'react';
import type { Platform } from '../../platform/types.js';
import type { DevStackConfig, ServiceConfig } from '../../config/types.js';
import type { CliArgs } from '../../config/cli.js';
import type { ProcessManager } from '../../process/manager.js';
import { bootStack } from '../../process/boot.js';
import type { LazyProxy } from '../../lazy/proxy.js';
import { classifyRemote, parseRemoteSelection } from '../../remote/classifier.js';
import { startRemoteServices } from '../../remote/boot.js';
import type { RemoteProxy } from '../../remote/proxy.js';

import { startExternals, type ExternalProc } from '../../process/external.js';

interface BootRefs {
  lazyProxies: React.RefObject<Map<string, LazyProxy>>;
  remoteProxies: React.RefObject<Map<string, RemoteProxy>>;
  externals: React.RefObject<ExternalProc[]>;
  /** Aborted by the App's teardown, so a boot still waiting on an external
   *  stops waiting and spawns nothing more. */
  bootAbort: React.RefObject<AbortController>;
}

/** Orchestrates the boot:
 *  1. Externals first (docker compose etc.) — abort if any unhealthy.
 *  2. In lazy mode: start always-on services in phase order, register lazy
 *     TCP proxies for the rest.
 *  3. In normal mode: start every service in phase order.
 *
 *  Within each phase, APIs are awaited via waitForPort; webs are not. */
export function useBootSequence(
  manager: ProcessManager | null,
  config: DevStackConfig,
  services: ServiceConfig[],
  cliArgs: CliArgs,
  platform: Platform,
  env: Record<string, string>,
  baseCwd: string,
  refs: BootRefs,
  pushLog: (svc: string, msg: string, colorIdx?: number) => void,
): void {
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    if (booted || !manager) return;
    setBooted(true);
    const mgr = manager;

    (async () => {
      const lazyMode = cliArgs.lazy;
      const lazyTimeout = cliArgs.lazyTimeout;

      // External dependencies (DBs, queues, etc.) — must be healthy before phase 0.
      if (config.external?.length) {
        const result = await startExternals(config.external, {
          baseCwd, env, platform,
          onLog: (svc, msg) => pushLog(`ext:${svc}`, msg, 12),
          // The App's own array, filled as each one is spawned: its teardown
          // must be able to stop a database that is still starting.
          into: refs.externals.current!, signal: refs.bootAbort.current!.signal,
        });
        if (!result.allHealthy) {
          pushLog('devup', `❌ external(s) failed: ${result.failed.join(', ')}. Aborting boot.`, 5);
          return;
        }
      }

      // ── Remote environment ──
      // Runs before the lazy split so a service served from an environment is
      // neither spawned here nor given a lazy proxy on the port the remote
      // proxy is about to bind.
      let localServices = services;
      if (cliArgs.remote) {
        const selection = parseRemoteSelection(cliArgs.remote, config.environments);
        const classification = classifyRemote(config.services, services, selection, config.proxy?.routes);
        localServices = classification.local;
        startRemoteServices({
          mgr, classification,
          proxies: refs.remoteProxies.current!,
          colorIdxStart: config.services.length,
          routes: config.proxy?.routes,
          onLog: pushLog,
          processEnv: env,
        });
      }

      await bootStack({
        mgr, services: localServices,
        lazy: lazyMode ? config.lazy : undefined,
        lazyTimeout,
        lazyProxies: refs.lazyProxies.current!,
        colorIdxStart: 0,
        onLog: (svc, msg) => pushLog(svc, msg, 5),
      });
    })().catch((e: unknown) => {
      // Caught here, not left to `onFatal`'s `unhandledRejection` handler:
      // that one tears the whole stack down and exits, with the message
      // printed over Ink's alternate screen — losing the very text the throw
      // exists to deliver, and a boot error is something to read and fix
      // without losing the services that did start. `--remote qq` says which environments do
      // exist; a missing `${VAR}` in `headers.set` names the environment and
      // the header. Both are useless printed into a torn-down terminal.
      //
      // The daemon never had this problem: `daemonBody` wraps the same boot in
      // try/catch and writes the boot-error file.
      pushLog('devup', `❌ boot failed: ${(e as Error).message}`, 5);
    });
  }, [booted, manager, services, cliArgs, config.lazy, config.external, baseCwd, env, platform, refs, pushLog]);
}
