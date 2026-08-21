import { useEffect, useRef } from 'react';
import { createInterface } from 'node:readline';
import { createReadStream, existsSync } from 'node:fs';
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
          restart: (name) => manager.restart(name),
          stop: (name) => manager.stop(name),
          tailLogs: async (svcName, lines) => {
            if (!logSink) return [];
            const file = logSink.pathFor(svcName);
            if (!existsSync(file)) return [];
            return new Promise<string[]>((resolve, reject) => {
              const buf: string[] = [];
              const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }) });
              rl.on('line', l => { buf.push(l); if (buf.length > lines) buf.shift(); });
              rl.on('close', () => resolve(buf));
              rl.on('error', reject);
            });
          },
          watchLogs: (svcName, onLine) => {
            return logBus.subscribe(({ svc, text }) => {
              if (svcName === null || svc === svcName) onLine(svc, text);
            });
          },
          watchStatus: (onUpdate) => {
            return stateBus.subscribe(({ name, state }) => onUpdate(name, state));
          },
          watchRemoved: (onRemoved) => removedBus.subscribe(({ name }) => onRemoved(name)),
          async start(name) {
            const st = manager.state.get(name);
            if (!st) throw new Error(`unknown service: ${name}`);
            if (st.pid) return; // already running
            await manager.start(st.svc, st.colorIdx ?? 0, true);
          },
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
  }, [manager, projectName, logSink, pushLog, logBus, stateBus, removedBus, platform, proxy, profiles]);
  return handleRef;
}
