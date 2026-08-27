import { useEffect, useState } from 'react';
import type { Platform } from '../../platform/types.js';
import type { DevStackConfig, ServiceConfig } from '../../config/types.js';
import type { CliArgs } from '../../config/cli.js';
import type { ProcessManager } from '../../process/manager.js';
import type { ProcessState } from '../../process/types.js';
import { groupByPhase } from '../../utils.js';
import { waitForPort } from '../../process/health.js';
import { classifyServices, rewriteServicePort } from '../../lazy/classifier.js';
import { createLazyProxy, type LazyProxy } from '../../lazy/proxy.js';
import { classifyRemote, parseRemoteSelection } from '../../remote/classifier.js';
import { startRemoteServices } from '../../remote/boot.js';
import type { RemoteProxy } from '../../remote/proxy.js';
import { startsSuspended } from '../../utils/process-args.js';

/** See daemon.ts — a service suspended on its first line waits for a person. */
const SUSPENDED_READY_TIMEOUT_MS = 10 * 60_000;
import { startExternals, type ExternalProc } from '../../process/external.js';

interface BootRefs {
  lazyProxies: React.RefObject<Map<string, LazyProxy>>;
  remoteProxies: React.RefObject<Map<string, RemoteProxy>>;
  externals: React.RefObject<ExternalProc[]>;
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
        });
        refs.externals.current = result.procs;
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
          onLog: pushLog,
          processEnv: env,
        });
      }

      if (lazyMode && config.lazy) {
        // ── Lazy mode ──
        const { alwaysOn, lazy } = classifyServices(localServices, config.lazy);

        // Boot always-on services normally
        const aoPhases = groupByPhase(alwaysOn);
        let colorIdx = 0;
        for (const num of Object.keys(aoPhases).map(Number).sort((a, b) => a - b)) {
          const svcs = aoPhases[num]!;
          for (const svc of svcs) {
            const ci = colorIdx++;
            await mgr.install(svc, ci);
            await mgr.start(svc, ci);
          }
          const apis = svcs.filter(s => s.type === 'api');
          if (apis.length) await Promise.all(apis.map(s => waitForPort(s.port, { timeout: 45000 })));
          svcs.filter(s => s.type === 'web').forEach(s => {
            const st = mgr.state.get(s.name);
            if (st) st.status = 'running';
          });
        }

        // Set up lazy proxies
        for (const svc of lazy) {
          const ci = colorIdx++;
          const rewritten = rewriteServicePort(svc);

          // Register as idle in process state
          const idleState: ProcessState = {
            svc: rewritten, proc: null, pid: null,
            status: 'idle', health: 'idle',
            errors: 0, restarts: 0, startedAt: null,
            intentionalStop: false, colorIdx: ci, crashLog: null,
          };
          mgr.state.set(svc.name, idleState);

          const proxy = createLazyProxy({
            listenPort: svc.port,
            targetPort: rewritten.realPort,
            timeoutMin: lazyTimeout,
            onDemandStart: async () => {
              // Only the debug flag is read back from state. Taking the whole live
              // config would be wrong: a --watch-config reload writes the *raw* file
              // config into state, and starting a lazy service from that puts it on
              // the public port its own proxy is already listening on.
              const cfg = { ...rewritten, debug: mgr.state.get(svc.name)?.svc.debug };
              await mgr.install(cfg, ci);
              await mgr.start(cfg, ci);
              // Un servicio con `--inspect-brk` no escucha hasta que alguien se acopla
              // y lo reanuda, y eso tarda lo que tarde una persona.
              const suspended = startsSuspended(cfg);
              const ok = await waitForPort(rewritten.realPort, {
                timeout: suspended ? SUSPENDED_READY_TIMEOUT_MS : 45000,
              });
              const st = mgr.state.get(svc.name);
              if (st) {
                if (ok) { st.status = 'running'; st.health = 'up'; }
                // `timeout` es un estado del que no se vuelve: el health poller
                // salta cualquier servicio que esté en él, así que un arranque
                // suspendido que tarde más de la cuenta quedaría marcado como
                // caído para siempre aunque luego sirva tráfico. Se queda en
                // `starting`, que es lo que de verdad es.
                else if (!suspended) st.status = 'timeout';
              }
            },
            onIdleStop: () => {
              mgr.stop(svc.name);
              const st = mgr.state.get(svc.name);
              if (st) { st.status = 'idle'; st.health = 'idle'; st.pid = null; st.proc = null; st.startedAt = null; st.debugPort = null; }
            },
            isDebugging: () => typeof mgr.state.get(svc.name)?.debugPort === 'number',
            isAlive: () => {
              const st = mgr.state.get(svc.name);
              return !!st && !!st.proc && !st.proc.killed && st.health === 'up';
            },
          });

          refs.lazyProxies.current!.set(svc.name, proxy);
        }
      } else {
        // ── Normal mode ──
        const phases = groupByPhase(localServices);
        let colorIdx = 0;
        for (const num of Object.keys(phases).map(Number).sort((a, b) => a - b)) {
          const svcs = phases[num]!;
          for (const svc of svcs) {
            const ci = colorIdx++;
            await mgr.install(svc, ci);
            await mgr.start(svc, ci);
          }
          const apis = svcs.filter(s => s.type === 'api');
          if (apis.length) await Promise.all(apis.map(s => waitForPort(s.port, { timeout: 45000 })));
          svcs.filter(s => s.type === 'web').forEach(s => {
            const st = mgr.state.get(s.name);
            if (st) st.status = 'running';
          });
        }
      }
    })();
  }, [booted, manager, services, cliArgs, config.lazy, config.external, baseCwd, env, platform, refs, pushLog]);
}
