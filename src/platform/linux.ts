import { exec, spawn } from 'node:child_process';
import type { Platform, ProcessStats } from './types.js';
import { parsePsTime, sumProcessTrees, type ProcessRow } from './tree.js';

/** `ps -A -o pid=,ppid=,rss=,time=` output, one row per process. */
export function parsePsRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.trim().split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = parseInt(parts[0]!, 10);
    const ppid = parseInt(parts[1]!, 10);
    if (Number.isNaN(pid) || Number.isNaN(ppid)) continue;
    rows.push({ pid, ppid, rss: parseInt(parts[2]!, 10) || 0, cpuSeconds: parsePsTime(parts[3]!) });
  }
  return rows;
}

export class LinuxPlatform implements Platform {
  readonly defaultTraefikHost: string = '172.17.0.1';

  getProcessStats(pids: number[]): Promise<Map<number, ProcessStats>> {
    if (!pids.length) return Promise.resolve(new Map());

    return new Promise(resolve => {
      // Every process, not just the roots: a service's memory is in the
      // children of its `npm` / `npx` wrapper. Same flags on Linux and macOS.
      exec(
        'ps -A -o pid=,ppid=,rss=,time= 2>/dev/null || true',
        { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) return resolve(new Map());
          resolve(sumProcessTrees(parsePsRows(stdout), pids));
        },
      );
    });
  }

  killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
    try { process.kill(-pid, signal); } catch {
      try { process.kill(pid, signal); } catch { /* already dead */ }
    }
  }

  openBrowser(url: string): void {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}
