/** `devup exec -- <cmd...>` — the mode between `--once` and `up -d`.
 *
 *  `--once` boots, waits, and tears everything down: it proves the stack comes
 *  up, and gives you no chance to run anything against it. `up -d` boots and
 *  leaves, so whoever wants to run a suite has to wait by hand and remember to
 *  tear down. `exec` is the one a harness actually wants:
 *
 *      boot if needed → wait until ready → run the command
 *                     → tear down only what we started → exit with its code
 *
 *  Three things make this belong here rather than in a shell script:
 *
 *  1. **Reuse or boot.** `up -d` refuses when a daemon is already running,
 *     which is the right failure for it — a CI job with an orphan daemon
 *     should stop rather than test against stale code. But it leaves a script
 *     parsing that message to decide. Here the decision is structural: an
 *     existing daemon is used and left alone, one we started is ours to stop.
 *  2. **Teardown on the error path.** A bash `trap` is forgotten, or it kills
 *     the stack the developer already had open. Same problem Playwright's
 *     `reuseExistingServer` exists to solve.
 *  3. **`--fail-on-crash`.** Whether a service crashed *while the command ran*
 *     needs the window photographed at both ends, and only the daemon has the
 *     counters. Without it a suite goes green while an API throws on every
 *     request. */
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { createClient, resolveSocket } from '../control-plane/client.js';
import { waitForServices, DEFAULT_WAIT_TIMEOUT_MS, type WaitServiceResult } from '../control-plane/wait.js';
import { isDaemonRunning, runDetached, stopDaemon, type DaemonOpts } from './daemon.js';
import type { ServiceSnapshot } from '../control-plane/types.js';

export interface ExecOpts extends DaemonOpts {
  /** Everything after `exec`, `--` and the command included. */
  argv: string[];
  /** Argv for the daemon child when we are the ones booting. Built by the
   *  caller, which is the only place that still has the raw `process.argv`. */
  childArgs: string[];
  /** Clear anything sitting on our ports before booting. Only called when we
   *  are the ones booting: a daemon we are reusing owns those ports. */
  ensurePortsFree: () => Promise<boolean>;
  out?: (line: string) => void;
  /** Testing seams. */
  socketPath?: string;
  spawnCommand?: (cmd: string, args: string[]) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface ExecFlags {
  start: boolean;
  failOnCrash: boolean;
  waitTimeoutMs: number;
  command: string[];
}

/** devup's own arguments out of a raw `exec` argv: everything up to the first
 *  `--`, subcommand included.
 *
 *  `parseCliArgs` reads the whole argv, so without this
 *  `devup exec -- npx playwright test --config pw.ts --timeout 30` hands devup
 *  the *command's* flags: `--timeout 30` becomes a 30-minute lazy idle timeout
 *  and `--config pw.ts` a devup config path. Silently, and only for the one
 *  subcommand that takes a command. */
export function execOwnArgs(raw: string[]): string[] {
  const dashdash = raw.indexOf('--');
  return dashdash === -1 ? raw : raw.slice(0, dashdash);
}

/** Argv for the daemon child when `exec` is the one booting it.
 *
 *  The subcommand has to go: `runDetached`'s default derivation would hand the
 *  child `exec -- npx playwright test`, and it would re-enter `exec` instead of
 *  becoming the daemon. Everything else — `--profile`, `--no-lazy`, `--proxy` —
 *  is a boot flag and belongs to the child. */
export function daemonChildArgs(raw: string[]): string[] {
  return execOwnArgs(raw).slice(1);
}

/** Split `exec`'s own flags from the command.
 *
 *  Everything after the first `--` is the command, untouched — including
 *  anything that looks like a devup flag. `npx playwright test --timeout 30`
 *  must not quietly become devup's lazy idle timeout. */
export function parseExecArgs(argv: string[]): ExecFlags {
  const dashdash = argv.indexOf('--');
  const mine = dashdash === -1 ? argv : argv.slice(0, dashdash);
  const command = dashdash === -1 ? [] : argv.slice(dashdash + 1);

  let waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
  const idx = mine.indexOf('--wait-timeout');
  if (idx >= 0) {
    const secs = Number(mine[idx + 1]);
    // Not `|| default`: a bad value silently becoming 120 s is how someone
    // spends an afternoon wondering why their 5 s budget was ignored.
    if (!Number.isFinite(secs) || secs <= 0) {
      throw new Error(`invalid --wait-timeout: ${mine[idx + 1] ?? '(missing)'}`);
    }
    waitTimeoutMs = secs * 1000;
  }

  return {
    start: mine.includes('--start'),
    failOnCrash: mine.includes('--fail-on-crash'),
    waitTimeoutMs,
    command,
  };
}

/** What we need to photograph before and after to answer "did anything crash
 *  while the command ran?". */
interface CrashWindow {
  status: string;
  restarts: number;
}

function snapshotWindow(services: ServiceSnapshot[]): Map<string, CrashWindow> {
  return new Map(services.map(s => [s.name, { status: s.status, restarts: s.restarts }]));
}

/** Services that crashed between the two photographs.
 *
 *  `restarts` going up is the reliable signal: the daemon bumps it for every
 *  auto-restart, so a service that died and came back is caught even though it
 *  reads healthy at both ends. A service that exhausted its restart budget
 *  never bumps it again, hence the second clause.
 *
 *  Deliberately not `errors`: it counts stderr lines, and plenty of healthy
 *  tools write to stderr — the Angular CLI does it constantly. Using it would
 *  make `--fail-on-crash` fire on nothing at all. */
export function crashedDuring(before: Map<string, CrashWindow>, after: ServiceSnapshot[]): string[] {
  const out: string[] = [];
  for (const svc of after) {
    const prev = before.get(svc.name);
    if (!prev) continue; // appeared mid-run (config reload) — not our window
    if (svc.restarts > prev.restarts) { out.push(svc.name); continue; }
    if (svc.status === 'crashed' && prev.status !== 'crashed') out.push(svc.name);
  }
  return out;
}

/** Exit code for a command killed by a signal, by shell convention. */
const SIGNAL_BASE = 128;
/** Exit code for "command not found", by shell convention. */
const ENOENT_CODE = 127;

export async function runExec(opts: ExecOpts): Promise<number> {
  const out = opts.out ?? ((l: string) => process.stdout.write(l + '\n'));
  const projectName = opts.config.name;

  let flags: ExecFlags;
  try { flags = parseExecArgs(opts.argv); }
  catch (e: any) { out(`❌ ${e.message}`); return 1; }

  if (!flags.command.length) {
    out('usage: devup exec [--start] [--wait-timeout <s>] [--fail-on-crash] -- <cmd> [args...]');
    out('');
    out('  Boots the stack if it is not already up, waits until it is ready,');
    out('  runs the command, and stops only what it started.');
    return 1;
  }

  // ── 1. Reuse or boot ──
  const existing = isDaemonRunning(projectName);
  let ownsDaemon = false;

  if (existing.pid && !existing.stale) {
    out(`↩ reusing the daemon already running for "${projectName}" (pid=${existing.pid}) — it will be left up`);
  } else {
    if (existing.stale) out(`ℹ clearing a stale pid file for "${projectName}"`);
    if (!await opts.ensurePortsFree()) return 1;
    const code = await runDetached({ ...opts, out, childArgs: opts.childArgs });
    if (code !== 0) return 1;
    ownsDaemon = true;
  }

  const socketPath = opts.socketPath ?? resolveSocket(projectName);
  const client = createClient(socketPath);

  // Everything from here on has to reach the teardown, including a throw.
  let exitCode = 1;
  try {
    // ── 2. Wait until ready ──
    //
    // The selection comes from *our* config and flags, and when we are reusing
    // a daemon that daemon may have been started with a different one —
    // `devup up -d --profile check-in` yesterday, `devup exec --profile e2e`
    // today. Running the suite against a stack that is missing services is the
    // failure `up -d`'s refusal exists to prevent, so this is an error, not
    // something to quietly narrow.
    const selection = opts.services.map(s => s.name);
    out(`⏳ waiting for ${selection.length} service${selection.length === 1 ? '' : 's'}…`);
    let wait;
    try {
      wait = await waitForServices(client, {
        services: selection,
        start: flags.start,
        timeoutMs: flags.waitTimeoutMs,
        onSettled: svc => out(formatSettled(svc)),
      });
    } catch (e: any) {
      out(`✗ ${e.message ?? String(e)}`);
      if (!ownsDaemon) {
        out('    The daemon already running was started with a different set of services.');
        out('    Stop it with `devup down` and let this run boot its own, or match its selection.');
      }
      return 1;
    }
    if (!wait.ok) {
      out(`✗ not ready after ${(wait.elapsedMs / 1000).toFixed(1)}s: ${wait.notReady.map(s => s.name).join(', ')}`);
      for (const s of wait.notReady) out(`    ${s.name}  ${s.reason ?? `${s.status}/${s.health}`}`);
      return 1;
    }
    out(`✓ ready in ${(wait.elapsedMs / 1000).toFixed(1)}s`);

    // ── 3. Run the command ──
    const before = snapshotWindow((await client.status()).services);
    out(`▶ ${flags.command.join(' ')}`);
    const result = opts.spawnCommand
      ? await opts.spawnCommand(flags.command[0]!, flags.command.slice(1))
      : await runCommand(flags.command[0]!, flags.command.slice(1), opts.baseCwd, opts.env);

    exitCode = result.signal
      ? SIGNAL_BASE + (signalNumber(result.signal) ?? 0)
      : result.code ?? 1;

    // ── 4. Did anything crash while it ran? ──
    if (flags.failOnCrash) {
      // Read the window before teardown: stopping the daemon is itself a
      // wave of process exits, and reading after it would report every
      // service as having died.
      const crashed = crashedDuring(before, (await client.status()).services);
      if (crashed.length) {
        out(`✗ crashed while the command ran: ${crashed.join(', ')}`);
        out(`    inspect with \`devup ctl logs <svc>\`${ownsDaemon ? ' — the daemon is about to stop, so do it from the log files' : ''}`);
        if (exitCode === 0) exitCode = 1;
      }
    }
    return exitCode;
  } finally {
    if (ownsDaemon) {
      out(`⏹ stopping the daemon we started`);
      await stopDaemon(projectName, { out }).catch(() => {});
    }
  }
}

function formatSettled(svc: WaitServiceResult): string {
  if (svc.readiness !== 'ready') return `  ✗ ${svc.name}  ${svc.reason ?? `${svc.status}/${svc.health}`}`;
  const when = svc.readyAfterMs === null ? '' : `  ${(svc.readyAfterMs / 1000).toFixed(1)}s`;
  const note = svc.status === 'idle' ? '  idle (lazy — starts on demand)' : '';
  return `  ✓ ${svc.name}${when}${note}`;
}

/** Run the command with our stdio, and report how it ended.
 *
 *  `stdio: 'inherit'` on purpose: a test runner's output is the point of the
 *  exercise, and buffering it would break every progress reporter. */
function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit' });

    // Forward the signal rather than dying on it: the teardown in the caller's
    // `finally` has to run, and it cannot if this process is already gone.
    // The child usually gets the signal anyway (same process group in a
    // terminal), but not when devup is run from a script that does not make
    // one, and a duplicate SIGINT is harmless.
    const forward = (sig: NodeJS.Signals) => { try { child.kill(sig); } catch { /* already gone */ } };
    const onInt = () => forward('SIGINT');
    const onTerm = () => forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);

    const done = (r: { code: number | null; signal: NodeJS.Signals | null }) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      resolve(r);
    };
    child.on('error', (e: NodeJS.ErrnoException) => {
      process.stderr.write(`❌ cannot run "${cmd}": ${e.message}\n`);
      done({ code: e.code === 'ENOENT' ? ENOENT_CODE : 1, signal: null });
    });
    child.on('close', (code, signal) => done({ code, signal }));
  });
}

/** Signal number for the 128+n exit-code convention. From the OS table rather
 *  than a hand-written map: the numbers differ between platforms. */
function signalNumber(sig: NodeJS.Signals): number | undefined {
  return (constants.signals as unknown as Record<string, number>)[sig];
}
