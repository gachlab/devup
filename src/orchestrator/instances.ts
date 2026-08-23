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
import { instanceFlag } from '../config/instance.js';

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
  /** Whether it is another **instance of the same project** — which is the
   *  case `--instance` creates, and the only one where a `devup down` typed
   *  here would reach it.
   *
   *  A different project's daemon on the same port is a different situation:
   *  its ports are not ours by design, `--kill-port-conflicts` is a legitimate
   *  answer, and `devup down` from this directory would stop *our* daemon,
   *  never theirs. */
  sameProject: boolean;
  /** The command that stops it, when one typed here can. */
  stopCommand: string | null;
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
 *  Returns null when nothing claims the port. No fallback guess: a daemon that
 *  answered and did not claim it has ruled itself out, and one that could not
 *  be reached tells us nothing to say either. A stray `node server.js` on a
 *  devup port is not another instance, and naming one sends someone to stop a
 *  daemon that is innocent. */
export async function attributePort(
  holderPid: number | null,
  selfSocketPath: string,
  /** The project asking, so a holder can be told apart from a sibling
   *  instance of it. */
  selfProject: string,
  probe: AttributeProbe,
  sockets: string[] = listInstanceSockets(),
): Promise<Attribution | null> {
  const others = sockets.filter(p => p !== selfSocketPath);
  if (!others.length) return null;

  for (const socketPath of others) {
    let identity: DaemonIdentity;
    try {
      identity = await probe.info(socketPath);
    } catch {
      continue;   // cannot be asked, so it has told us nothing
    }

    if (holderPid !== null && identity.pid === holderPid) return attribute(identity, selfProject);
    if (holderPid !== null) {
      try {
        const { services } = await probe.status(socketPath);
        if (services.some(s => s.pid === holderPid)) return attribute(identity, selfProject);
      } catch { /* it answered `info`; a failed `status` is not a match */ }
    }
  }

  // Nobody claimed it. There is deliberately no guess here: a daemon that
  // answered and did not claim the port has ruled itself out, and one that
  // could not be answered tells us nothing to say. A stray `node server.js` on
  // a devup port is not another instance, and naming one sends someone to stop
  // a daemon that is innocent.
  return null;
}

function attribute(identity: DaemonIdentity, selfProject: string): Attribution {
  const sameProject = identity.project === selfProject;
  return {
    identity,
    sameProject,
    // Built from what the daemon says it is, never from its file name: a
    // suffix cannot be cut off a qualified name without misreading a project
    // whose own name has a dash. And null for another project, because `devup
    // down` resolves the project from *this* directory's config — it would
    // stop ours, or report nothing, but never reach theirs.
    stopCommand: sameProject
      ? `devup down${instanceFlag(identity.instance)}`
      : null,
  };
}
