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
    let settled = false;
    const fail = (err: Error) => { if (!settled) { settled = true; reject(err); } };
    const ok = (v: unknown) => { if (!settled) { settled = true; resolve(v); } };

    const c = createConnection(socketPath);
    const rl = createInterface({ input: c });
    // Both the socket AND the readline interface can emit 'error' (readline
    // re-forwards errors from its input stream). Attach to BOTH so an
    // ECONNREFUSED on the socket can't escape as an unhandled error event.
    c.on('error', fail);
    rl.on('error', fail);
    rl.once('line', l => {
      c.end();
      try {
        const msg = JSON.parse(l);
        if (msg.error) fail(new Error(msg.error.message ?? String(msg.error)));
        else ok(msg.result);
      } catch (e: any) {
        fail(e);
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

  // Both the socket and the readline interface can emit 'error'. Listen on
  // both — without an rl handler an ECONNREFUSED can escape as an unhandled
  // 'error' event and crash the host process.
  const onErr = (err: Error) => onError?.(err);
  c.on('error', onErr);
  rl.on('error', onErr);
  c.write(JSON.stringify({ id: 1, method, params }) + '\n');

  rl.on('line', l => {
    let msg: { error?: { message?: string }; event?: string };
    try {
      msg = JSON.parse(l);
    } catch {
      return; // malformed frame — skip it
    }
    if (!ackDone) {
      ackDone = true;
      if (msg.error) { onError?.(new Error(msg.error.message ?? String(msg.error))); c.destroy(); }
      return;
    }
    // Deliberately outside the try: a throw from onFrame is a bug in the
    // consumer, not a malformed frame, and swallowing it hides the failure.
    if (msg.event) onFrame(msg as StreamFrame);
  });

  return () => c.destroy();
}
