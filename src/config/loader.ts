import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DevStackConfig } from './types.js';

const CONFIG_NAMES = [
  'devup.config.ts',
  'devup.config.js',
  'devup.config.json',
];

export function findConfigFile(cwd: string, explicit?: string): string {
  if (explicit) {
    const full = resolve(cwd, explicit);
    if (!existsSync(full)) throw new Error(`Config not found: ${full}`);
    return full;
  }
  for (const name of CONFIG_NAMES) {
    const full = join(cwd, name);
    if (existsSync(full)) return full;
  }
  throw new Error(
    `No config found. Create one of: ${CONFIG_NAMES.join(', ')}\n` +
    `Or use --config <path>`,
  );
}

/** Parse the raw content of a devup config file just enough to extract the
 *  `envFile` string — without fully evaluating the config. This lets us load
 *  the env file BEFORE dynamic-importing the config so env vars are available
 *  during config evaluation (e.g. `process.env.PORT` in a .ts config). */
function extractEnvFilePath(configPath: string, raw: string): string | null {
  if (configPath.endsWith('.json')) {
    try { return (JSON.parse(raw) as { envFile?: string }).envFile ?? null; }
    catch { return null; }
  }
  const m = raw.match(/envFile\s*:\s*['"`]([^'"`]+)['"`]/);
  return m ? m[1]! : null;
}

function loadEnvFile(envFilePath: string): void {
  if (!existsSync(envFilePath)) return;
  try {
    const content = readFileSync(envFilePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^(['"`])(.*)\1$/, '$2');
      // Don't override existing env vars — config file is lower priority.
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch { /* ignore unreadable env file */ }
}

export async function loadConfig(configPath: string): Promise<DevStackConfig> {
  const configDir = dirname(configPath);

  // Auto-load envFile before evaluating the config so env vars are available
  // during dynamic import (e.g. `process.env.DB_URL` in a .ts config file).
  try {
    const raw = readFileSync(configPath, 'utf8');
    const envFileRelPath = extractEnvFilePath(configPath, raw);
    if (envFileRelPath) {
      loadEnvFile(resolve(configDir, envFileRelPath));
    }
  } catch { /* ignore — full error will surface below */ }

  if (configPath.endsWith('.json')) {
    const raw = await readFile(configPath, 'utf8');
    return JSON.parse(raw) as DevStackConfig;
  }

  const url = pathToFileURL(configPath).href;
  const mod = await import(url);
  const config = mod.default ?? mod;

  if (!config || typeof config !== 'object' || !Array.isArray(config.services)) {
    throw new Error(`Invalid config: must export a DevStackConfig (use defineConfig() from @gachlab/devup)`);
  }

  return config as DevStackConfig;
}
