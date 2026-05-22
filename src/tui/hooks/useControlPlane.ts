import { useEffect, useRef } from 'react';
import { createInterface } from 'node:readline';
import { createReadStream, existsSync } from 'node:fs';
import type { ProcessManager } from '../../process/manager.js';
import type { LogSink } from '../../process/log-sink.js';
import { startSocketServer, type SocketServerHandle } from '../../control-plane/socket-server.js';

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
): React.RefObject<SocketServerHandle | null> {
  const handleRef = useRef<SocketServerHandle | null>(null);
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
        }, { onLog: msg => pushLog('devup', msg, 12) });
        handleRef.current = handle;
      } catch (e: any) {
        pushLog('devup', `⚠ control plane disabled: ${e.message}`, 5);
      }
    })();
    return () => { void handle?.close(); handleRef.current = null; };
  }, [manager, projectName, logSink, pushLog]);
  return handleRef;
}
