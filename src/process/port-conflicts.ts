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

/** Scan every API-typed service for port conflicts. (Webs are usually managed
 *  by their own dev server which sometimes handles port collisions itself, so
 *  we leave them alone — matching the spawner's pre-flight scope.) */
export async function scanPortConflicts(services: ServiceConfig[]): Promise<PortConflict[]> {
  const apis = services.filter(s => s.type === 'api');
  const conflicts: PortConflict[] = [];
  for (const svc of apis) {
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
  for (const c of conflicts) {
    const holder = c.holder
      ? `pid=${c.holder.pid}  process=${c.holder.command}`
      : `(unable to identify holder${isUnix ? '' : ' — Windows not supported'})`;
    out(`  :${String(c.port).padEnd(6)} ${c.service.padEnd(maxName)}  ${holder}`);
  }
  out('');

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
