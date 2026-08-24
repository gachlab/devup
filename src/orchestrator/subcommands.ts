import { spawn } from 'node:child_process';
import { createReadStream, watchFile, unwatchFile, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { checkHealth } from '../process/health.js';
import { needsInstall, writeInstallStamp } from '../utils.js';
import { sendRpc, openStream, resolveSocket, assertSocketExists, createClient } from '../control-plane/client.js';
import {
  waitForServices, selectServices, forEachInPhaseOrder, DEFAULT_WAIT_TIMEOUT_MS,
  type WaitServiceResult,
} from '../control-plane/wait.js';
import { flagValue } from '../config/cli.js';
import { instanceFlag, describeStack } from '../config/instance.js';
import { parseSince } from '../process/log-reader.js';
import { MAX_FOLLOW_TAIL } from '../control-plane/socket-server.js';
import { stopDaemon } from './daemon.js';
import { findConfigFile, loadConfig } from '../config/loader.js';
import { validateConfig, formatValidationErrors, collectWarnings, formatValidationWarnings } from '../config/validator.js';
import { redactSecrets } from '../utils.js';
import type { DevStackConfig } from '../config/types.js';

const KNOWN = new Set(['logs', 'install', 'status', 'help', 'ctl', 'up', 'down', 'config', 'exec']);

/** Returns the subcommand name if the first arg is one we recognise, else null. */
export function detectSubcommand(argv: string[]): string | null {
  const first = argv[0];
  return first && KNOWN.has(first) ? first : null;
}

/** Every flag that takes a *separate* value.
 *
 *  One list, because there is one bug here and it keeps coming back: a value
 *  read as a positional argument. `--profile status` named a profile and was
 *  taken for the `status` command; `--config ./devup.config.ts api` had the
 *  path taken for a service name; `--instance e2e api` had `e2e` taken for
 *  one — which broke every `ctl` command against a named instance at once.
 *  Anything that reads positionals goes through `positionalArgs`. */
const VALUE_FLAGS = new Set([
  '--config', '--only', '--skip', '--services', '--profile', '--timeout',
  '--proxy-host', '--proxy-conf', '--proxy-entrypoint', '--once-timeout',
  '--log-dir', '--env', '--instance', '--lines', '--since', '--wait-timeout',
  '--port',
]);

/** The positional arguments in `argv`, skipping flags and the values they
 *  take. Stops at `--`, so `exec`'s command is never scanned. */
export function positionalArgs(argv: string[], from = 0): string[] {
  const out: string[] = [];
  for (let i = from; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') break;
    // The next token is skipped whether or not it looks like a value. Being
    // choosier reads better and changes nothing: this function returns only
    // positionals, so eating a flag is invisible either way, and eating a
    // would-be positional is what `--lines api` deserves.
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
}

/** A subcommand that was written *after* the flags, which devup does not
 *  accept — and used to fail silently by rendering the TUI instead.
 *
 *  `devup --instance e2e up -d` reads as "launch the TUI with these flags",
 *  so it sat there doing nothing while the user waited for a daemon. Returning
 *  the name lets the caller say what to type instead of leaving them to work
 *  it out. Stops at `--` so `exec`'s command is never scanned. */
export function misplacedSubcommand(argv: string[]): string | null {
  if (detectSubcommand(argv)) return null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') return null;
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    if (KNOWN.has(a)) return a;
  }
  return null;
}

interface SubOpts {
  config: DevStackConfig;
  /** The project name qualified by `--instance` — what every path is keyed by.
   *  Defaults to the project name, for callers with no instance. */
  instanceName?: string;
  /** The raw `--instance` value, for messages and command hints. */
  instance?: string;
  baseCwd: string;
  env: Record<string, string>;
  logDir?: string;
  out?: (line: string) => void;
}

function logRoot(config: DevStackConfig, override?: string, instanceName?: string): string {
  const root = override ?? join(homedir(), '.devup', 'logs');
  return join(root, sanitize(instanceName ?? config.name));
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'devup';
}

// ── devup logs <svc> [--follow] ──

export async function runLogs(argv: string[], opts: SubOpts): Promise<number> {
  const out = opts.out ?? ((l: string) => console.log(l));
  const follow = argv.includes('--follow') || argv.includes('-f');
  const svcArg = positionalArgs(argv)[0];
  if (!svcArg) {
    out('usage: devup logs <service> [--follow]');
    return 1;
  }
  const knownSvcs = opts.config.services.map(s => s.name);
  if (!knownSvcs.includes(svcArg)) {
    out(`Unknown service "${svcArg}". Known: ${knownSvcs.join(', ')}`);
    return 1;
  }
  const file = join(logRoot(opts.config, opts.logDir, opts.instanceName), `${sanitize(svcArg)}.log`);
  if (!existsSync(file)) {
    out(`No log file yet for "${svcArg}" (${file})`);
    return follow ? await followFile(file, out) : 1;
  }
  await streamFile(file, out);
  if (!follow) return 0;
  return await followFile(file, out, statSync(file).size);
}

async function streamFile(file: string, out: (l: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }) });
    rl.on('line', l => out(l));
    rl.on('close', () => resolve());
    rl.on('error', reject);
  });
}

async function followFile(file: string, out: (l: string) => void, startAt = 0): Promise<number> {
  let pos = startAt;
  // Wait for the file to appear if it doesn't yet
  while (!existsSync(file)) await new Promise(r => setTimeout(r, 500));
  return new Promise(resolve => {
    const tick = async () => {
      const size = statSync(file).size;
      if (size > pos) {
        await new Promise<void>(res => {
          const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8', start: pos, end: size - 1 }) });
          rl.on('line', l => out(l));
          rl.on('close', () => { pos = size; res(); });
        });
      } else if (size < pos) {
        // File was truncated / rotated — restart from beginning
        pos = 0;
      }
    };
    watchFile(file, { interval: 500 }, () => { void tick(); });
    process.once('SIGINT', () => { unwatchFile(file); resolve(0); });
  });
}

// ── devup install ──

export async function runInstall(opts: SubOpts & { concurrency?: number }): Promise<number> {
  const out = opts.out ?? ((l: string) => console.log(l));
  const concurrency = opts.concurrency ?? 4;
  const items = opts.config.services.map(s => ({ name: s.name, cwd: join(opts.baseCwd, s.cwd) }));
  const queue = [...items];
  const failed: string[] = [];
  let inFlight = 0;

  await new Promise<void>(resolve => {
    const pump = () => {
      while (inFlight < concurrency && queue.length) {
        const item = queue.shift()!;
        inFlight++;
        installOne(item.cwd, opts.env).then(ok => {
          inFlight--;
          if (ok) out(`✓ ${item.name}`);
          else { failed.push(item.name); out(`✗ ${item.name}`); }
          if (queue.length === 0 && inFlight === 0) resolve();
          else pump();
        });
      }
    };
    pump();
  });

  if (failed.length) {
    out(`\nfailed: ${failed.join(', ')}`);
    return 1;
  }
  out(`\n${items.length} services up to date`);
  return 0;
}

function installOne(cwd: string, env: Record<string, string>): Promise<boolean> {
  if (!existsSync(cwd)) return Promise.resolve(false);
  if (!needsInstall(cwd)) return Promise.resolve(true);
  return new Promise(resolve => {
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const proc = spawn(command, ['install'], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
    proc.on('close', code => {
      if (code === 0) { writeInstallStamp(cwd); resolve(true); } else resolve(false);
    });
    proc.on('error', () => resolve(false));
  });
}

// ── devup status ──

export async function runStatus(opts: SubOpts): Promise<number> {
  const out = opts.out ?? ((l: string) => console.log(l));
  out(`${opts.config.icon ?? '📦'} ${opts.config.name} — ${opts.config.services.length} services`);
  out('');

  const maxLen = Math.max(...opts.config.services.map(s => s.name.length), 12);
  out(`${'Service'.padEnd(maxLen)}  ${'Port'.padStart(5)}  ${'Type'.padEnd(4)}  Health`);
  out('-'.repeat(maxLen + 24));

  for (const svc of opts.config.services) {
    const { ok: up } = await checkHealth(svc.port, svc.healthCheck);
    const health = up ? '✓ up' : '✗ down';
    out(`${svc.name.padEnd(maxLen)}  ${String(svc.port).padStart(5)}  ${svc.type.padEnd(4)}  ${health}`);
  }
  return 0;
}

// ── devup ctl <method> [args] ──

interface CtlOpts {
  config: DevStackConfig;
  /** See SubOpts. */
  instanceName?: string;
  /** The raw `--instance` value, for messages and command hints. */
  instance?: string;
  out?: (line: string) => void;
  socketPath?: string;
}

/** What `logs.tail` and the `logs.follow` ack both say about a window. The
 *  fields are optional because a daemon older than 0.16.0 sends neither, and
 *  one older than 0.17.0 does not put them on the ack at all. */
type WindowInfo = { oldestRetained?: number | null; truncated?: boolean };
/** A `logs.tail` result: a window, plus the lines. */
type LogsTailShape = WindowInfo & { lines: string[] };

type ServiceRow = {
  name: string; status: string; health: string;
  port: number; type: string; pid: number | null;
  errors: number; restarts: number;
};

function fmtStatus(rows: ServiceRow[], out: (l: string) => void): void {
  const maxLen = Math.max(...rows.map(r => r.name.length), 8);
  for (const r of rows) {
    const pid = r.pid != null ? `pid=${r.pid}` : '        ';
    const name = r.name.padEnd(maxLen);
    const port = `:${r.port}`.padStart(6);
    const status = r.status.padEnd(8);
    const health = r.health.padEnd(4);
    out(`${name}  ${port}  ${status}  ${health}  ${pid}  errors=${r.errors}  restarts=${r.restarts}`);
  }
}

/** Which services a batch command was aimed at: positional names, a
 *  `--profile`, or `--all`.
 *
 *  Shared by `wait`, `start` and `restart` so the three cannot disagree about
 *  what `--profile e2e` means. Returns a message instead of throwing, because
 *  every caller wants to print it and return 1.
 *
 *  `defaultAll` is the difference between them: `wait` with no arguments
 *  sensibly means "everything", while `start`/`restart` with no arguments must
 *  not — silently restarting a whole stack because someone forgot to type a
 *  name is not a mistake worth being quiet about. */
export function resolveTargets(
  argv: string[],
  config: Pick<DevStackConfig, 'profiles'>,
  opts: { defaultAll: boolean; verb: string },
): { names: string[] | null; error?: string } {
  // devup's globals count too, not just ctl's own: `runCtl` gets the whole
  // argv, and index.ts really does honour `--config`, `--log-dir` and
  // `--instance` for ctl.
  const names = positionalArgs(argv, 1);

  const profile = flagValue(argv, '--profile');
  if (profile !== undefined) {
    const members = profile ? config.profiles?.[profile] : undefined;
    if (!members) {
      const available = Object.keys(config.profiles ?? {});
      return { names: null, error: `unknown profile: "${profile || '(missing)'}". ${available.length ? `Available: ${available.join(', ')}` : 'No profiles defined in config.'}` };
    }
    names.push(...members);
  }

  const all = argv.includes('--all');
  if (all && names.length) {
    return { names: null, error: '--all cannot be combined with named services or --profile' };
  }
  if (all) return { names: [] };            // empty means "everything the daemon has"
  if (names.length) return { names: [...new Set(names)] };
  if (opts.defaultAll) return { names: [] };
  return { names: null, error: `usage: devup ctl ${opts.verb} <service...> | --profile <name> | --all` };
}

/** One line per service as it settles, so a slow boot shows progress rather
 *  than a silent two minutes. Shared with `devup exec`, which reports the same
 *  wait. */
export function fmtSettled(svc: WaitServiceResult): string {
  if (svc.readiness !== 'ready') return `  ✗ ${svc.name}  ${svc.reason ?? `${svc.status}/${svc.health}`}`;
  const when = svc.readyAfterMs === null ? '' : `  ${(svc.readyAfterMs / 1000).toFixed(1)}s`;
  // A lazy service counts as ready without being up: its proxy is listening.
  // Saying so avoids "why is it idle if you told me it was ready".
  const note = svc.status === 'idle' ? '  idle (lazy — starts on demand)' : '';
  return `  ✓ ${svc.name}${when}${note}`;
}

export async function runCtl(argv: string[], opts: CtlOpts): Promise<number> {
  const out = opts.out ?? ((l: string) => process.stdout.write(l + '\n'));
  const method = argv[0];
  const follow = argv.includes('--follow') || argv.includes('-f');
  const socketPath = resolveSocket(opts.instanceName ?? opts.config.name, opts.socketPath);

  if (!method || method === 'help') {
    out('Usage: devup ctl <method> [args] [--follow]');
    out('  ping                         Check if devup is running');
    out('  status [--follow]            Service snapshot, or live updates');
    out('  wait [svc...] [--start]      Wait until services are ready; 0 when they are');
    out('  logs <svc> [--since <when>] [--lines <n>] [--follow]');
    out('                               Tail logs, or follow the live stream');
    out('  start <svc...> | --profile <p> | --all');
    out('                               Start stopped services, in config phase order');
    out('  debug <svc> [--off] [--port n] [--brk]');
    out('                               Restart a service under the Node inspector');
    out('  restart <svc...> | --profile <p> | --all [--wait]');
    out('                               Restart services, in config phase order');
    out('  stop <svc>                   Stop a service');
    return 0;
  }

  try {
    // The project as configured, not the qualified path key — that reads as
    // a project nobody has — and a start hint that carries the flag.
    assertSocketExists(socketPath, describeStack(opts.config.name, opts.instance), `devup up -d${instanceFlag(opts.instance)}`);
  } catch (e: any) {
    out(e.message);
    return 1;
  }

  try {
    if (method === 'ping') {
      const res = await sendRpc(socketPath, 'ping') as { ok: boolean; ts: number };
      out(`pong  ts=${res.ts}`);
      return 0;
    }

    if (method === 'status' && follow) {
      return await new Promise<number>(resolve => {
        const abort = openStream(socketPath, 'status.follow', {}, frame => {
          const ts = new Date().toISOString().slice(11, 23);
          // The stream carries more than one shape: `removed` frames are arrays
          // of names, not service rows. Treating them as rows reads `.name` off
          // a string and throws inside the frame handler.
          if (frame.event === 'removed') {
            for (const name of frame.data as string[]) {
              out(`[${ts}] ${String(name).padEnd(24)}  removed`);
            }
            return;
          }
          if (frame.event !== 'status') return;
          for (const r of frame.data as ServiceRow[]) {
            out(`[${ts}] ${r.name.padEnd(24)}  ${r.status}/${r.health}`);
          }
        }, err => { out(`error: ${err.message}`); resolve(1); },
        // Without this the daemon going down under us reads as a clean end of
        // stream and `devup ctl status --follow` exits 0 having said nothing —
        // in a script, indistinguishable from "you pressed Ctrl-C".
        () => { out('devup went away'); resolve(1); });
        process.once('SIGINT', () => { abort(); resolve(0); });
      });
    }

    if (method === 'wait') {
      const json = argv.includes('--json');
      const start = argv.includes('--start');
      let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
      const rawTimeout = flagValue(argv, '--timeout');
      if (rawTimeout !== undefined) {
        const secs = Number(rawTimeout);
        // A bad value falling back to the default is how someone spends an
        // afternoon wondering why their 5 s budget was ignored. `--timeout=5`
        // counts as given, too.
        if (!Number.isFinite(secs) || secs <= 0) {
          out(`invalid --timeout: ${rawTimeout || '(missing)'}`);
          return 1;
        }
        timeoutMs = secs * 1000;
      }

      // Positional names, minus flags and the value --timeout takes.
      const target = resolveTargets(argv, opts.config, { defaultAll: true, verb: 'wait' });
      if (!target.names) { out(target.error!); return 1; }
      const selection = target.names.length ? target.names : undefined;
      const client = createClient(socketPath);
      if (!json) {
        out(`⏳ waiting${selection ? ` for ${selection.length} service${selection.length === 1 ? '' : 's'}` : ''} (timeout ${Math.round(timeoutMs / 1000)}s)${start ? ', starting what is idle' : ''}`);
      }
      const res = await waitForServices(client, {
        services: selection,
        start,
        timeoutMs,
        onSettled: json ? undefined : svc => out(fmtSettled(svc)),
      });

      if (json) {
        out(JSON.stringify(res, null, 2));
      } else if (res.ok) {
        out(`✓ ready in ${(res.elapsedMs / 1000).toFixed(1)}s`);
      } else {
        const why = res.failedFast ? 'cannot become ready' : `not ready after ${(res.elapsedMs / 1000).toFixed(1)}s`;
        out(`✗ ${why}: ${res.notReady.map(s => s.name).join(', ')}`);
        for (const s of res.notReady) out(`    ${s.name}  ${s.reason ?? `${s.status}/${s.health}`}`);
      }
      return res.ok ? 0 : 1;
    }

    if (method === 'logs') {
      const svc = positionalArgs(argv, 1)[0];
      if (!svc) { out('usage: devup ctl logs <service> [--since <when>] [--lines <n>] [--follow]'); return 1; }

      const rawSince = flagValue(argv, '--since');
      let since: number | undefined;
      if (rawSince !== undefined) {
        try { since = parseSince(rawSince, Date.now()); }
        catch (e: any) { out(e.message); return 1; }
      }
      const rawLines = flagValue(argv, '--lines');
      let lines = 100;
      if (rawLines !== undefined) {
        const n = Number(rawLines);
        // Integer, not merely finite: `--lines 2.5` passed and the daemon then
        // clamped it to 1, which is not what anyone typed.
        if (!Number.isInteger(n) || n <= 0) { out(`invalid --lines: ${rawLines || '(missing)'}`); return 1; }
        lines = n;
      }

      /** The two things a window can fail to be, said the same way in both
       *  branches — a notice that only appears without `--follow` is a notice
       *  someone will not see when they most need it. */
      const reportWindow = (res: WindowInfo) => {
        // A fact, not a verdict. `oldestRetained` is when the log *starts*,
        // which on a stack booted a minute ago is simply when the service
        // first wrote — nothing was rotated. devup cannot tell "rotated away"
        // from "was not running yet" from here, so it says the true thing and
        // names both.
        if (since !== undefined && res.oldestRetained != null && res.oldestRetained > since) {
          out(`(devup's log for ${svc} starts at ${new Date(res.oldestRetained).toISOString()}, after the window you asked for —`);
          out(`  either it was not running yet, or the earlier lines have been rotated away)`);
        }
        // From the daemon, not from counting what came back: the cap keeps the
        // most recent, so a full-looking answer is exactly what a truncated
        // window looks like. And what was dropped is the *oldest* of the
        // window, so "there may be more" would point the wrong way.
        if (res.truncated) {
          out(`(more than ${lines} lines matched — the oldest were dropped; raise --lines to see them)`);
        }
      };

      if (!follow) {
        const res = await sendRpc(socketPath, 'logs.tail', { svc, lines, since }) as LogsTailShape;
        for (const l of res.lines) out(l);
        reportWindow(res);
        return 0;
      }

      // Both flags reach the stream: the replay is a window too, so
      // `--since 5m --follow` shows the window and then keeps going.
      //
      // The replay stays server-side — doing it here would leave a gap between
      // reading and subscribing, and a follow that drops lines is worse than
      // one that says less. The window notices ride on the ack, so the daemon
      // is asked once rather than twice.
      const replayCap = Math.min(lines, MAX_FOLLOW_TAIL);
      return await new Promise<number>(resolve => {
        const abort = openStream(socketPath, 'logs.follow', { svc, tail: replayCap, since }, frame => {
          out(frame.data as string);
        }, err => { out(`error: ${err.message}`); resolve(1); },
        () => { out('devup went away'); resolve(1); },
        ack => {
          // Printed before the replayed lines, which is where a notice about
          // that replay belongs. Older daemons send a bare `{ ok: true }` and
          // this says nothing, which is the honest answer for them.
          if (since !== undefined) reportWindow(ack as WindowInfo);
        });
        process.once('SIGINT', () => { abort(); resolve(0); });
      });
    }

    if (method === 'status' && !follow) {
      const json = argv.includes('--json');
      const res = await sendRpc(socketPath, 'status') as { services: ServiceRow[] };
      if (json) {
        out(JSON.stringify(res.services, null, 2));
      } else {
        if (!res.services.length) { out('(no services)'); return 0; }
        fmtStatus(res.services, out);
      }
      return 0;
    }

    if (method === 'debug') {
      // `ctl debug --off api` must not send svc="--off", and `--port 9230 api`
      // must not send svc="9230" — `--port` is in VALUE_FLAGS for that.
      const svc = positionalArgs(argv, 1)[0];
      if (!svc) { out('usage: devup ctl debug <service> [--off] [--port <n>] [--brk]'); return 1; }
      const enable = !argv.includes('--off');
      // Stops the service before its first line, for debugging the startup
      // path. It will not open its port until a debugger attaches and resumes.
      const brk = argv.includes('--brk');
      const portIdx = argv.indexOf('--port');
      let port: number | undefined;
      if (portIdx >= 0) {
        port = Number(argv[portIdx + 1]);
        // Without this, NaN survives as far as JSON.stringify, becomes null,
        // and the request quietly falls back to an OS-chosen port — the exact
        // opposite of what someone pinning a port for a launch config wants.
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          out(`invalid --port: ${argv[portIdx + 1] ?? '(missing)'}`);
          return 1;
        }
      }
      const res = await sendRpc(socketPath, 'debug', { svc, enable, port, brk }) as { debug: boolean; port: number | null; ok: boolean };
      if (!res.ok) { out(`✗ ${svc} did not come back up — check \`devup ctl logs ${svc}\``); return 1; }
      if (!res.debug) { out(`✓ ${svc} restarted without the inspector`); return 0; }
      const halted = brk ? ' — stopped on its first line, waiting for you' : '';
      out(res.port
        ? `✓ ${svc} running under the inspector on :${res.port}  —  attach to 127.0.0.1:${res.port}${halted}`
        : `✓ ${svc} restarted with the inspector; port not announced yet, see \`devup ctl status\``);
      return 0;
    }

    if (method === 'start' || method === 'restart') {
      const target = resolveTargets(argv, opts.config, { defaultAll: false, verb: method });
      if (!target.names) { out(target.error!); return 1; }

      const client = createClient(socketPath);
      const snapshot = (await client.status()).services;
      let names: string[];
      try {
        // Empty means --all: everything the *daemon* has, which is not
        // necessarily everything the config lists.
        names = target.names.length
          ? selectServices(snapshot, target.names).map(s => s.name)
          : snapshot.map(s => s.name);
      } catch (e: any) { out(`✗ ${e.message}`); return 1; }
      if (!names.length) { out('(no services)'); return 0; }

      // Ascending phase, concurrent within a phase. Restarting a whole stack
      // all at once is how a phase-4 web comes up against a phase-0 API that
      // is still going down, and then spends its restart budget finding out.
      const results = await forEachInPhaseOrder(snapshot, names, async name => {
        if (method === 'start') return { ok: (await client.start(name)).ok, skippedIdle: false };
        // `restart` resolves once the service has been respawned, not once it
        // is healthy — see the client. `--wait` below is how you ask for more.
        const res = await client.restart(name);
        return { ok: res.ok, skippedIdle: res.skippedIdle === true };
      });

      const failed = results.filter(r => r.error !== null || r.value?.ok === false);
      for (const r of results) {
        if (r.error) out(`✗ ${r.name}  ${r.error.message}`);
        else if (r.value?.ok === false) out(`✗ ${r.name} did not come up — check \`devup ctl logs ${r.name}\``);
        // A lazy service that was asleep had nothing to restart, and waking it
        // is not what someone resetting state between suites asked for.
        else if (r.value?.skippedIdle) out(`· ${r.name} left idle (lazy, was not running)`);
        else out(`✓ ${r.name} ${method === 'start' ? 'started' : 'restarted'}`);
      }

      const wait = argv.includes('--wait');
      if (!wait || failed.length) {
        if (failed.length) out(`${failed.length} of ${results.length} failed: ${failed.map(r => r.name).join(', ')}`);
        return failed.length ? 1 : 0;
      }

      const rawTimeout = flagValue(argv, '--timeout');
      let timeoutMs = 60_000;
      if (rawTimeout !== undefined) {
        const secs = Number(rawTimeout);
        if (!Number.isFinite(secs) || secs <= 0) { out(`invalid --timeout: ${rawTimeout || '(missing)'}`); return 1; }
        timeoutMs = secs * 1000;
      }
      out(`⏳ waiting for ${names.length === 1 ? names[0] : `${names.length} services`} to become healthy…`);
      const res = await waitForServices(client, { services: names, timeoutMs, onSettled: svc => out(fmtSettled(svc)) });
      if (res.ok) { out(`✓ healthy in ${(res.elapsedMs / 1000).toFixed(1)}s`); return 0; }
      out(`✗ not healthy after ${(res.elapsedMs / 1000).toFixed(1)}s: ${res.notReady.map(s => s.name).join(', ')}`);
      return 1;
    }

    if (method === 'stop') {
      const svc = positionalArgs(argv, 1)[0];
      if (!svc) { out('usage: devup ctl stop <service>'); return 1; }
      await sendRpc(socketPath, 'stop', { svc });
      out(`✓ stop sent to ${svc}`);
      return 0;
    }

    out(`unknown ctl method: ${method}. Run \`devup ctl help\` for usage.`);
    return 1;
  } catch (e: any) {
    out(`error: ${e.message}`);
    return 1;
  }
}

// ── devup config validate / show ──

interface ConfigSubOpts {
  cwd: string;
  configPath?: string;
  out?: (line: string) => void;
}

export async function runConfig(argv: string[], opts: ConfigSubOpts): Promise<number> {
  const out = opts.out ?? ((l: string) => process.stdout.write(l + '\n'));
  const subcmd = argv[0];
  const json = argv.includes('--json');

  if (!subcmd || subcmd === 'help') {
    out('Usage: devup config <subcommand>');
    out('  validate [--json]   Validate the config and print errors/warnings');
    out('  show [--no-redact]  Print the fully-resolved config as JSON');
    return 0;
  }

  let cfgPath: string;
  try { cfgPath = findConfigFile(opts.cwd, opts.configPath); }
  catch (e: any) { out(`❌ ${e.message}`); return 1; }

  let config: DevStackConfig;
  try { config = await loadConfig(cfgPath); }
  catch (e: any) { out(`❌ failed to load config: ${e.message}`); return 1; }

  if (subcmd === 'validate') {
    const errors = validateConfig(config, opts.cwd);
    const warnings = collectWarnings(config);
    if (json) {
      out(JSON.stringify({ valid: errors.length === 0, errors: errors.map(e => `${e.field}: ${e.message}`), warnings: warnings.map(w => `${w.field}: ${w.message}`) }, null, 2));
    } else {
      if (errors.length) { out(formatValidationErrors(errors)); }
      if (warnings.length) { out(formatValidationWarnings(warnings)); }
      if (!errors.length) out(`✓ config is valid (${config.services.length} services${warnings.length ? `, ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : ''})`);
    }
    return errors.length ? 1 : 0;
  }

  if (subcmd === 'show') {
    const noRedact = argv.includes('--no-redact');
    const resolved = noRedact ? config : redactConfig(config);
    out(JSON.stringify(resolved, null, 2));
    return 0;
  }

  out(`unknown config subcommand: ${subcmd}`);
  return 1;
}

function redactConfig(config: DevStackConfig): DevStackConfig {
  const clone = JSON.parse(JSON.stringify(config)) as DevStackConfig;
  for (const svc of clone.services ?? []) {
    if (svc.extraEnv) svc.extraEnv = redactSecrets(svc.extraEnv);
  }
  if (clone.env) clone.env = redactSecrets(clone.env);
  return clone;
}

// ── devup down ──

export async function runDown(opts: SubOpts): Promise<number> {
  const out = opts.out ?? ((l: string) => process.stdout.write(l + '\n'));
  return stopDaemon(opts.instanceName ?? opts.config.name, { out });
}

// ── devup help <subcommand> ──

export function runHelp(argv: string[], opts: { out?: (l: string) => void } = {}): number {
  const out = opts.out ?? ((l: string) => console.log(l));
  const sub = argv[0];
  if (sub === 'logs') {
    out('Usage: devup logs <service> [--follow|-f]');
    out('  Print the persisted log file for a service (works without devup running).');
    out('  --follow tails new lines as they are appended.');
    return 0;
  }
  if (sub === 'install') {
    out('Usage: devup install');
    out('  Run `npm install` across every service.cwd in parallel (max 4 at a time).');
    out('  Skips services whose .install-stamp matches package.json hash.');
    return 0;
  }
  if (sub === 'status') {
    out('Usage: devup status');
    out('  For each service, probes its health-check endpoint and prints up/down.');
    return 0;
  }
  if (sub === 'ctl') {
    out('Usage: devup ctl <method> [args] [--follow]');
    out('  Send commands to a running devup process via the control plane socket.');
    out('');
    out('  ping                         Check if devup is running');
    out('  status [--follow]            Service snapshot, or live state-change stream');
    out('  wait [svc...] [--profile p] [--start] [--timeout <s>] [--json]');
    out('                               Block until the named services are ready (all of');
    out('                               them by default). Exits 0 when they are, 1 naming');
    out('                               the ones that did not make it.');
    out('');
    out('                               A lazy service that is idle counts as ready: its');
    out('                               proxy is listening, so the stack serves — the first');
    out('                               request just pays the cold start. --start pays it');
    out('                               up front instead, in config phase order, which is');
    out('                               what a test suite with a short action timeout wants.');
    out('');
    out('                               Readiness is `health`, not `type`: a web with a');
    out('                               readyPattern announces itself like an API does.');
    out('');
    out('  logs <svc> [--since <when>] [--lines <n>] [--follow]');
    out('                               Tail last 100 lines, or follow the live stream.');
    out('                               --since takes a duration (30s, 5m, 2h, 1d), an ISO');
    out('                               timestamp, or epoch milliseconds — everything the');
    out('                               service has written since then. That is the window a');
    out('                               failing test wants: with --lines alone you have to');
    out('                               guess how many, and a noisy service pushes the part');
    out('                               you care about out of the tail before you ask.');
    out('  start <svc...> | --profile <p> | --all');
    out('                               Start stopped services. Ascending config phase,');
    out('                               concurrent within a phase — warming eight lazy');
    out('                               services one at a time is most of the reason');
    out('                               people write their own loop instead.');
    out('                               Exits 1 naming the ones that did not come up.');
    out('  debug <svc> [--off] [--port n] [--brk]');
    out('                               Restart the named service under the Node inspector');
    out('  restart <svc...> | --profile <p> | --all [--wait] [--timeout <s>]');
    out('                               Restart services, same ordering as start.');
    out('                               `restart --all` is what you want between test');
    out('                               suites: it resets in-memory state without');
    out('                               taking the stack down.');
    out('                               --wait blocks until they are healthy again.');
    out('');
    out('                               Neither takes an implicit "everything": say');
    out('                               --all if you mean it. Restarting a whole stack');
    out('                               because a name was forgotten is not a mistake');
    out('                               worth being quiet about.');
    out('  stop <svc>                   Stop the named service');
    out('');
    out('  devup must be running in the same project directory.');
    return 0;
  }
  if (sub === 'up') {
    out('Usage: devup up -d');
    out('  Boot the stack in detached/daemon mode (like `docker compose up -d`).');
    out('  Returns immediately once the stack is healthy; services keep running.');
    out('  Use `devup ctl status`, `devup ctl logs`, or `devup down` to interact.');
    out('  Not supported on Windows yet — use `devup` (TUI) instead.');
    return 0;
  }
  if (sub === 'exec') {
    out('Usage: devup exec [options] -- <cmd> [args...]');
    out('  Boot the stack if it is not already up, wait until it is ready, run the');
    out('  command against it, and stop only what this invocation started.');
    out('');
    out('  --start              Start idle lazy services before waiting, in config');
    out('                       phase order, so the first request does not pay the');
    out('                       cold start');
    out('  --wait-timeout <s>   Seconds to wait for readiness. Default: 120');
    out('                       (not --timeout: that one is the lazy idle timeout,');
    out('                       in minutes, and it still means that here)');
    out('  --fail-on-crash      Fail the run if a service crashed while the command');
    out('                       was running, even when the command itself passed');
    out('');
    out('  Service selection (--profile, --services, --only, --skip) and every other');
    out('  boot flag work as they do for `devup up -d`; they are passed to the daemon');
    out('  when this invocation is the one booting it.');
    out('');
    out('  Everything after `--` is the command, untouched — devup does not read its');
    out('  flags as its own.');
    out('');
    out('  Exit code is the command\'s, except: 1 if the stack never became ready,');
    out('  127 if the command could not be run, 128+n if a signal killed it.');
    out('');
    out('  An already-running daemon is reused and left up. One this invocation');
    out('  started is stopped when the command ends, whatever the command did.');
    return 0;
  }
  if (sub === 'down') {
    out('Usage: devup down');
    out('  Stop the daemon for the current project. SIGTERM with 10s grace,');
    out('  then SIGKILL. Removes the PID file and the control-plane socket.');
    return 0;
  }
  out('Subcommands:');
  out('  devup logs <service> [--follow]   Read the persisted log file');
  out('  devup install                     Concurrent npm install across services');
  out('  devup status                      Health check every service in config');
  out('  devup up -d                       Boot the stack in detached/daemon mode');
  out('  devup exec -- <cmd>               Boot if needed, wait, run <cmd>, tear down');
  out('  devup down                        Stop the running daemon');
  out('  devup ctl <method> [args]         Control a running devup (restart/stop/logs/...)');
  out('  devup help [<subcommand>]         Show detailed help for a subcommand');
  out('');
  out('No subcommand → launch the interactive TUI.');
  return 0;
}

void readFile;
void dirname;
void fileURLToPath;
