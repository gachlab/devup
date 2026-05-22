import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { defaultSocketPath } from './socket-server.js';

export { defaultSocketPath };

/** Resolve the socket path, preferring an explicit override. */
export function resolveSocket(projectName: string, overridePath?: string): string {
  return overridePath ?? defaultSocketPath(projectName);
}

/** Throw a friendly error if the socket doesn't exist (devup not running). */
export function assertSocketExists(socketPath: string, projectName: string): void {
  if (!existsSync(socketPath)) {
    throw new Error(
      `devup is not running for project "${projectName}".\nStart it with \`devup\` first.`,
    );
  }
}

/** Send a single RPC request and return the result, or throw on error. */
export function sendRpc(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const c = createConnection(socketPath);
    c.on('error', reject);
    const rl = createInterface({ input: c });
    rl.once('line', l => {
      c.end();
      try {
        const msg = JSON.parse(l);
        if (msg.error) reject(new Error(msg.error.message ?? String(msg.error)));
        else resolve(msg.result);
      } catch (e) {
        reject(e);
      }
    });
    c.write(JSON.stringify({ id: 1, method, params }) + '\n');
  });
}

export interface StreamFrame {
  event: string;
  data: unknown;
  svc?: string;
}

/** Open a streaming RPC (logs.follow / status.follow).
 *  Returns an abort function. The stream runs until abort() is called or the socket closes. */
export function openStream(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  onFrame: (frame: StreamFrame) => void,
  onError?: (err: Error) => void,
): () => void {
  const c = createConnection(socketPath);
  const rl = createInterface({ input: c });
  let ackDone = false;

  c.on('error', err => onError?.(err));
  c.write(JSON.stringify({ id: 1, method, params }) + '\n');

  rl.on('line', l => {
    try {
      const msg = JSON.parse(l);
      if (!ackDone) {
        ackDone = true;
        if (msg.error) { onError?.(new Error(msg.error.message ?? String(msg.error))); c.destroy(); }
        return;
      }
      if (msg.event) onFrame(msg as StreamFrame);
    } catch { /* ignore malformed frames */ }
  });

  return () => c.destroy();
}
