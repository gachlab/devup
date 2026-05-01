import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Platform } from '../platform/types.js';
import type { ServiceConfig } from '../config/types.js';
import type { ProcessState, ProcessManagerEvents } from './types.js';
import { checkPort, deriveHealth } from './health.js';
import { installService } from './installer.js';
import { buildProcessArgs, buildProcessEnv } from '../utils.js';

const MAX_RESTARTS = 3;
const BACKOFF_BASE_MS = 2000;

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

  async install(svc: ServiceConfig): Promise<boolean> {
    const cwd = join(this.baseCwd, svc.cwd);
    return installService(cwd, this.env, msg => this.log(svc.name, msg, this.getColorIdx(svc.name)));
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

    proc.stdout?.on('data', (d: Buffer) => this.log(svc.name, d.toString(), colorIdx));
    proc.stderr?.on('data', (d: Buffer) => {
      state.errors += d.toString().split('\n').filter(Boolean).length;
      this.log(svc.name, d.toString(), colorIdx);
    });

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
    st.restarts++;
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
      const port = st.svc.port;
      const isUp = await checkPort(port);
      const prev = st.health;
      st.health = deriveHealth(isUp, st.status);
      if (st.health === 'up' && st.status === 'starting') st.status = 'running';
      if (prev !== st.health) this.events.onStateChange(name, st);
    }
  }

  cleanup(): void {
    for (const proc of this.procs) {
      if (proc.pid) this.platform.killTree(proc.pid);
    }
    // Force kill after 3s
    setTimeout(() => {
      for (const proc of this.procs) {
        if (proc.pid) this.platform.killTree(proc.pid, 'SIGKILL');
      }
    }, 3000);
  }

  private log(name: string, text: string, colorIdx: number): void {
    this.events.onLog(name, text, colorIdx);
  }

  private getColorIdx(name: string): number {
    return this.state.get(name)?.colorIdx ?? 0;
  }
}
