import { existsSync, readFileSync } from 'node:fs';

/** Reads a `.env`-style file and overlays it on top of `baseEnv`.
 *  Lines starting with `#` are comments. Quoted values get the quotes stripped.
 *  Existing keys in `baseEnv` win — file values only fill the gaps. */
export function parseEnvFile(filePath: string, baseEnv: Record<string, string> = {}): Record<string, string> {
  const env = { ...baseEnv };
  if (!existsSync(filePath)) return env;

  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!env[key]) env[key] = val;
  }
  return env;
}
