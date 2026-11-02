import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);
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

export interface LoadConfigOpts {
  /** `--env`, already resolved to an absolute path. Loaded **instead of** the
   *  config's own `envFile`, and before the config is evaluated.
   *
   *  It used to be the other way round: the config's `envFile` went into
   *  `process.env` first, and since an env file never overrides what is
   *  already set, `--env .env.test` could not change a single key the dev
   *  file had defined — the suite ran against the development database, the
   *  one thing `--env` exists to prevent. A `.ts` config reading
   *  `process.env.DB_URL` now sees the test value too. */
  envFile?: string;
  /** Bypass Node's module cache. `import()` of a URL it has seen returns the
   *  first module for the life of the process, so every `--watch-config`
   *  reload of a `.ts`/`.js` config evaluated the original file — edits were
   *  diffed against themselves and silently did nothing. Each fresh load keeps
   *  one more module alive; a reload per save is a small price. Modules the
   *  config imports itself are still cached. */
  fresh?: boolean;
}

export async function loadConfig(configPath: string, opts: LoadConfigOpts = {}): Promise<DevStackConfig> {
  const configDir = dirname(configPath);

  // Auto-load envFile before evaluating the config so env vars are available
  // during dynamic import (e.g. `process.env.DB_URL` in a .ts config file).
  if (opts.envFile) {
    loadEnvFile(opts.envFile);
  } else {
    try {
      const raw = readFileSync(configPath, 'utf8');
      const envFileRelPath = extractEnvFilePath(configPath, raw);
      if (envFileRelPath) {
        loadEnvFile(resolve(configDir, envFileRelPath));
      }
    } catch { /* ignore — full error will surface below */ }
  }

  if (configPath.endsWith('.json')) {
    const raw = await readFile(configPath, 'utf8');
    return JSON.parse(raw) as DevStackConfig;
  }

  let url = pathToFileURL(configPath).href;
  if (opts.fresh) {
    const { mtimeMs, size } = statSync(configPath);
    url += `?devup-reload=${mtimeMs}-${size}-${Date.now()}`;
    // A CommonJS config (`module.exports`, or a `.cjs`) goes through the CJS
    // loader, which caches by filename and ignores the query: drop its entry.
    // Keyed by real path — on macOS the temp dir alone is a symlink away.
    delete requireFromHere.cache[configPath];
    try { delete requireFromHere.cache[realpathSync(configPath)]; } catch { /* stat above already passed */ }
  }
  const mod = await import(url);
  const config = mod.default ?? mod;

  if (!config || typeof config !== 'object' || !Array.isArray(config.services)) {
    throw new Error(`Invalid config: must export a DevStackConfig (use defineConfig() from @gachlab/devup)`);
  }

  return config as DevStackConfig;
}
