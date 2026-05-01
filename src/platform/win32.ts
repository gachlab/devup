import { exec, spawn } from 'node:child_process';
import type { Platform, ProcessStats } from './types.js';

export class Win32Platform implements Platform {
  readonly defaultTraefikHost = 'host.docker.internal';

  getProcessStats(pids: number[]): Promise<Map<number, ProcessStats>> {
    if (!pids.length) return Promise.resolve(new Map());

    return new Promise(resolve => {
      const filter = pids.map(p => `ProcessId=${p}`).join(' OR ');
      exec(
        `wmic process where "${filter}" get ProcessId,WorkingSetSize,KernelModeTime,UserModeTime /format:csv 2>nul`,
        { encoding: 'utf8', timeout: 5000 },
        (err, stdout) => {
          const map = new Map<number, ProcessStats>();
          if (err || !stdout) return resolve(map);

          // CSV: Node,KernelModeTime,ProcessId,UserModeTime,WorkingSetSize
          for (const line of stdout.trim().split('\n').slice(1)) {
            const cols = line.trim().split(',');
            if (cols.length < 5) continue;
            const pid = parseInt(cols[2]!, 10);
            const kernelTime = parseInt(cols[1]!, 10) || 0; // 100-nanosecond units
            const userTime = parseInt(cols[3]!, 10) || 0;
            const workingSet = parseInt(cols[4]!, 10) || 0;
            map.set(pid, {
              rss: Math.round(workingSet / 1024), // bytes → KB
              cpuSeconds: (kernelTime + userTime) / 10_000_000, // 100ns → seconds
            });
          }
          resolve(map);
        },
      );
    });
  }

  killTree(pid: number): void {
    try {
      exec(`taskkill /PID ${pid} /T /F`, { timeout: 5000 });
    } catch { /* already dead */ }
  }

  openBrowser(url: string): void {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
}
