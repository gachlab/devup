import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { homedir, totalmem, freemem, cpus } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInterface } from 'node:readline';

import { ProcessManager } from '../process/manager.js';
import { LogSink } from '../process/log-sink.js';
import { groupByPhase, calcCpuPercent } from '../utils.js';
import { waitForPort } from '../process/health.js';
import { Broadcaster } from '../utils/broadcaster.js';
import { systemLoad } from '../utils/system-load.js';
import { startSocketServer, type SocketServerHandle } from '../control-plane/socket-server.js';
import { startExternals, stopExternals, type ExternalProc } from '../process/external.js';
import { releaseLazyProxy, classifyServices, rewriteServicePort } from '../lazy/classifier.js';
import { isRunning, waitForExit } from '../process/liveness.js';
import { createLazyProxy, type LazyProxy } from '../lazy/proxy.js';
import { watchConfig } from './config-watcher.js';
import { findConfigFile } from '../config/loader.js';

import type { DevStackConfig, ServiceConfig } from '../config/types.js';
import type { CliArgs } from '../config/cli.js';
import type { Platform } from '../platform/types.js';
import type { ProxyConfigProvider, ProxyOpts, ServiceState } from '../proxy-config/types.js';
import type { ProcessState } from '../process/types.js';

const SAFE = /[^a-zA-Z0-9._-]+/g;
const sanitize = (n: string) => n.replace(SAFE, '_').replace(/^_+|_+$/g, '') || 'devup';
const devupDir = () => join(homedir(), '.devup');

export function pidPathFor(projectName: string): string {
  return join(devupDir(), `${sanitize(projectName)}.pid`);
}
export function bootErrorPathFor(projectName: string): string {
  return join(devupDir(), `${sanitize(projectName)}.boot-error`);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Inspect the PID file. `pid=null` means no daemon recorded.
 *  `stale=true` means a pid file exists but the recorded pid is not alive. */
export function isDaemonRunning(projectName: string): { pid: number | null; stale: boolean } {
  const path = pidPathFor(projectName);
  if (!existsSync(path)) return { pid: null, stale: false };
  let pid: number;
  try {
    pid = Number(readFileSync(path, 'utf8').trim());
    if (!pid || !Number.isFinite(pid)) return { pid: null, stale: true };
  } catch {
    return { pid: null, stale: true };
  }
  return pidAlive(pid) ? { pid, stale: false } : { pid, stale: true };
}

// ── Daemon child body ──────────────────────────────────────────────────────

export interface DaemonOpts {
  config: DevStackConfig;
  services: ServiceConfig[];
  cliArgs: CliArgs;
  platform: Platform;
  env: Record<string, string>;
  baseCwd: string;
  proxyProvider: ProxyConfigProvider | null;
  proxyOpts: ProxyOpts | null;
}

/** Runs in the detached child process. Boots the stack, opens the control
 *  plane, writes the PID file when ready (the parent's success signal), then
 *  stays alive until SIGTERM/SIGINT. */
export async function daemonBody(opts: DaemonOpts): Promise<void> {
  const { config, services, cliArgs, platform, env, baseCwd, proxyProvider, proxyOpts } = opts;
  const projectName = config.name;
  const errPath = bootErrorPathFor(projectName);
  const pidPath = pidPathFor(projectName);

  mkdirSync(devupDir(), { recursive: true });
  if (existsSync(errPath)) { try { unlinkSync(errPath); } catch { /* ignore */ } }

  // Always write logs to disk in daemon mode (no terminal to scroll back through).
  const logSink = new LogSink({ projectName, rootDir: cliArgs.logDir });

  const logBus = new Broadcaster<{ svc: string; text: string }>();
  const stateBus = new Broadcaster<{ name: string; state: ProcessState }>();
  const removedBus = new Broadcaster<{ name: string }>();
  const lazyProxies = new Map<string, LazyProxy>();
  const prevCpuMap = new Map<string, { time: number; cpu: number }>();
  let externals: ExternalProc[] = [];
  let socket: SocketServerHandle | null = null;
  let healthTimer: NodeJS.Timeout | null = null;
  let proxyTimer: NodeJS.Timeout | null = null;
  let stopConfigWatcher: (() => void) | null = null;

  const writeDevupLog = (text: string) => {
    logSink.write('devup', text);
    logBus.emit({ svc: 'devup', text });
  };

  const mgr = new ProcessManager({
    baseCwd, env, platform,
    events: {
      onLog: (svcName, text) => {
        logSink.write(svcName, text);
        logBus.emit({ svc: svcName, text });
      },
      onStateChange: (name, state) => stateBus.emit({ name, state }),
      onServiceRemoved: (name) => {
        releaseLazyProxy(lazyProxies, name);
        // The CPU baseline is per name: a service re-added later under the same
        // name would be diffed against the old process's counter and report a
        // large negative percentage for one sample.
        prevCpuMap.delete(name);
        removedBus.emit({ name });
      },
    },
  });

  const cleanup = async (): Promise<void> => {
    if (healthTimer) clearInterval(healthTimer);
    if (proxyTimer) clearInterval(proxyTimer);
    if (stopConfigWatcher) { try { stopConfigWatcher(); } catch { /* ignore */ } }
    for (const p of lazyProxies.values()) p.destroy();
    if (socket) await socket.close().catch(() => {});
    await mgr.cleanup().catch(() => {});
    if (externals.length) {
      await stopExternals(externals, platform, {
        baseCwd, env,
        onLog: (svc, msg) => logSink.write(`ext:${svc}`, msg),
      }).catch(() => {});
    }
    if (proxyProvider && proxyOpts && cliArgs.proxy) {
      try { proxyProvider.clear(proxyOpts); } catch { /* ignore */ }
    }
    await logSink.close().catch(() => {});
    if (existsSync(pidPath)) { try { unlinkSync(pidPath); } catch { /* ignore */ } }
  };

  let shuttingDown = false;
  const onSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    cleanup().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  try {
    // ── Externals (DBs, queues) — must be healthy before phase 0 ──
    if (config.external?.length) {
      writeDevupLog(`▶ externals (${config.external.length})`);
      const result = await startExternals(config.external, {
        baseCwd, env, platform,
        onLog: (svc, msg) => { logSink.write(`ext:${svc}`, msg); logBus.emit({ svc: `ext:${svc}`, text: msg }); },
      });
      externals = result.procs;
      if (!result.allHealthy) {
        throw new Error(`externals failed: ${result.failed.join(', ')}`);
      }
    }

    // ── Boot phases ──
    if (cliArgs.lazy && config.lazy) {
      await bootLazy(mgr, services, config.lazy, cliArgs.lazyTimeout, lazyProxies);
    } else {
      await bootNormal(mgr, services);
    }

    // ── Control plane ──
    socket = await startSocketServer(projectName, {
      states: () => mgr.state,
      restart: (n) => mgr.restart(n),
      stop: (n) => mgr.stop(n),
      tailLogs: async (svcName, lines) => {
        const file = logSink.pathFor(svcName);
        if (!existsSync(file)) return [];
        return new Promise<string[]>((resolve, reject) => {
          const buf: string[] = [];
          const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }) });
          rl.on('line', l => { buf.push(l); if (buf.length > lines) buf.shift(); });
          rl.on('close', () => resolve(buf));
          rl.on('error', reject);
        });
      },
      watchLogs: (svcName, onLine) => logBus.subscribe(({ svc, text }) => {
        if (svcName === null || svc === svcName) onLine(svc, text);
      }),
      // Guarded here rather than per-emitter: a removed service can still
      // produce a state change — buffered stdout matching readyPattern after
      // the kill, a health probe landing late — and forwarding it pushes a
      // `status` frame *after* `removed`, re-adding it in every client.
      watchStatus: (onUpdate) => stateBus.subscribe(({ name, state }) => {
        if (!mgr.state.has(name)) return;
        onUpdate(name, state);
      }),
      watchRemoved: (onRemoved) => removedBus.subscribe(({ name }) => onRemoved(name)),
      async start(name) {
        const st = mgr.state.get(name);
        if (!st) throw new Error(`unknown service: ${name}`);
        // Liveness, not st.pid: a stopped service keeps a dead pid, so gating
        // on it would make this a permanent no-op for the one case it exists for.
        if (isRunning(st)) {
          // ...unless a stop is in flight. stop() only sends SIGTERM, so a
          // service that drains on shutdown still looks alive; returning here
          // would report success and leave it down.
          if (!st.intentionalStop) return true;
          await waitForExit(st, 5000);
        }
        // A queued auto-restart would otherwise spawn a second process for the
        // same name moments after this one.
        mgr.cancelPendingRestart(name);
        const proxy = lazyProxies.get(name);
        if (proxy) {
          // Through the proxy, never around it: spawning directly leaves its
          // serviceReady flag false and the next request starts a second process.
          return await proxy.ensureStarted();
        }
        await mgr.install(st.svc, st.colorIdx);
        await mgr.start(st.svc, st.colorIdx);
        const after = mgr.state.get(name);
        // Spawner returns normally after recording a crash (pre-build failed,
        // watch path missing, port taken), so "no exception" is not success.
        return !!after && after.status !== 'crashed';
      },

      async getStats() {
        const pids: number[] = [];
        const pidToName = new Map<number, string>();
        for (const [name, st] of mgr.state) {
          if (st.pid) { pids.push(st.pid); pidToName.set(st.pid, name); }
        }
        const cores = cpus().length;
        const raw = pids.length ? await platform.getProcessStats(pids) : new Map();
        const services: Record<string, { cpu: number; memMB: number }> = {};
        for (const [name] of mgr.state) {
          services[name] = { cpu: 0, memMB: 0 };
        }
        for (const [pid, data] of raw) {
          const name = pidToName.get(pid);
          if (!name) continue;
          const prev = prevCpuMap.get(name) ?? { time: Date.now(), cpu: 0 };
          const cpu = calcCpuPercent(data.cpuSeconds, prev.cpu, prev.time);
          prevCpuMap.set(name, { time: Date.now(), cpu: data.cpuSeconds });
          services[name] = { cpu: Math.round(cpu * 10) / 10, memMB: Math.round((data.rss / 1024) * 10) / 10 };
        }
        return {
          services,
          system: {
            totalMemMB: Math.round(totalmem() / 1024 / 1024),
            freeMemMB: Math.round(freemem() / 1024 / 1024),
            cpuCores: cores,
            ...systemLoad(cores),
          },
        };
      },
      getProxyInfo() {
        if (!proxyProvider || !proxyOpts || !cliArgs.proxy) return null;
        return {
          active: true,
          provider: proxyProvider.name,
          domain: proxyOpts.domain,
          tls: proxyOpts.tls,
          routes: proxyOpts.routes,
        };
      },
      getInfo() {
        return { project: projectName, profiles: config.profiles ?? {} };
      },
    }, { onLog: msg => writeDevupLog(msg) });

    // ── Health poller (keeps state.health fresh for control-plane consumers) ──
    healthTimer = setInterval(() => { void mgr.checkAllHealth(); }, 3000);

    // ── Proxy sync (write traefik/nginx/caddy config when state changes) ──
    if (proxyProvider && proxyOpts && cliArgs.proxy) {
      let lastContent: string | null = null;
      const sync = () => {
        const svcStates = new Map<string, ServiceState>();
        for (const [n, st] of mgr.state) {
          svcStates.set(n, { port: st.svc.port, health: st.health, realPort: (st.svc as { realPort?: number }).realPort });
        }
        const content = proxyProvider.generate(svcStates, proxyOpts);
        if (content === lastContent) return;
        lastContent = content;
        try { proxyProvider.write(content, proxyOpts); } catch { /* ignore — best-effort */ }
      };
      sync();
      proxyTimer = setInterval(sync, 3000);
    }

    // ── Hot-reload watcher (opt-in via --watch-config) ──
    if (cliArgs.watchConfig) {
      try {
        const configPath = findConfigFile(baseCwd, cliArgs.configPath);
        writeDevupLog(`👀 watching ${configPath}`);
        stopConfigWatcher = watchConfig({
          configPath, baseCwd, manager: mgr,
          log: msg => writeDevupLog(msg),
        });
      } catch (e: any) {
        writeDevupLog(`⚠ watch-config disabled: ${e.message ?? String(e)}`);
      }
    }

    // ── Write PID file (signals "ready" to the parent process) ──
    writeFileSync(pidPath, String(process.pid));
    writeDevupLog(`✓ daemon ready (pid=${process.pid})`);

    // Stay alive. The open socket server + child procs keep the event loop running.
    // SIGTERM/SIGINT handler does the actual exit.
  } catch (e: any) {
    try { writeFileSync(errPath, e.message ?? String(e)); } catch { /* ignore */ }
    try { writeDevupLog(`❌ boot failed: ${e.message ?? String(e)}`); } catch { /* ignore */ }
    await cleanup().catch(() => {});
    process.exit(1);
  }
}

async function bootNormal(mgr: ProcessManager, services: ServiceConfig[]): Promise<void> {
  const phases = groupByPhase(services);
  let colorIdx = 0;
  for (const num of Object.keys(phases).map(Number).sort((a, b) => a - b)) {
    for (const svc of phases[num]!) {
      const ci = colorIdx++;
      await mgr.install(svc, ci);
      await mgr.start(svc, ci);
    }
    const apis = phases[num]!.filter(s => s.type === 'api');
    if (apis.length) await Promise.all(apis.map(s => waitForPort(s.port, { timeout: 45000 })));
    phases[num]!.filter(s => s.type === 'web').forEach(s => {
      const st = mgr.state.get(s.name);
      if (st) st.status = 'running';
    });
  }
}

async function bootLazy(
  mgr: ProcessManager,
  services: ServiceConfig[],
  lazyCfg: NonNullable<DevStackConfig['lazy']>,
  lazyTimeout: number,
  lazyProxies: Map<string, LazyProxy>,
): Promise<void> {
  const { alwaysOn, lazy } = classifyServices(services, lazyCfg);
  const phases = groupByPhase(alwaysOn);
  let colorIdx = 0;
  for (const num of Object.keys(phases).map(Number).sort((a, b) => a - b)) {
    for (const svc of phases[num]!) {
      const ci = colorIdx++;
      await mgr.install(svc, ci);
      await mgr.start(svc, ci);
    }
    const apis = phases[num]!.filter(s => s.type === 'api');
    if (apis.length) await Promise.all(apis.map(s => waitForPort(s.port, { timeout: 45000 })));
    phases[num]!.filter(s => s.type === 'web').forEach(s => {
      const st = mgr.state.get(s.name);
      if (st) st.status = 'running';
    });
  }
  for (const svc of lazy) {
    const ci = colorIdx++;
    const rewritten = rewriteServicePort(svc);
    mgr.state.set(svc.name, {
      svc: rewritten, proc: null, pid: null,
      status: 'idle', health: 'idle',
      errors: 0, restarts: 0, startedAt: null,
      intentionalStop: false, colorIdx: ci, crashLog: null,
    });
    const proxy = createLazyProxy({
      listenPort: svc.port, targetPort: rewritten.realPort, timeoutMin: lazyTimeout,
      onDemandStart: async () => {
        await mgr.install(rewritten, ci);
        await mgr.start(rewritten, ci);
        const ok = await waitForPort(rewritten.realPort, { timeout: 45000 });
        const st = mgr.state.get(svc.name);
        if (st) { st.status = ok ? 'running' : 'timeout'; if (ok) st.health = 'up'; }
      },
      onIdleStop: () => {
        mgr.stop(svc.name);
        const st = mgr.state.get(svc.name);
        if (st) { st.status = 'idle'; st.health = 'idle'; st.pid = null; st.proc = null; st.startedAt = null; }
      },
      isAlive: () => {
        const st = mgr.state.get(svc.name);
        return !!st && !!st.proc && !st.proc.killed && st.health === 'up';
      },
    });
    lazyProxies.set(svc.name, proxy);
  }
}

// ── Parent process: spawn detached child and wait for ready signal ──────────

export interface DetachedOpts extends DaemonOpts {
  out?: (line: string) => void;
}

/** Runs in the parent process. Validates state, spawns the daemon child
 *  detached, polls for the PID file (ready) or boot-error file (failure),
 *  prints the welcome line, and returns the exit code. */
export async function runDetached(opts: DetachedOpts): Promise<number> {
  const out = opts.out ?? ((l: string) => process.stdout.write(l + '\n'));
  const projectName = opts.config.name;

  if (process.platform === 'win32') {
    out('❌ daemon mode (devup up -d) is not yet supported on Windows. Run `devup` to use the TUI instead.');
    return 1;
  }

  const existing = isDaemonRunning(projectName);
  if (existing.pid && !existing.stale) {
    out(`❌ daemon already running for "${projectName}" (pid=${existing.pid}). Run \`devup down\` to stop it.`);
    return 1;
  }
  if (existing.stale) {
    out(`ℹ removing stale pid file for "${projectName}"`);
    try { unlinkSync(pidPathFor(projectName)); } catch { /* ignore */ }
  }

  mkdirSync(devupDir(), { recursive: true });
  const errPath = bootErrorPathFor(projectName);
  const pidPath = pidPathFor(projectName);
  if (existsSync(errPath)) { try { unlinkSync(errPath); } catch { /* ignore */ } }

  // Strip the subcommand and detach flags from argv; the child reuses everything else.
  const filteredArgs = process.argv.slice(2).filter((arg, i) => {
    if (i === 0 && arg === 'up') return false;
    if (arg === '-d' || arg === '--detach') return false;
    return true;
  });

  out(`⏳ starting devup in detached mode for "${projectName}"...`);

  // Preserve any node-level args (e.g. --loader tsx in dev) so the child can be re-executed.
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...filteredArgs], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DEVUP_DAEMON_CHILD: '1' },
    cwd: opts.baseCwd,
  });
  child.unref();

  // Poll for the PID file (success) or boot-error file (failure). Max wait: 90s.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, 'utf8').trim());
      out('');
      out(`🚀 devup detached (PID ${pid})`);
      out('   inspect:  devup ctl status');
      out('   logs:     devup ctl logs <svc> --follow');
      out('   stop:     devup down');
      return 0;
    }
    if (existsSync(errPath)) {
      const msg = readFileSync(errPath, 'utf8').trim();
      out(`❌ daemon boot failed: ${msg}`);
      try { unlinkSync(errPath); } catch { /* ignore */ }
      return 1;
    }
    await sleep(200);
  }

  out(`❌ daemon did not become ready within 90s. Killing child (pid=${child.pid}).`);
  if (child.pid) { try { process.kill(child.pid, 'SIGTERM'); } catch { /* ignore */ } }
  return 1;
}

// ── devup down ─────────────────────────────────────────────────────────────

export async function stopDaemon(
  projectName: string,
  opts: { out?: (line: string) => void; gracePeriodMs?: number } = {},
): Promise<number> {
  const out = opts.out ?? ((l: string) => process.stdout.write(l + '\n'));
  const grace = opts.gracePeriodMs ?? 10_000;
  const status = isDaemonRunning(projectName);

  if (!status.pid) {
    out(`ℹ no daemon running for "${projectName}".`);
    return 1;
  }
  if (status.stale) {
    out(`ℹ stale pid file for "${projectName}" (pid=${status.pid} not alive). Removing.`);
    try { unlinkSync(pidPathFor(projectName)); } catch { /* ignore */ }
    return 1;
  }

  out(`⏳ stopping daemon (pid=${status.pid})...`);
  try {
    process.kill(status.pid, 'SIGTERM');
  } catch (e: any) {
    out(`❌ cannot signal pid=${status.pid}: ${e.message}`);
    return 1;
  }

  const deadline = Date.now() + grace;
  while (Date.now() < deadline) {
    if (!pidAlive(status.pid)) {
      out(`✓ stopped daemon (pid=${status.pid})`);
      const p = pidPathFor(projectName);
      if (existsSync(p)) { try { unlinkSync(p); } catch { /* ignore */ } }
      return 0;
    }
    await sleep(200);
  }

  out(`⚠ daemon did not exit within ${(grace / 1000).toFixed(0)}s; sending SIGKILL.`);
  try { process.kill(status.pid, 'SIGKILL'); } catch { /* ignore */ }
  const p = pidPathFor(projectName);
  if (existsSync(p)) { try { unlinkSync(p); } catch { /* ignore */ } }
  return 0;
}
