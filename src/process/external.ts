import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { ExternalService } from '../config/types.js';
import type { Platform } from '../platform/types.js';
import { checkHealth } from './health.js';

const DEFAULT_START_TIMEOUT_S = 60;

export interface ExternalProc {
  svc: ExternalService;
  proc: ChildProcess;
  pid: number | null;
}

export interface StartExternalsOpts {
  baseCwd: string;
  env: Record<string, string>;
  platform: Platform;
  onLog?: (svcName: string, msg: string) => void;
}

export interface StartExternalsResult {
  procs: ExternalProc[];
  allHealthy: boolean;
  failed: string[];
}

/** Spawn each external sequentially; for those with healthCheck, wait until it passes
 *  (up to startTimeout seconds) before moving on. Returns the spawned handles and a
 *  failure summary the caller can act on. */
export async function startExternals(
  externals: ExternalService[],
  opts: StartExternalsOpts,
): Promise<StartExternalsResult> {
  const procs: ExternalProc[] = [];
  const failed: string[] = [];

  for (const svc of externals) {
    const proc = spawnExternal(svc, opts);
    procs.push({ svc, proc, pid: proc.pid ?? null });

    if (!svc.healthCheck) {
      opts.onLog?.(svc.name, '✅ started (no healthCheck)');
      continue;
    }

    if (svc.healthCheck.type === 'tcp' && !svc.port) {
      opts.onLog?.(svc.name, '⚠ tcp healthCheck requires `port` — skipping wait');
      continue;
    }

    const timeoutMs = (svc.startTimeout ?? DEFAULT_START_TIMEOUT_S) * 1000;
    const ok = await waitHealthy(svc, timeoutMs);
    if (ok) {
      opts.onLog?.(svc.name, '✅ healthy');
    } else {
      opts.onLog?.(svc.name, `❌ never became healthy (timeout ${timeoutMs / 1000}s)`);
      failed.push(svc.name);
    }
  }

  return { procs, allHealthy: failed.length === 0, failed };
}

/** Kill the externals and run any `stopCmd`s. Best-effort, fire-and-forget for the stopCmds. */
export async function stopExternals(
  procs: ExternalProc[],
  platform: Platform,
  opts: { baseCwd: string; env: Record<string, string>; onLog?: (svc: string, msg: string) => void } = {} as any,
): Promise<void> {
  for (const { svc, proc, pid } of procs) {
    try {
      if (pid) platform.killTree(pid);
      if (svc.stopCmd) {
        opts.onLog?.(svc.name, `🧹 ${svc.stopCmd}`);
        await new Promise<void>(resolve => {
          const isWin = process.platform === 'win32';
          const shell = isWin ? 'cmd.exe' : 'sh';
          const flag = isWin ? '/c' : '-c';
          const cwd = svc.cwd ? join(opts.baseCwd, svc.cwd) : opts.baseCwd;
          const env = { ...opts.env, ...(svc.extraEnv ?? {}) };
          const child = spawn(shell, [flag, svc.stopCmd!], { cwd, env, stdio: 'ignore' });
          child.on('close', () => resolve());
          child.on('error', () => resolve());
          // 10s hard cap so a hung docker stop doesn't block forever
          setTimeout(() => resolve(), 10_000);
        });
      }
    } catch { /* best-effort */ }
    void proc; // keep TS happy
  }
}

function spawnExternal(svc: ExternalService, opts: StartExternalsOpts): ChildProcess {
  const isWin = process.platform === 'win32';
  const shell = isWin ? 'cmd.exe' : 'sh';
  const flag = isWin ? '/c' : '-c';
  const cwd = svc.cwd ? join(opts.baseCwd, svc.cwd) : opts.baseCwd;
  const env = { ...opts.env, ...(svc.extraEnv ?? {}) };

  opts.onLog?.(svc.name, `🚀 ${svc.cmd}`);
  const child = spawn(shell, [flag, svc.cmd], {
    cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => opts.onLog?.(svc.name, d.toString().trimEnd()));
  child.stderr?.on('data', (d: Buffer) => opts.onLog?.(svc.name, d.toString().trimEnd()));
  child.on('error', err => opts.onLog?.(svc.name, `❌ spawn error: ${err.message}`));
  return child;
}

async function waitHealthy(svc: ExternalService, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const port = svc.port!;
  while (Date.now() < deadline) {
    if ((await checkHealth(port, svc.healthCheck)).ok) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
