import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { needsInstall, writeInstallStamp } from '../utils.js';

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
    // En Windows, npm es usualmente npm.cmd
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const proc = spawn(command, ['install'], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
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
    proc.on('error', (err) => {
      onLog?.(`⚠ spawn error: ${err.message}`);
      resolve(false);
    });
  });
}
