import { useEffect, useRef } from 'react';
import { totalmem, freemem, cpus } from 'node:os';
import type { ProcessManager } from '../../process/manager.js';
import type { LogSink } from '../../process/log-sink.js';
import type { Broadcaster } from '../../utils/broadcaster.js';
import type { ProcessState } from '../../process/types.js';
import type { DevStackConfig } from '../../config/types.js';
import type { Platform } from '../../platform/types.js';
import type { ProxyConfigProvider, ProxyOpts } from '../../proxy-config/types.js';
import { startSocketServer, type SocketServerHandle } from '../../control-plane/socket-server.js';
import { calcCpuPercent } from '../../utils.js';
import { buildProxyInfo, computeServiceStats, seedServiceStats } from '../../utils/stats.js';
import { systemLoad } from '../../utils/system-load.js';
import type { RemoteProxy } from '../../remote/proxy.js';
import type { LazyProxy } from '../../lazy/proxy.js';
import { switchService } from '../../remote/switch.js';
import { startService } from '../../process/start-service.js';
import { debugService } from '../../process/debug-service.js';
import { readLogWindow } from '../../process/log-reader.js';
import { restartService } from '../../process/restart-service.js';
import { qualifyInstance } from '../../config/instance.js';

/** Lifecycle of the Unix-socket JSON-RPC control plane. Mounts when the
 *  manager is ready; tears down on unmount.
 *
 *  On listen failure (perms, dir missing, port already-in-use on the inode)
 *  devup keeps running without the control plane and logs a single notice. */
export function useControlPlane(
  manager: ProcessManager | null,
  projectName: string,
  logSink: LogSink | null,
  pushLog: (svc: string, msg: string, colorIdx?: number) => void,
  logBus: Broadcaster<{ svc: string; text: string }>,
  stateBus: Broadcaster<{ name: string; state: ProcessState }>,
  removedBus: Broadcaster<{ name: string }>,
  lazyProxies: React.RefObject<Map<string, LazyProxy>>,
  remoteProxies: React.RefObject<Map<string, RemoteProxy>>,
  /** The whole config, for `remote`: switching a service needs its
   *  `environments`, its `proxy.routes` and the service's **configured** port —
   *  `state.svc` carries the rewritten one for anything lazy. */
  config: DevStackConfig,
  env: Record<string, string>,
  platform: Platform,
  proxy: { provider: ProxyConfigProvider; opts: ProxyOpts } | null,
  profiles: Record<string, string[]>,
  /** Whether proxy-file writing is on right now. A getter, not a value: the
   *  TUI's `p` key toggles it, and taking the boolean would make it an effect
   *  dependency — rebuilding the whole socket server on every press, which is
   *  the churn bug #79 was about. Reported through `info` and `status`, which
   *  used to claim `active: true` while the toggle was off. */
  proxyActive: () => boolean,
  /** From `--instance`; reported by `info` so two instances are telling apart. */
  instance?: string,
): React.RefObject<SocketServerHandle | null> {
  const handleRef = useRef<SocketServerHandle | null>(null);
  const prevCpuMap = useRef(new Map<string, { time: number; cpu: number }>());

  useEffect(() => {
    if (!manager) return;
    let cancelled = false;
    let handle: SocketServerHandle | null = null;
    (async () => {
      try {
        // Qualified here rather than by the caller, so `getInfo` below can still
        // report the project as configured: the qualified name is a path key,
        // not a project anybody has heard of.
        const started = await startSocketServer(qualifyInstance(projectName, instance), {
          states: () => manager.state,
          restart: (name) => restartService(manager, lazyProxies.current, name),
          stop: (name) => manager.stop(name),
          // The same reader the daemon uses. These two were copies, so a
          // feature added to one — `since`, here — silently missed the other:
          // `devup ctl logs --since` would have worked against `devup up -d`
          // and done nothing against the TUI.
          tailLogs: async (svcName, opts) => {
            if (!logSink) return { lines: [], oldestRetained: null, truncated: false };
            return readLogWindow(logSink.pathFor(svcName), opts);
          },
          watchLogs: (svcName, onLine) => {
            return logBus.subscribe(({ svc, text }) => {
              if (svcName === null || svc === svcName) onLine(svc, text);
            });
          },
          watchStatus: (onUpdate) => {
            // See the daemon: a removed service can still emit, and forwarding
            // it would push `status` after `removed`.
            return stateBus.subscribe(({ name, state }) => {
              if (!manager.state.has(name)) return;
              onUpdate(name, state);
            });
          },
          watchRemoved: (onRemoved) => removedBus.subscribe(({ name }) => {
            // This map is the third copy of the CPU baseline — the daemon and
            // `useProcessManager` each release theirs on removal, and this one
            // had no release path at all. A service re-added under the same
            // name would be diffed against the dead process's counter and
            // report a large negative CPU for one sample: the `prevCpuMap` row
            // of CLAUDE.md §1, verbatim.
            prevCpuMap.current.delete(name);
            onRemoved(name);
          }),
          debug: (name, enable, port, brk) => debugService(manager, lazyProxies.current, name, enable, port, brk),
          start: (name) => startService(manager, lazyProxies.current, name),
          setRemote: (name, envName) => switchService({
            mgr: manager, config, remoteProxies: remoteProxies.current,
            lazyProxies: lazyProxies.current, processEnv: env,
            onLog: pushLog,
          }, name, envName),

          async getStats() {
            const { services, pids, pidToName } = seedServiceStats(manager.state);
            const cores = cpus().length;
            const raw = pids.length ? await platform.getProcessStats(pids) : new Map();
            computeServiceStats(services, raw, pidToName, prevCpuMap.current, calcCpuPercent);
            return {
              services,
              system: {
                totalMemMB: Math.round(totalmem() / 1024 / 1024),
                freeMemMB: Math.round(freemem() / 1024 / 1024),
                cpuCores: cores,
                ...systemLoad(cores),
              },
            };
          },
          getProxyInfo: () => buildProxyInfo(proxy?.provider, proxy?.opts, proxyActive()),
          getInfo() {
            return { project: projectName, ...(instance ? { instance } : {}), profiles };
          },
        }, { onLog: msg => pushLog('devup', msg, 12) });
        // Torn down while `listen()` was still in flight: the cleanup below has
        // already run and saw a null handle, so close it here or the server
        // leaks, holding the socket path against the next one.
        if (cancelled) { void started.close(); return; }
        handle = started;
        handleRef.current = started;
      } catch (e: any) {
        if (!cancelled) pushLog('devup', `⚠ control plane disabled: ${e.message}`, 5);
      }
    })();
    return () => { cancelled = true; void handle?.close(); handleRef.current = null; };
    // `config` and `env` are props of App, created once when the stack is
  // loaded — stable, like the rest. Anything rebuilt per render belongs in a
  // useMemo before it gets here; see the note on `proxyCtx` in App.tsx.
}, [manager, projectName, logSink, pushLog, logBus, stateBus, removedBus, lazyProxies, remoteProxies, config, env, platform, proxy, profiles, instance]);
  return handleRef;
}
