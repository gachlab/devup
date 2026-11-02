import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findInstallRoot, needsInstall, writeInstallStamp } from '../utils/install-stamp.js';
import { resolveSpawnCommand } from '../platform/command.js';

/** Installs in flight, by root: services of one workspace share it, and
 *  `devup install` runs several at once — two `npm install`s in one tree race
 *  each other's files. A second caller waits for the first. */
const inFlight = new Map<string, Promise<boolean>>();

export function installService(
  cwd: string, env: Record<string, string>,
  onLog?: (msg: string) => void,
): Promise<boolean> {
  if (!existsSync(cwd)) {
    onLog?.(`⚠ directory not found: ${cwd}`);
    return Promise.resolve(false);
  }
  // Not a Node package: nothing to install. Running `npm install` here walked
  // up the tree and installed into whatever parent had a package.json.
  if (!existsSync(join(cwd, 'package.json'))) return Promise.resolve(true);

  const at = findInstallRoot(cwd);
  const running = inFlight.get(at.root);
  if (running) return running;
  if (!needsInstall(at)) {
    onLog?.('✅ dependencies up to date');
    return Promise.resolve(true);
  }
  const where = at.root === cwd ? '' : ` (workspace root ${at.root})`;
  onLog?.(`📦 ${at.manager} install${where}...`);
  const run = new Promise<boolean>(resolve => {
    // A .cmd shim on Windows, which Node no longer spawns without a shell
    // (CVE-2024-27980) — see resolveSpawnCommand.
    const command = resolveSpawnCommand(at.manager, ['install'], { env, cwd: at.root });
    const proc = spawn(command.file, command.args, {
      cwd: at.root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      windowsVerbatimArguments: command.windowsVerbatimArguments,
    });
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) {
        onLog?.(`⚠ ${at.manager} install failed: ${stderr.split('\n')[0]}`);
        resolve(false);
      } else {
        writeInstallStamp(at);
        onLog?.('✅ dependencies ready');
        resolve(true);
      }
    });
    proc.on('error', (err) => {
      onLog?.(`⚠ spawn error: ${err.message}`);
      resolve(false);
    });
  }).finally(() => inFlight.delete(at.root));
  inFlight.set(at.root, run);
  return run;
}
