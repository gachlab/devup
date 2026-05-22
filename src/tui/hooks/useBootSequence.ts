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
import { startExternals, type ExternalProc } from '../../process/external.js';

interface BootRefs {
  lazyProxies: React.RefObject<Map<string, LazyProxy>>;
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

      if (lazyMode && config.lazy) {
        // ── Lazy mode ──
        const { alwaysOn, lazy } = classifyServices(services, config.lazy);

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
              await mgr.install(rewritten, ci);
              await mgr.start(rewritten, ci);
              const ok = await waitForPort(rewritten.realPort, { timeout: 45000 });
              const st = mgr.state.get(svc.name);
              if (st) {
                st.status = ok ? 'running' : 'timeout';
                if (ok) st.health = 'up';
              }
            },
            onIdleStop: () => {
              mgr.stop(svc.name);
              const st = mgr.state.get(svc.name);
              if (st) { st.status = 'idle'; st.health = 'idle'; st.pid = null; st.proc = null; st.startedAt = null; }
            },
            isAlive: () => {
              const st = mgr.state.get(svc.name);
              return !!st && !!st.proc && !st.proc.killed && st.health === 'up';
            },
          });

          refs.lazyProxies.current!.set(svc.name, proxy);
        }
      } else {
        // ── Normal mode ──
        const phases = groupByPhase(services);
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
