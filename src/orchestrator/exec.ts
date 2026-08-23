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
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient, resolveSocket } from '../control-plane/client.js';
import { waitForServices, UnknownServicesError, DEFAULT_WAIT_TIMEOUT_MS } from '../control-plane/wait.js';
import { fmtSettled } from './subcommands.js';
import { flagValue } from '../config/cli.js';
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

/** The argv devup should read as its own, for any subcommand.
 *
 *  Only `exec` takes a command, so only `exec` has to stop at `--`. Kept as
 *  one function because it has two callers in `main()` — the `-h`/`-v`
 *  short-circuit and `parseCliArgs` — and they must not disagree: scanning the
 *  whole argv for `--help` made `devup exec -- npx playwright test --help`
 *  print devup's usage and exit 0 without running anything.
 *
 *  `subcmd` is `detectSubcommand`'s answer, so an argument that merely looks
 *  like `exec` after the command does not trigger it. */
export function ownArgsFor(raw: string[], subcmd: string | null): string[] {
  return subcmd === 'exec' ? execOwnArgs(raw) : raw;
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
  const raw = flagValue(mine, '--wait-timeout');
  if (raw !== undefined) {
    const secs = Number(raw);
    // Not `|| default`: a bad value silently becoming 120 s is how someone
    // spends an afternoon wondering why their 5 s budget was ignored.
    if (!Number.isFinite(secs) || secs <= 0) {
      throw new Error(`invalid --wait-timeout: ${raw || '(missing)'}`);
    }
    waitTimeoutMs = secs * 1000;
  }

  // `--once` reaches the daemon child through `daemonChildArgs`, and the child
  // would then boot, tear everything down and exit — leaving `runDetached` to
  // wait out its full 90 s for a pid file that is never written.
  if (mine.includes('--once')) {
    throw new Error('--once cannot be combined with exec: exec already boots, waits and tears down');
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
  crashes: number;
}

function snapshotWindow(services: ServiceSnapshot[]): Map<string, CrashWindow> {
  return new Map(services.map(s => [s.name, { status: s.status, crashes: s.crashes }]));
}

/** Services that crashed between the two photographs.
 *
 *  `crashes` going up is the signal, and it has to be a **monotonic** counter:
 *  a service that died and came back reads healthy at both ends, so the count
 *  is the only trace left. `restarts` looks like it would do the job and does
 *  not — it is a budget, and `Restarter.restart` and `startService` both reset
 *  it to 0, so a suite whose own setup calls `devup ctl restart` would hide
 *  every crash that followed.
 *
 *  The second clause catches a service that ended the window crashed without
 *  having started it that way, for whatever the counter missed.
 *
 *  Deliberately not `errors`: it counts stderr lines, and plenty of healthy
 *  tools write to stderr — the Angular CLI does it constantly. Using it would
 *  make `--fail-on-crash` fire on nothing at all. */
export function crashedDuring(before: Map<string, CrashWindow>, after: ServiceSnapshot[]): string[] {
  const out: string[] = [];
  for (const svc of after) {
    const prev = before.get(svc.name);
    if (!prev) continue; // appeared mid-run (config reload) — not our window
    if (svc.crashes > prev.crashes) { out.push(svc.name); continue; }
    if (svc.status === 'crashed' && prev.status !== 'crashed') out.push(svc.name);
  }
  return out;
}

/** Exit code for a command killed by a signal, by shell convention. */
const SIGNAL_BASE = 128;
/** How long to let the daemon notice a service that died as the command ended.
 *  The count is bumped in the child's `close` handler, which is prompt but not
 *  synchronous with the command's own exit. */
const CRASH_SETTLE_MS = 750;
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

  // Ctrl-C, or a CI job-level SIGTERM, can arrive during the readiness wait —
  // up to two minutes of it. Node's default handler would kill us there, the
  // `finally` below would never run, and a daemon *we* started would be left
  // holding every port, so the next `devup up -d` refuses. Hence a handler
  // from the moment the daemon becomes ours, not from the moment the command
  // starts.
  let child: ChildProcess | null = null;
  let interrupted: NodeJS.Signals | null = null;
  const abort = new AbortController();
  const onSignal = (sig: NodeJS.Signals) => {
    if (interrupted) {
      // Second Ctrl-C: whatever we are doing is taking too long for the person
      // asking. Stand down and let the default handler have it, rather than
      // swallowing every signal and leaving them nothing short of SIGKILL.
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      process.kill(process.pid, sig);
      return;
    }
    interrupted = sig;
    // Ends the readiness wait on its next poll instead of at its deadline —
    // which can be two minutes away.
    abort.abort();
    try { child?.kill(sig); } catch { /* already gone */ }
    // No exit: the `finally` has to run, or a daemon we started is orphaned
    // holding every port.
  };
  const onInt = () => onSignal('SIGINT');
  const onTerm = () => onSignal('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

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
        signal: abort.signal,
        onSettled: svc => out(fmtSettled(svc)),
      });
    } catch (e: any) {
      out(`✗ ${e.message ?? String(e)}`);
      // Only for an actual selection mismatch. `waitForServices` talks to the
      // socket on its first line, so a dead or stale socket surfaces here too
      // — and telling someone to fix a profile when their daemon just died
      // sends them looking in the wrong place.
      if (!ownsDaemon && e instanceof UnknownServicesError) {
        out('    The daemon already running was started with a different set of services.');
        out('    Stop it with `devup down` and let this run boot its own, or match its selection.');
      }
      return 1;
    }
    // Interruption is checked first: an aborted wait is also an unready one,
    // and reporting "not ready" for a run somebody cancelled blames the stack
    // for the user's Ctrl-C — and returns 1 where the shell expects 130.
    if (interrupted || wait.aborted) {
      out(`⏹ interrupted${interrupted ? ` (${interrupted})` : ''} before the command started`);
      return SIGNAL_BASE + (signalNumber(interrupted ?? 'SIGINT') ?? 0);
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
      : await runCommand(flags.command[0]!, flags.command.slice(1), opts.baseCwd, opts.env, c => { child = c; });

    exitCode = result.signal
      ? SIGNAL_BASE + (signalNumber(result.signal) ?? 0)
      : result.code ?? 1;

    // ── 4. Did anything crash while it ran? ──
    if (flags.failOnCrash) {
      // A short settle first. The daemon counts a crash in the child's `close`
      // handler, and a service killed by the suite's last request may not have
      // reached it by the time the command's own exit unblocks us — so reading
      // immediately misses exactly the crash worth catching.
      await sleep(CRASH_SETTLE_MS);
      // And read it before teardown: stopping the daemon is itself a wave of
      // process exits, and reading after would report every service as dead.
      const crashed = crashedDuring(before, (await client.status()).services);
      if (crashed.length) {
        out(`✗ crashed while the command ran: ${crashed.join(', ')}`);
        out(`    inspect with \`devup ctl logs <svc>\`${ownsDaemon ? ' — the daemon is about to stop, so do it from the log files' : ''}`);
        if (exitCode === 0) exitCode = 1;
      }
    }
    return exitCode;
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    if (ownsDaemon) {
      out(`⏹ stopping the daemon we started`);
      await stopDaemon(projectName, { out }).catch(() => {});
    }
  }
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
  /** Hands the child back so the caller's signal handler can forward to it.
   *  The child usually gets the signal anyway — same process group in a
   *  terminal — but not when devup runs from a script that does not make one,
   *  and a duplicate SIGINT is harmless. */
  onSpawn: (child: ChildProcess) => void,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit' });
    onSpawn(child);
    child.on('error', (e: NodeJS.ErrnoException) => {
      process.stderr.write(`❌ cannot run "${cmd}": ${e.message}\n`);
      resolve({ code: e.code === 'ENOENT' ? ENOENT_CODE : 1, signal: null });
    });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

/** Signal number for the 128+n exit-code convention. From the OS table rather
 *  than a hand-written map: the numbers differ between platforms. */
function signalNumber(sig: NodeJS.Signals): number | undefined {
  return (constants.signals as unknown as Record<string, number>)[sig];
}
