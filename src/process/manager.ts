import { spawn } from 'node:child_process';
import { join } from 'node:path';
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

    const args = buildProcessArgs(svc);
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

    const stdoutBuf = lineBuffer(line => {
      markReadyIfMatch(line);
      this.log(svc.name, line, colorIdx);
    });
    const stderrBuf = lineBuffer(line => {
      state.errors += 1;
      markReadyIfMatch(line);
      this.log(svc.name, line, colorIdx);
    });

    proc.stdout?.on('data', (d: Buffer) => stdoutBuf.push(d));
    proc.stderr?.on('data', (d: Buffer) => stderrBuf.push(d));
    proc.stdout?.on('end', () => stdoutBuf.flush());
    proc.stderr?.on('end', () => stderrBuf.flush());

    proc.on('close', code => {
      this.procs.delete(proc);
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

    this.log(svc.name, isRestart ? `🔄 restarted (:${svc.port})` : `🚀 started (:${svc.port})`, colorIdx);
  }

  stop(name: string): void {
    const st = this.state.get(name);
    if (!st?.proc || !st.pid) return;
    st.intentionalStop = true;
    this.platform.killTree(st.pid);
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
      if (st) st.intentionalStop = true;
      if (proc.pid) this.platform.killTree(proc.pid);
    }

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
