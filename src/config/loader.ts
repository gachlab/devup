import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
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

export async function loadConfig(configPath: string): Promise<DevStackConfig> {
  if (configPath.endsWith('.json')) {
    const raw = await readFile(configPath, 'utf8');
    return JSON.parse(raw) as DevStackConfig;
  }

  // .ts and .js — dynamic import (tsx loader handles .ts at runtime)
  const url = pathToFileURL(configPath).href;
  const mod = await import(url);
  const config = mod.default ?? mod;

  if (!config || typeof config !== 'object' || !Array.isArray(config.services)) {
    throw new Error(`Invalid config: must export a DevStackConfig (use defineConfig() from @gachlab/devup)`);
  }

  return config as DevStackConfig;
}
