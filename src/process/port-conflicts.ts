/** Find and resolve conflicts on devup-managed ports — i.e. some other
 *  process is already listening on a port we want, so the spawn would
 *  fail with EADDRINUSE.
 *
 *  Resolution is offered as a pre-boot step in three flavours:
 *    1. `--kill-port-conflicts` flag → auto-kill, no prompt.
 *    2. Interactive TTY → list conflicts, ask for confirmation.
 *    3. Non-interactive (CI, piped) → fail with the list as instructions.
 *
 *  Detection uses `lsof` on Linux/macOS. Windows support is intentionally
 *  out of scope for v1 (daemon mode itself doesn't run on Windows yet).
 *  When `lsof` is unavailable the conflict is reported without a holder
 *  (the user gets the port number but not the PID). */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { isPortBindable } from './health.js';
import type { ServiceConfig } from '../config/types.js';

const execAsync = promisify(exec);

export interface PortHolder {
  pid: number;
  command: string;
}

export interface PortConflict {
  service: string;
  port: number;
  holder: PortHolder | null;
}

/** Names another devup instance that may be holding a port, and how to stop
 *  it. Injected rather than imported so this module stays about ports; see
 *  `orchestrator/instances`. */
export interface BlamedInstance {
  name: string;
  /** Whether it is another instance of *this* project — the case `--instance`
   *  creates. A different project's daemon that happens to configure the same
   *  port is a different situation entirely. */
  sameProject: boolean;
  /** The command that stops it, when one typed here can reach it. Built by the
   *  caller, which knows the project name — deriving it here by cutting a
   *  qualified name at a dash would misname the default instance of any
   *  project whose own name has one. */
  stopCommand: string | null;
}
export type AttributeHolder = (conflict: PortConflict) => BlamedInstance | null;

const isUnix = process.platform === 'linux' || process.platform === 'darwin';

/** Run `lsof` to find what's listening on a port. Returns the first matching
 *  PID + command, or null if nothing's there (or lsof isn't available). */
export async function findPortHolder(port: number): Promise<PortHolder | null> {
  if (!isUnix) return null;
  try {
    // -nP    no DNS / port-name resolution (fast)
    // -iTCP:N restrict to TCP port N
    // -sTCP:LISTEN only LISTEN state (skip established/closed)
    // -F pcn  output: pid + command, machine-readable
    const { stdout } = await execAsync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -F pcn`);
    return parseLsof(stdout);
  } catch {
    // lsof exits non-zero when nothing matches OR when lsof is missing.
    return null;
  }
}

function parseLsof(stdout: string): PortHolder | null {
  // -F output: groups of fields, one per line, prefixed by a tag char.
  //   p<pid> c<command> n<name>  …
  let pid: number | null = null;
  let cmd = '';
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      // New record. Emit the previous one if complete.
      if (pid != null) return { pid, command: cmd || 'unknown' };
      pid = Number(value);
    } else if (tag === 'c') {
      cmd = value;
    }
  }
  if (pid != null) return { pid, command: cmd || 'unknown' };
  return null;
}

/** Scan every configured service for port conflicts. APIs and webs both —
 *  pre-boot we want to surface any conflict the user will hit during spawn,
 *  regardless of service type. Web dev servers (Vite, ng serve, etc.) handle
 *  port-collision retry at runtime, but pre-boot the user typically wants to
 *  reclaim THE configured port, not let the dev server roll it. */
export async function scanPortConflicts(services: ServiceConfig[]): Promise<PortConflict[]> {
  const conflicts: PortConflict[] = [];
  for (const svc of services) {
    const bindable = await isPortBindable(svc.port);
    if (bindable) continue;
    const holder = await findPortHolder(svc.port);
    conflicts.push({ service: svc.name, port: svc.port, holder });
  }
  return conflicts;
}

/** SIGTERM with grace, falling back to SIGKILL after `graceMs`. */
export async function killHolder(pid: number, graceMs = 3000): Promise<boolean> {
  try { process.kill(pid, 'SIGTERM'); } catch { return false; }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  // Final check: did SIGKILL land?
  await sleep(100);
  return !pidAlive(pid);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export interface ResolveOpts {
  autoKill: boolean;
  /** Optional: names another devup instance behind a conflict. */
  attribute?: AttributeHolder;
  out: (line: string) => void;
  /** Returns true if user confirms, false otherwise. Skipped when autoKill or
   *  when stdin is not a TTY. */
  prompt?: () => Promise<boolean>;
  /** If stdin is not a TTY and autoKill is false, resolution fails by default.
   *  Tests pass `isInteractive: true` with a mocked prompt to bypass. */
  isInteractive?: boolean;
}

/** Returns true if all conflicts were resolved (no holders left), false if the
 *  user declined or some kills failed. */
export async function resolvePortConflicts(
  conflicts: PortConflict[],
  opts: ResolveOpts,
): Promise<boolean> {
  if (!conflicts.length) return true;

  const { autoKill, out, prompt, isInteractive = process.stdin.isTTY ?? false } = opts;

  // Render the conflict list.
  out('⚠ Port conflicts detected on the following services:');
  out('');
  const maxName = Math.max(...conflicts.map(c => c.service.length), 8);
  let blamed: BlamedInstance | null = null;
  for (const c of conflicts) {
    const holder = c.holder
      ? `pid=${c.holder.pid}  process=${c.holder.command}`
      : `(unable to identify holder${isUnix ? '' : ' — Windows not supported'})`;
    out(`  :${String(c.port).padEnd(6)} ${c.service.padEnd(maxName)}  ${holder}`);
    blamed ??= opts.attribute?.(c) ?? null;
  }
  out('');

  // Instances share their project's ports on purpose, so this is the expected
  // way two of them collide — and "some process has your port" would send
  // someone hunting for a process that is their own devup.
  if (blamed?.sameProject) {
    out(`That is another instance of this project: ${blamed.name}.`);
    out('Instances have separate sockets and logs but the *same* ports, so only one can serve at a time.');
    out(`Stop it with \`${blamed.stopCommand}\`, or give this one different ports in its config.`);
    out('');
  } else if (blamed) {
    // A different project's devup. Its ports are not ours by design, so this
    // is an ordinary conflict — worth naming, not worth refusing, and `devup
    // down` typed here would stop *our* daemon rather than reaching theirs.
    out(`Those belong to devup running a different project: ${blamed.name}.`);
    out('Stop it from its own directory, or give one of the two different ports.');
    out('');
  }

  // Refused, not warned — but only for a sibling instance. Killing its
  // services hands them straight to *its* auto-restarter, which respawns them
  // seconds later: the ports are taken again, this boot fails to bind anyway,
  // and the churn is exactly what the "a daemon is already running" guard
  // exists to prevent.
  //
  // A different project's daemon is not refused. Its ports colliding with ours
  // is an ordinary conflict that `--kill-port-conflicts` has always been
  // allowed to resolve, and taking that away would break CI that relies on it.
  if (blamed?.sameProject) {
    out(autoKill
      ? 'Not killing them despite --kill-port-conflicts: they belong to a running devup,'
      : 'Not offering to kill them: they belong to a running devup,');
    out('whose auto-restarter would bring them straight back — the ports would be taken again,');
    out('this boot would fail to bind anyway, and the churn is what the already-running guard exists to prevent.');
    out(`Stop it first: \`${blamed.stopCommand}\`.`);
    return false;
  }

  if (autoKill) {
    return await killAll(conflicts, out);
  }

  if (!isInteractive || !prompt) {
    out('Re-run with --kill-port-conflicts to take them over, or stop them yourself.');
    return false;
  }

  const confirmed = await prompt();
  if (!confirmed) {
    out('Aborted — no processes killed.');
    return false;
  }
  return await killAll(conflicts, out);
}

async function killAll(conflicts: PortConflict[], out: (l: string) => void): Promise<boolean> {
  let allOk = true;
  for (const c of conflicts) {
    if (!c.holder) {
      out(`✗ :${c.port} ${c.service}: holder unknown, cannot kill — skipped`);
      allOk = false;
      continue;
    }
    const ok = await killHolder(c.holder.pid);
    if (ok) {
      out(`✓ :${c.port} ${c.service}: killed pid=${c.holder.pid}`);
    } else {
      out(`✗ :${c.port} ${c.service}: pid=${c.holder.pid} survived SIGKILL`);
      allOk = false;
    }
  }
  return allOk;
}
