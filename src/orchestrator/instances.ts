/** Which other devup instances are running, from the pid files in ~/.devup.
 *
 *  Exists for one message. Instances share their project's ports on purpose —
 *  shifting them would have to reach the services themselves — so two cannot
 *  serve at once, and the way that shows up is a port conflict. "some process
 *  has your port" sends someone hunting; "the `dev` instance of this project
 *  has it, pid 1234" is the whole answer. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface RunningInstance {
  /** The qualified name the pid file is keyed by, e.g. `Guesthub-e2e`. */
  name: string;
  pid: number;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Every live devup daemon on this machine, by the name its pid file carries.
 *
 *  Best effort by design: a missing directory, an unreadable file or a pid
 *  that has since exited all just mean "not that one". Nothing here is allowed
 *  to fail a boot — it only makes a message better. */
export function listRunningInstances(dir = join(homedir(), '.devup')): RunningInstance[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }

  const out: RunningInstance[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.pid')) continue;
    try {
      const pid = Number(readFileSync(join(dir, entry), 'utf8').trim());
      if (!Number.isFinite(pid) || !pid || !pidAlive(pid)) continue;
      out.push({ name: entry.slice(0, -'.pid'.length), pid });
    } catch { /* not this one */ }
  }
  return out;
}

/** The instance whose service holds a port, if one of ours does.
 *
 *  Asked, not guessed. The holder pid belongs to a *service*, never to the
 *  daemon that spawned it, so there is nothing to match against a pid file —
 *  but every daemon already answers `status` with its services' pids, so the
 *  exact answer is one RPC away per instance. This only runs on a path that
 *  has already failed, so the cost is a message worth having.
 *
 *  Falls back to naming the only other instance when nothing answers: a
 *  daemon too old to have a control plane, or one still booting, should not
 *  turn a good hint into no hint. With several running and none answering it
 *  says nothing rather than picking one. */
export async function attributePort(
  holderPid: number | null,
  self: string,
  opts: {
    running?: RunningInstance[];
    socketPathFor?: (name: string) => string;
    status?: (socketPath: string) => Promise<{ services: Array<{ pid: number | null }> }>;
  } = {},
): Promise<RunningInstance | null> {
  const running = opts.running ?? listRunningInstances();
  const others = running.filter(i => i.name !== self);
  if (!others.length) return null;

  if (holderPid !== null && opts.socketPathFor && opts.status) {
    for (const instance of others) {
      try {
        const { services } = await opts.status(opts.socketPathFor(instance.name));
        if (services.some(s => s.pid === holderPid)) return instance;
      } catch { /* not answering — try the next, then fall back */ }
    }
  }

  return others.length === 1 ? others[0]! : null;
}
