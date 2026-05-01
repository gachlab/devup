import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { needsInstall, writeInstallStamp } from '../utils.js';

export interface InstallResult {
  name: string;
  ok: boolean;
  error?: string;
}

export function installService(
  cwd: string, env: Record<string, string>,
  onLog?: (msg: string) => void,
): Promise<boolean> {
  if (!existsSync(cwd)) {
    onLog?.(`⚠ directory not found: ${cwd}`);
    return Promise.resolve(false);
  }
  if (!needsInstall(cwd)) {
    onLog?.('✅ dependencies up to date');
    return Promise.resolve(true);
  }
  onLog?.('📦 npm install...');
  return new Promise(resolve => {
    const proc = spawn('npm', ['install'], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) {
        onLog?.(`⚠ npm install failed: ${stderr.split('\n')[0]}`);
        resolve(false);
      } else {
        writeInstallStamp(cwd);
        onLog?.('✅ dependencies ready');
        resolve(true);
      }
    });
  });
}

export async function installBatch(
  items: Array<{ name: string; cwd: string; env: Record<string, string> }>,
  concurrency: number,
  onLog?: (name: string, msg: string) => void,
): Promise<InstallResult[]> {
  const results: InstallResult[] = [];
  const queue = [...items];
  const running: Promise<void>[] = [];

  while (queue.length > 0 || running.length > 0) {
    while (running.length < concurrency && queue.length > 0) {
      const item = queue.shift()!;
      const p = installService(item.cwd, item.env, msg => onLog?.(item.name, msg))
        .then(ok => {
          results.push({ name: item.name, ok });
          running.splice(running.indexOf(p), 1);
        });
      running.push(p);
    }
    if (running.length > 0) await Promise.race(running);
  }
  return results;
}
