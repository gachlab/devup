import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ServiceConfig } from '../config/types.js';
import type { ProcessState, ProcessManagerEvents } from './types.js';
import { isPortBindable } from './health.js';
import { buildProcessArgs, buildProcessEnv } from '../utils.js';
import { lineBuffer, compileReadyPattern, extractWatchPaths } from './internals.js';
import type { Lifecycle } from './lifecycle.js';

const CRASH_LOG_LINES = 20;
const STARTUP_TIMEOUT_DEFAULT_MS = 45_000;

interface SpawnerOpts {
  baseCwd: string;
  env: Record<string, string>;
  state: Map<string, ProcessState>;
  procs: Set<ChildProcess>;
  events: ProcessManagerEvents;
  lifecycle: Lifecycle;
  onCrash: (svc: ServiceConfig, state: ProcessState, colorIdx: number) => void;
}

export class Spawner {
  private readonly baseCwd: string;
  private readonly env: Record<string, string>;
  private readonly state: Map<string, ProcessState>;
  private readonly procs: Set<ChildProcess>;
  private readonly events: ProcessManagerEvents;
  private readonly lifecycle: Lifecycle;
  private readonly onCrash: SpawnerOpts['onCrash'];
  private readonly startupTimers = new Map<string, NodeJS.Timeout>();

  constructor(opts: SpawnerOpts) {
    this.baseCwd = opts.baseCwd;
    this.env = opts.env;
    this.state = opts.state;
    this.procs = opts.procs;
    this.events = opts.events;
    this.lifecycle = opts.lifecycle;
    this.onCrash = opts.onCrash;
  }

  async start(svc: ServiceConfig, colorIdx: number, isRestart = false): Promise<void> {
    const cwd = join(this.baseCwd, svc.cwd);

    // Clear any previous startup timer for this service on restart.
    this.clearStartupTimer(svc.name);

    if (svc.type === 'api') {
      const bindable = await isPortBindable(svc.port);
      if (!bindable && !isRestart) {
        this.log(svc.name, `⚠ port ${svc.port} already in use — skipping`, colorIdx);
        this.recordCrashedState(svc, colorIdx);
        return;
      }
    }

    if (svc.preBuild) {
      const built = await this.runPreBuild(svc, cwd, colorIdx);
      if (!built) {
        this.recordCrashedState(svc, colorIdx);
        return;
      }
    }

    const args = buildProcessArgs(svc);
    const missingWatchPaths = extractWatchPaths(args).filter(p => !existsSync(resolve(cwd, p)));
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
      crashLog: null,
    };
    this.state.set(svc.name, state);
    this.procs.add(proc);
    this.events.onStateChange(svc.name, state);

    this.wireStdio(proc, svc, state, colorIdx);
    this.wireCloseHandler(proc, svc, state, colorIdx);
    this.scheduleStartupTimeout(svc, state, colorIdx);

    if (svc.watchBuild) {
      state.watchProc = this.spawnWatchBuild(svc, cwd, env, colorIdx);
    }

    this.log(svc.name, isRestart ? `🔄 restarted (:${svc.port})` : `🚀 started (:${svc.port})`, colorIdx);
  }

  private scheduleStartupTimeout(svc: ServiceConfig, state: ProcessState, colorIdx: number): void {
    const timeoutMs = svc.healthCheck?.startupTimeoutMs ?? STARTUP_TIMEOUT_DEFAULT_MS;
    if (timeoutMs <= 0) return;
    const timer = setTimeout(() => {
      this.startupTimers.delete(svc.name);
      const current = this.state.get(svc.name);
      if (!current || current !== state || current.health === 'up') return;
      current.status = 'timeout';
      current.health = 'down';
      this.log(svc.name, `⏱ startup timeout after ${timeoutMs / 1000}s — service never became healthy`, colorIdx);
      this.events.onStateChange(svc.name, current);
    }, timeoutMs);
    this.startupTimers.set(svc.name, timer);
  }

  private clearStartupTimer(name: string): void {
    const t = this.startupTimers.get(name);
    if (t) { clearTimeout(t); this.startupTimers.delete(name); }
  }

  private wireStdio(proc: ChildProcess, svc: ServiceConfig, state: ProcessState, colorIdx: number): void {
    const readyRegex = compileReadyPattern(svc.readyPattern);
    const markReadyIfMatch = (line: string) => {
      if (!readyRegex || state.health === 'up') return;
      if (readyRegex.test(line)) {
        state.health = 'up';
        if (state.status === 'starting') state.status = 'running';
        this.clearStartupTimer(svc.name);
        this.events.onStateChange(svc.name, state);
      }
    };
    const errorRegex = compileReadyPattern(svc.errorPattern);
    const countsAsError = (line: string) => errorRegex ? errorRegex.test(line) : true;

    // Rolling buffer of last N stderr lines for crash log.
    const stderrBuf: string[] = [];

    const stdoutBuf = lineBuffer(line => { markReadyIfMatch(line); this.log(svc.name, line, colorIdx); });
    const stderrLineBuf = lineBuffer(line => {
      if (countsAsError(line)) state.errors += 1;
      markReadyIfMatch(line);
      stderrBuf.push(line);
      if (stderrBuf.length > CRASH_LOG_LINES) stderrBuf.shift();
      this.log(svc.name, line, colorIdx);
    });

    proc.stdout?.on('data', (d: Buffer) => stdoutBuf.push(d));
    proc.stderr?.on('data', (d: Buffer) => stderrLineBuf.push(d));
    proc.stdout?.on('end', () => stdoutBuf.flush());
    proc.stderr?.on('end', () => {
      stderrLineBuf.flush();
      // Attach the stderr buffer to state so wireCloseHandler can use it.
      (state as ProcessState & { _stderrBuf: string[] })._stderrBuf = stderrBuf;
    });
  }

  private wireCloseHandler(proc: ChildProcess, svc: ServiceConfig, state: ProcessState, colorIdx: number): void {
    proc.on('close', code => {
      this.procs.delete(proc);
      this.lifecycle.stopWatchProc(state);
      this.clearStartupTimer(svc.name);
      if (state.intentionalStop) { state.intentionalStop = false; return; }
      if (code === 0) {
        state.status = 'stopped'; state.health = 'down';
        this.events.onStateChange(svc.name, state);
        return;
      }
      state.status = 'crashed'; state.health = 'down';
      const buf = (state as ProcessState & { _stderrBuf?: string[] })._stderrBuf;
      state.crashLog = buf && buf.length ? [...buf] : null;
      this.log(svc.name, `❌ exited with code ${code}`, colorIdx);
      this.events.onStateChange(svc.name, state);
      this.onCrash(svc, state, colorIdx);
    });
  }

  private runPreBuild(svc: ServiceConfig, cwd: string, colorIdx: number): Promise<boolean> {
    this.log(svc.name, `🔨 preBuild: ${svc.preBuild}`, colorIdx);
    return new Promise(res => {
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : 'sh';
      const shellFlag = isWin ? '/c' : '-c';
      const env = buildProcessEnv(svc, this.env);
      const child = spawn(shell, [shellFlag, svc.preBuild!], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const outBuf = lineBuffer(line => this.log(svc.name, `[build] ${line}`, colorIdx));
      const errBuf = lineBuffer(line => this.log(svc.name, `[build] ${line}`, colorIdx));
      child.stdout?.on('data', (d: Buffer) => outBuf.push(d));
      child.stderr?.on('data', (d: Buffer) => errBuf.push(d));
      child.on('error', err => { this.log(svc.name, `[build] ❌ ${err.message}`, colorIdx); res(false); });
      child.on('close', code => {
        outBuf.flush(); errBuf.flush();
        if (code === 0) { this.log(svc.name, `[build] ✅ done`, colorIdx); res(true); }
        else { this.log(svc.name, `[build] ❌ exited with code ${code}`, colorIdx); res(false); }
      });
    });
  }

  private spawnWatchBuild(svc: ServiceConfig, cwd: string, env: Record<string, string>, colorIdx: number): ChildProcess {
    this.log(svc.name, `👀 watchBuild: ${svc.watchBuild}`, colorIdx);
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'cmd.exe' : 'sh', [isWin ? '/c' : '-c', svc.watchBuild!], {
      cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outBuf = lineBuffer(line => this.log(svc.name, `[watch] ${line}`, colorIdx));
    const errBuf = lineBuffer(line => this.log(svc.name, `[watch] ${line}`, colorIdx));
    child.stdout?.on('data', (d: Buffer) => outBuf.push(d));
    child.stderr?.on('data', (d: Buffer) => errBuf.push(d));
    child.on('error', err => this.log(svc.name, `[watch] ❌ ${err.message}`, colorIdx));
    return child;
  }

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
      crashLog: null,
    });
    this.events.onStateChange(svc.name, this.state.get(svc.name)!);
  }

  private log(name: string, text: string, colorIdx: number): void {
    this.events.onLog(name, text, colorIdx);
  }
}
