import { existsSync, readFileSync } from 'node:fs';

/** Parse `.env` content into key/value pairs.
 *
 *  One parser for every place devup reads an env file — there were two, with
 *  different rules. Handles:
 *  - `#` comment lines, and blank lines;
 *  - `export KEY=value` (the key used to come out as `"export KEY"`);
 *  - values quoted with `'`, `"` or a backtick, kept verbatim inside;
 *  - an inline ` # comment` after an unquoted value;
 *  - an empty value (`KEY=`), which is a value. */
export function parseEnvContent(content: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const eq = body.indexOf('=');
    if (eq < 1) continue;
    const key = body.slice(0, eq).trim();
    let val = body.slice(eq + 1).trim();
    const q = val[0];
    if ((q === '"' || q === "'" || q === '`') && val.length > 1 && val.indexOf(q, 1) > 0) {
      val = val.slice(1, val.indexOf(q, 1));
    } else {
      const hash = val.search(/\s#/);
      if (hash !== -1) val = val.slice(0, hash).trimEnd();
    }
    out.push([key, val]);
  }
  return out;
}

/** Reads a `.env`-style file and overlays it on top of `baseEnv`.
 *  Keys already present in `baseEnv` win — present, not truthy: an empty
 *  `FOO=` set in the shell is a value, and the file used to replace it. */
export function parseEnvFile(filePath: string, baseEnv: Record<string, string> = {}): Record<string, string> {
  const env = { ...baseEnv };
  if (!existsSync(filePath)) return env;
  for (const [key, val] of parseEnvContent(readFileSync(filePath, 'utf8'))) {
    if (!(key in env)) env[key] = val;
  }
  return env;
}
