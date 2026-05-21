import { spawn } from 'node:child_process';
import { createReadStream, watchFile, unwatchFile, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { checkHealth } from '../process/health.js';
import { needsInstall, writeInstallStamp } from '../utils.js';
import type { DevStackConfig } from '../config/types.js';

const KNOWN = new Set(['logs', 'install', 'status', 'help']);

/** Returns the subcommand name if the first arg is one we recognise, else null. */
export function detectSubcommand(argv: string[]): string | null {
  const first = argv[0];
  return first && KNOWN.has(first) ? first : null;
}

interface SubOpts {
  config: DevStackConfig;
  baseCwd: string;
  env: Record<string, string>;
  logDir?: string;
  out?: (line: string) => void;
}

function logRoot(config: DevStackConfig, override?: string): string {
  const root = override ?? join(homedir(), '.devup', 'logs');
  return join(root, sanitize(config.name));
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'devup';
}

// ── devup logs <svc> [--follow] ──

export async function runLogs(argv: string[], opts: SubOpts): Promise<number> {
  const out = opts.out ?? ((l: string) => console.log(l));
  const follow = argv.includes('--follow') || argv.includes('-f');
  const svcArg = argv.find(a => !a.startsWith('-'));
  if (!svcArg) {
    out('usage: devup logs <service> [--follow]');
    return 1;
  }
  const knownSvcs = opts.config.services.map(s => s.name);
  if (!knownSvcs.includes(svcArg)) {
    out(`Unknown service "${svcArg}". Known: ${knownSvcs.join(', ')}`);
    return 1;
  }
  const file = join(logRoot(opts.config, opts.logDir), `${sanitize(svcArg)}.log`);
  if (!existsSync(file)) {
    out(`No log file yet for "${svcArg}" (${file})`);
    return follow ? await followFile(file, out) : 1;
  }
  await streamFile(file, out);
  if (!follow) return 0;
  return await followFile(file, out, statSync(file).size);
}

async function streamFile(file: string, out: (l: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }) });
    rl.on('line', l => out(l));
    rl.on('close', () => resolve());
    rl.on('error', reject);
  });
}

async function followFile(file: string, out: (l: string) => void, startAt = 0): Promise<number> {
  let pos = startAt;
  // Wait for the file to appear if it doesn't yet
  while (!existsSync(file)) await new Promise(r => setTimeout(r, 500));
  return new Promise(resolve => {
    const tick = async () => {
      const size = statSync(file).size;
      if (size > pos) {
        await new Promise<void>(res => {
          const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8', start: pos, end: size - 1 }) });
          rl.on('line', l => out(l));
          rl.on('close', () => { pos = size; res(); });
        });
      } else if (size < pos) {
        // File was truncated / rotated — restart from beginning
        pos = 0;
      }
    };
    watchFile(file, { interval: 500 }, () => { void tick(); });
    process.once('SIGINT', () => { unwatchFile(file); resolve(0); });
  });
}

// ── devup install ──

export async function runInstall(opts: SubOpts & { concurrency?: number }): Promise<number> {
  const out = opts.out ?? ((l: string) => console.log(l));
  const concurrency = opts.concurrency ?? 4;
  const items = opts.config.services.map(s => ({ name: s.name, cwd: join(opts.baseCwd, s.cwd) }));
  const queue = [...items];
  const failed: string[] = [];
  let inFlight = 0;

  await new Promise<void>(resolve => {
    const pump = () => {
      while (inFlight < concurrency && queue.length) {
        const item = queue.shift()!;
        inFlight++;
        installOne(item.cwd, opts.env).then(ok => {
          inFlight--;
          if (ok) out(`✓ ${item.name}`);
          else { failed.push(item.name); out(`✗ ${item.name}`); }
          if (queue.length === 0 && inFlight === 0) resolve();
          else pump();
        });
      }
    };
    pump();
  });

  if (failed.length) {
    out(`\nfailed: ${failed.join(', ')}`);
    return 1;
  }
  out(`\n${items.length} services up to date`);
  return 0;
}

function installOne(cwd: string, env: Record<string, string>): Promise<boolean> {
  if (!existsSync(cwd)) return Promise.resolve(false);
  if (!needsInstall(cwd)) return Promise.resolve(true);
  return new Promise(resolve => {
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const proc = spawn(command, ['install'], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
    proc.on('close', code => {
      if (code === 0) { writeInstallStamp(cwd); resolve(true); } else resolve(false);
    });
    proc.on('error', () => resolve(false));
  });
}

// ── devup status ──

export async function runStatus(opts: SubOpts): Promise<number> {
  const out = opts.out ?? ((l: string) => console.log(l));
  out(`${opts.config.icon ?? '📦'} ${opts.config.name} — ${opts.config.services.length} services`);
  out('');

  const maxLen = Math.max(...opts.config.services.map(s => s.name.length), 12);
  out(`${'Service'.padEnd(maxLen)}  ${'Port'.padStart(5)}  ${'Type'.padEnd(4)}  Health`);
  out('-'.repeat(maxLen + 24));

  for (const svc of opts.config.services) {
    const up = await checkHealth(svc.port, svc.healthCheck);
    const health = up ? '✓ up' : '✗ down';
    out(`${svc.name.padEnd(maxLen)}  ${String(svc.port).padStart(5)}  ${svc.type.padEnd(4)}  ${health}`);
  }
  return 0;
}

// ── devup help <subcommand> ──

export function runHelp(argv: string[], opts: { out?: (l: string) => void } = {}): number {
  const out = opts.out ?? ((l: string) => console.log(l));
  const sub = argv[0];
  if (sub === 'logs') {
    out('Usage: devup logs <service> [--follow|-f]');
    out('  Print the persisted log file for a service (works without devup running).');
    out('  --follow tails new lines as they are appended.');
    return 0;
  }
  if (sub === 'install') {
    out('Usage: devup install');
    out('  Run `npm install` across every service.cwd in parallel (max 4 at a time).');
    out('  Skips services whose .install-stamp matches package.json hash.');
    return 0;
  }
  if (sub === 'status') {
    out('Usage: devup status');
    out('  For each service, probes its health-check endpoint and prints up/down.');
    return 0;
  }
  out('Subcommands:');
  out('  devup logs <service> [--follow]   Read the persisted log file');
  out('  devup install                     Concurrent npm install across services');
  out('  devup status                      Health check every service in config');
  out('  devup help [<subcommand>]         Show detailed help for a subcommand');
  out('');
  out('No subcommand → launch the interactive TUI.');
  return 0;
}

void readFile;
void dirname;
void fileURLToPath;
