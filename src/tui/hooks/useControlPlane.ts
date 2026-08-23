import { useEffect, useRef } from 'react';
import { totalmem, freemem, cpus } from 'node:os';
import type { ProcessManager } from '../../process/manager.js';
import type { LogSink } from '../../process/log-sink.js';
import type { Broadcaster } from '../../utils/broadcaster.js';
import type { ProcessState } from '../../process/types.js';
import type { Platform } from '../../platform/types.js';
import type { ProxyConfigProvider, ProxyOpts } from '../../proxy-config/types.js';
import { startSocketServer, type SocketServerHandle } from '../../control-plane/socket-server.js';
import { calcCpuPercent } from '../../utils.js';
import { systemLoad } from '../../utils/system-load.js';
import type { LazyProxy } from '../../lazy/proxy.js';
import { startService } from '../../process/start-service.js';
import { debugService } from '../../process/debug-service.js';
import { readLogWindow } from '../../process/log-reader.js';
import { restartService } from '../../process/restart-service.js';

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
  platform: Platform,
  proxy: { provider: ProxyConfigProvider; opts: ProxyOpts } | null,
  profiles: Record<string, string[]>,
): React.RefObject<SocketServerHandle | null> {
  const handleRef = useRef<SocketServerHandle | null>(null);
  const prevCpuMap = useRef(new Map<string, { time: number; cpu: number }>());

  useEffect(() => {
    if (!manager) return;
    let handle: SocketServerHandle | null = null;
    (async () => {
      try {
        handle = await startSocketServer(projectName, {
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
          watchRemoved: (onRemoved) => removedBus.subscribe(({ name }) => onRemoved(name)),
          debug: (name, enable, port, brk) => debugService(manager, lazyProxies.current, name, enable, port, brk),
          start: (name) => startService(manager, lazyProxies.current, name),

          async getStats() {
            const pids: number[] = [];
            const pidToName = new Map<number, string>();
            for (const [name, st] of manager.state) {
              if (st.pid) { pids.push(st.pid); pidToName.set(st.pid, name); }
            }
            const cores = cpus().length;
            const raw = pids.length ? await platform.getProcessStats(pids) : new Map();
            const services: Record<string, { cpu: number; memMB: number }> = {};
            for (const [name] of manager.state) {
              services[name] = { cpu: 0, memMB: 0 };
            }
            for (const [pid, data] of raw) {
              const name = pidToName.get(pid);
              if (!name) continue;
              const prev = prevCpuMap.current.get(name) ?? { time: Date.now(), cpu: 0 };
              const cpu = calcCpuPercent(data.cpuSeconds, prev.cpu, prev.time);
              prevCpuMap.current.set(name, { time: Date.now(), cpu: data.cpuSeconds });
              services[name] = { cpu: Math.round(cpu * 10) / 10, memMB: Math.round((data.rss / 1024) * 10) / 10 };
            }
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
          getProxyInfo() {
            if (!proxy) return null;
            return {
              active: true,
              provider: proxy.provider.name,
              domain: proxy.opts.domain,
              tls: proxy.opts.tls,
              routes: proxy.opts.routes,
            };
          },
          getInfo() {
            return { project: projectName, profiles };
          },
        }, { onLog: msg => pushLog('devup', msg, 12) });
        handleRef.current = handle;
      } catch (e: any) {
        pushLog('devup', `⚠ control plane disabled: ${e.message}`, 5);
      }
    })();
    return () => { void handle?.close(); handleRef.current = null; };
  }, [manager, projectName, logSink, pushLog, logBus, stateBus, removedBus, lazyProxies, platform, proxy, profiles]);
  return handleRef;
}
