import { exec, spawn } from 'node:child_process';
import type { Platform, ProcessStats } from './types.js';

function parsePsTime(time: string): number {
  const parts = time.split(':').map(Number);
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return 0;
}

export class LinuxPlatform implements Platform {
  readonly defaultTraefikHost: string = '172.17.0.1';

  getProcessStats(pids: number[]): Promise<Map<number, ProcessStats>> {
    if (!pids.length) return Promise.resolve(new Map());

    return new Promise(resolve => {
      exec(
        `ps -o pid=,rss=,time= -p ${pids.join(',')} 2>/dev/null || true`,
        { encoding: 'utf8', timeout: 5000 },
        (err, stdout) => {
          const map = new Map<number, ProcessStats>();
          if (err || !stdout) return resolve(map);

          for (const line of stdout.trim().split('\n')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 3) continue;
            const pid = parseInt(parts[0]!, 10);
            map.set(pid, {
              rss: parseInt(parts[1]!, 10) || 0,
              cpuSeconds: parsePsTime(parts[2]!),
            });
          }
          resolve(map);
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
