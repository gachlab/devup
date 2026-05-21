import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Platform } from '../platform/types.js';
import type { ServiceConfig } from '../config/types.js';
import type { ProcessState, ProcessManagerEvents } from './types.js';
import { checkHealth, deriveHealth, checkPort } from './health.js';
import { installService } from './installer.js';
import { buildProcessArgs, buildProcessEnv } from '../utils.js';

const MAX_RESTARTS = 3;
const BACKOFF_BASE_MS = 2000;

/** Accepts both '/foo/' (vim-style) and bare 'foo'. Case-insensitive by default. */
export function compileReadyPattern(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  const slashed = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
  try {
    if (slashed) return new RegExp(slashed[1]!, slashed[2] || 'i');
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/** Extracts the value tokens of `--watch` / `--watch-path` / `--watch=X` / `--watch-path=X`
 *  from a command's args list. Accepts both `--flag value` and `--flag=value` forms. */
export function extractWatchPaths(args: string[]): string[] {
  const watchFlags = new Set(['--watch', '--watch-path']);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (watchFlags.has(a)) {
      const v = args[i + 1];
      if (v && !v.startsWith('-')) { out.push(v); i++; }
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0 && watchFlags.has(a.slice(0, eq))) {
      out.push(a.slice(eq + 1));
    }
  }
  return out;
}

function lineBuffer(onLine: (line: string) => void) {
  let buf = '';
  return {
    push(chunk: Buffer) {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.length) onLine(line);
      }
    },
    flush() {
      if (buf.length) { onLine(buf); buf = ''; }
    },
  };
}

export class ProcessManager {
  readonly state = new Map<string, ProcessState>();
  private readonly procs = new Set<ChildProcess>();
  private readonly baseCwd: string;
  private readonly env: Record<string, string>;
  private readonly platform: Platform;
  private readonly events: ProcessManagerEvents;

  constructor(opts: {
    baseCwd: string;
    env: Record<string, string>;
    platform: Platform;
    events: ProcessManagerEvents;
  }) {
    this.baseCwd = opts.baseCwd;
    this.env = opts.env;
    this.platform = opts.platform;
    this.events = opts.events;
  }

  async install(svc: ServiceConfig, colorIdx?: number): Promise<boolean> {
    const cwd = join(this.baseCwd, svc.cwd);
    const idx = colorIdx ?? this.state.get(svc.name)?.colorIdx ?? 0;
    return installService(cwd, this.env, msg => this.log(svc.name, msg, idx));
  }

  async start(svc: ServiceConfig, colorIdx: number, isRestart = false): Promise<void> {
    const cwd = join(this.baseCwd, svc.cwd);

    // Port occupied check
    if (svc.type === 'api') {
      const occupied = await checkPort(svc.port);
      if (occupied && !isRestart) {
        this.log(svc.name, `⚠ port ${svc.port} already in use — skipping`, colorIdx);
        return;
      }
    }

    // preBuild: run synchronously before spawning the service.
    if (svc.preBuild) {
      const built = await this.runPreBuild(svc, cwd, colorIdx);
      if (!built) {
        // Record crashed state so the UI shows the failure.
        this.recordCrashedState(svc, colorIdx);
        return;
      }
    }

    const args = buildProcessArgs(svc);

    // Pre-flight: every --watch / --watch-path must resolve to an existing path.
    // Catches stale config after a rebase that renamed directories — Node 22 watch
    // would die with a cryptic message buried in stderr.
    const missingWatchPaths = extractWatchPaths(args)
      .filter(p => !existsSync(resolve(cwd, p)));
    if (missingWatchPaths.length) {
      this.log(svc.name, `⚠ missing watch paths: ${missingWatchPaths.join(', ')}`, colorIdx);
      this.recordCrashedState(svc, colorIdx);
      return;
    }

    const env = buildProcessEnv(svc, this.env);
    const proc = spawn(svc.cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

    const prev = this.state.get(svc.name);
    const state: ProcessState = {
      svc, proc, pid: proc.pid ?? null,
      status: 'starting', health: 'wait',
      errors: prev?.errors ?? 0,
      restarts: prev?.restarts ?? 0,
      startedAt: Date.now(),
      intentionalStop: false,
      colorIdx,
    };
    this.state.set(svc.name, state);
    this.procs.add(proc);
    this.events.onStateChange(svc.name, state);

    const readyRegex = compileReadyPattern(svc.readyPattern);
    const markReadyIfMatch = (line: string) => {
      if (!readyRegex || state.health === 'up') return;
      if (readyRegex.test(line)) {
        state.health = 'up';
        if (state.status === 'starting') state.status = 'running';
        this.events.onStateChange(svc.name, state);
      }
    };

    const errorRegex = compileReadyPattern(svc.errorPattern); // reuses same /pattern/flags grammar
    const countsAsError = (line: string) => errorRegex ? errorRegex.test(line) : true;

    const stdoutBuf = lineBuffer(line => {
      markReadyIfMatch(line);
      this.log(svc.name, line, colorIdx);
    });
    const stderrBuf = lineBuffer(line => {
      if (countsAsError(line)) state.errors += 1;
      markReadyIfMatch(line);
      this.log(svc.name, line, colorIdx);
    });

    proc.stdout?.on('data', (d: Buffer) => stdoutBuf.push(d));
    proc.stderr?.on('data', (d: Buffer) => stderrBuf.push(d));
    proc.stdout?.on('end', () => stdoutBuf.flush());
    proc.stderr?.on('end', () => stderrBuf.flush());

    proc.on('close', code => {
      this.procs.delete(proc);
      // Tear down the side-car watch process when the main one stops.
      this.stopWatchProc(state);
      if (state.intentionalStop) { state.intentionalStop = false; return; }
      if (code === 0) {
        state.status = 'stopped'; state.health = 'down';
        this.events.onStateChange(svc.name, state);
        return;
      }
      state.status = 'crashed'; state.health = 'down';
      this.log(svc.name, `❌ exited with code ${code}`, colorIdx);
      this.events.onStateChange(svc.name, state);

      if (state.restarts < MAX_RESTARTS) {
        state.restarts++;
        const delay = BACKOFF_BASE_MS * Math.pow(2, state.restarts - 1);
        this.log(svc.name, `🔄 auto-restart ${state.restarts}/${MAX_RESTARTS} in ${delay}ms...`, colorIdx);
        setTimeout(() => this.start(svc, colorIdx, true), delay);
      } else {
        this.log(svc.name, '⛔ max restarts reached', colorIdx);
      }
    });

    // watchBuild: side-car process running alongside the service.
    if (svc.watchBuild) {
      state.watchProc = this.spawnWatchBuild(svc, cwd, env, colorIdx);
    }

    this.log(svc.name, isRestart ? `🔄 restarted (:${svc.port})` : `🚀 started (:${svc.port})`, colorIdx);
  }

  private runPreBuild(svc: ServiceConfig, cwd: string, colorIdx: number): Promise<boolean> {
    this.log(svc.name, `🔨 preBuild: ${svc.preBuild}`, colorIdx);
    return new Promise(resolve => {
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : 'sh';
      const shellFlag = isWin ? '/c' : '-c';
      const env = buildProcessEnv(svc, this.env);
      const child = spawn(shell, [shellFlag, svc.preBuild!], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

      const outBuf = lineBuffer(line => this.log(svc.name, `[build] ${line}`, colorIdx));
      const errBuf = lineBuffer(line => this.log(svc.name, `[build] ${line}`, colorIdx));
      child.stdout?.on('data', (d: Buffer) => outBuf.push(d));
      child.stderr?.on('data', (d: Buffer) => errBuf.push(d));

      child.on('error', err => {
        this.log(svc.name, `[build] ❌ ${err.message}`, colorIdx);
        resolve(false);
      });
      child.on('close', code => {
        outBuf.flush(); errBuf.flush();
        if (code === 0) {
          this.log(svc.name, `[build] ✅ done`, colorIdx);
          resolve(true);
        } else {
          this.log(svc.name, `[build] ❌ exited with code ${code}`, colorIdx);
          resolve(false);
        }
      });
    });
  }

  private spawnWatchBuild(svc: ServiceConfig, cwd: string, env: Record<string, string>, colorIdx: number): ChildProcess {
    this.log(svc.name, `👀 watchBuild: ${svc.watchBuild}`, colorIdx);
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : 'sh';
    const shellFlag = isWin ? '/c' : '-c';
    const child = spawn(shell, [shellFlag, svc.watchBuild!], {
      cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outBuf = lineBuffer(line => this.log(svc.name, `[watch] ${line}`, colorIdx));
    const errBuf = lineBuffer(line => this.log(svc.name, `[watch] ${line}`, colorIdx));
    child.stdout?.on('data', (d: Buffer) => outBuf.push(d));
    child.stderr?.on('data', (d: Buffer) => errBuf.push(d));
    child.on('error', err => this.log(svc.name, `[watch] ❌ ${err.message}`, colorIdx));
    return child;
  }

  /** Create a state entry in 'crashed' status without spawning a process (used when preBuild fails). */
  private recordCrashedState(svc: ServiceConfig, colorIdx: number): void {
    const prev = this.state.get(svc.name);
    this.state.set(svc.name, {
      svc, proc: null, pid: null,
      status: 'crashed', health: 'down',
      errors: prev?.errors ?? 0,
      restarts: prev?.restarts ?? 0,
      startedAt: null,
      intentionalStop: false,
      colorIdx,
    });
    this.events.onStateChange(svc.name, this.state.get(svc.name)!);
  }

  stop(name: string): void {
    const st = this.state.get(name);
    if (!st?.proc || !st.pid) return;
    st.intentionalStop = true;
    this.platform.killTree(st.pid);
    this.stopWatchProc(st);
  }

  private stopWatchProc(state: ProcessState): void {
    const wp = state.watchProc;
    if (!wp || !wp.pid) return;
    try { this.platform.killTree(wp.pid); } catch { /* already dead */ }
    state.watchProc = null;
  }

  async restart(name: string): Promise<void> {
    const st = this.state.get(name);
    if (!st) return;
    this.stop(name);
    // Manual restart: reset auto-restart counter so user gets a fresh budget
    st.restarts = 0;
    const delay = st.proc ? 1500 : 100;
    await new Promise(r => setTimeout(r, delay));
    await this.start(st.svc, st.colorIdx, true);
    this.log(name, '🔄 manual restart', st.colorIdx);
  }

  async checkAllHealth(): Promise<void> {
    for (const [name, st] of this.state) {
      if (!st.pid || st.status === 'idle') {
        st.health = st.status === 'idle' ? 'idle' : 'down';
        continue;
      }
      // Grace period: suppress probes during the first N seconds after startedAt.
      // Keeps state.errors clean during slow boots (Angular cold-start, etc.).
      const startPeriodMs = (st.svc.healthCheck?.startPeriod ?? 0) * 1000;
      if (startPeriodMs > 0 && st.startedAt && Date.now() - st.startedAt < startPeriodMs) {
        continue; // status stays 'starting', health stays 'wait'
      }
      const isUp = await checkHealth(st.svc.port, st.svc.healthCheck);
      const prev = st.health;
      st.health = deriveHealth(isUp, st.status);
      if (st.health === 'up' && st.status === 'starting') st.status = 'running';
      if (prev !== st.health) this.events.onStateChange(name, st);
    }
  }

  async cleanup(opts: { gracePeriodMs?: number } = {}): Promise<void> {
    const grace = opts.gracePeriodMs ?? 3000;
    const procs = [...this.procs];
    if (!procs.length) return;

    for (const proc of procs) {
      const st = this.findStateByProc(proc);
      if (st) {
        st.intentionalStop = true;
        this.stopWatchProc(st);
      }
      if (proc.pid) this.platform.killTree(proc.pid);
    }
    // Any side-car watch processes whose service hasn't been seen above (e.g. preBuild-failed services).
    for (const st of this.state.values()) this.stopWatchProc(st);

    const waits = procs.map(p =>
      p.exitCode !== null || p.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>(resolve => p.once('close', () => resolve())),
    );

    let timedOut = false;
    await Promise.race([
      Promise.all(waits),
      new Promise<void>(resolve => setTimeout(() => { timedOut = true; resolve(); }, grace)),
    ]);

    if (timedOut) {
      for (const proc of procs) {
        if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
          this.platform.killTree(proc.pid, 'SIGKILL');
        }
      }
      await Promise.race([
        Promise.all(waits),
        new Promise<void>(resolve => setTimeout(resolve, 1000)),
      ]);
    }
  }

  private findStateByProc(proc: ChildProcess): ProcessState | undefined {
    for (const st of this.state.values()) if (st.proc === proc) return st;
    return undefined;
  }

  private log(name: string, text: string, colorIdx: number): void {
    this.events.onLog(name, text, colorIdx);
  }
}
