/** Which other devup instances are running, and which of them holds a port.
 *
 *  Exists for one message. Instances share their project's ports on purpose —
 *  shifting them would have to reach the services themselves — so two cannot
 *  serve at once, and the way that shows up is a port conflict. "some process
 *  has your port" sends someone hunting; "the `e2e` instance has it, stop it
 *  with `devup down --instance e2e`" is the whole answer.
 *
 *  Built on the **socket files**, not the pid files, and that is not
 *  arbitrary: the two are named by different sanitisers — the pid one trims
 *  leading underscores and the socket one does not, so `@gachlab/web` has
 *  `gachlab_web.pid` next to `sock-_gachlab_web.sock`. Deriving one from the
 *  other silently misses every scoped project name. A socket file *is* a
 *  socket path, and the daemon behind it can be asked what it is, so no name
 *  is ever reconstructed. */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface DaemonIdentity {
  /** The project as configured, not a sanitised file name. */
  project: string;
  /** From `--instance`, absent for the default stack. */
  instance?: string;
  /** The daemon's own pid, when it reports one. */
  pid?: number;
}

/** Every devup control-plane socket on this machine.
 *
 *  Best effort by design: a missing directory or an unreadable entry just
 *  means "not that one". Nothing here may fail a boot — it only makes a
 *  message better. */
export function listInstanceSockets(dir = join(homedir(), '.devup')): string[] {
  try {
    return readdirSync(dir)
      .filter(f => f.startsWith('sock-') && f.endsWith('.sock'))
      .map(f => join(dir, f));
  } catch {
    return [];
  }
}

export interface AttributeProbe {
  info(socketPath: string): Promise<DaemonIdentity>;
  status(socketPath: string): Promise<{ services: Array<{ pid: number | null }> }>;
}

export interface Attribution {
  identity: DaemonIdentity;
  /** The exact command that stops it. */
  stopCommand: string;
}

/** Which running instance holds `holderPid`, asked rather than guessed.
 *
 *  Two ways it can be ours, and both are checked:
 *
 *  - **The daemon itself**, when the service is lazy — its on-demand proxy
 *    listens on the configured port from inside the daemon process, and lazy
 *    is the default. No service pid will ever match in that case.
 *  - **One of its services**, otherwise.
 *
 *  Returns null rather than guessing when nothing matches *and* every daemon
 *  answered: a stray `node server.js` on a devup port is not another instance,
 *  and saying it is sends someone to stop a daemon that is innocent. The
 *  single-other fallback applies only when a daemon could not be reached at
 *  all — too old for a control plane, or still booting — where a good hint
 *  beats none. */
export async function attributePort(
  holderPid: number | null,
  selfSocketPath: string,
  probe: AttributeProbe,
  sockets: string[] = listInstanceSockets(),
): Promise<Attribution | null> {
  const others = sockets.filter(p => p !== selfSocketPath);
  if (!others.length) return null;

  let unreachable = 0;
  let onlyReachable: DaemonIdentity | null = null;
  for (const socketPath of others) {
    let identity: DaemonIdentity;
    try {
      identity = await probe.info(socketPath);
    } catch {
      unreachable++;
      continue;
    }
    onlyReachable ??= identity;

    if (holderPid !== null && identity.pid === holderPid) return attribute(identity);
    if (holderPid !== null) {
      try {
        const { services } = await probe.status(socketPath);
        if (services.some(s => s.pid === holderPid)) return attribute(identity);
      } catch { /* it answered `info`; a failed `status` is not a match */ }
    }
  }

  // Nobody claimed it. Only guess when someone could not be asked.
  if (unreachable === 0) return null;
  if (others.length === 1 && onlyReachable) return attribute(onlyReachable);
  return null;
}

function attribute(identity: DaemonIdentity): Attribution {
  return {
    identity,
    // Built from what the daemon says it is, never from its file name: the
    // suffix cannot be cut off a qualified name without misreading a project
    // whose own name has a dash.
    stopCommand: `devup down${identity.instance ? ` --instance ${identity.instance}` : ''}`,
  };
}
