import { existsSync, readFileSync } from 'node:fs';

/** Parse `.env` content into key/value pairs.
 *
 *  One parser for every place devup reads an env file — there were two, with
 *  different rules. Handles:
 *  - `#` comment lines, and blank lines;
 *  - `export KEY=value` (the key used to come out as `"export KEY"`);
 *  - values quoted with `'`, `"` or a backtick, kept verbatim inside — `\"`
 *    does not close a double-quoted value (service-account JSON);
 *  - an inline ` # comment` after an unquoted or quoted value.
 *  A quoted value whose closing quote is not the end of the line
 *  (`ARGS="--foo" "--bar"`) keeps the old rule: quotes are stripped only when
 *  both ends match, and nothing is cut. */
export function parseEnvContent(content: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = /^export\s/.test(line) ? line.slice(7).trimStart() : line;
    const eq = body.indexOf('=');
    if (eq < 1) continue;
    const key = body.slice(0, eq).trim();
    let val = body.slice(eq + 1).trim();
    const q = val[0];
    if (q === '"' || q === "'" || q === '`') {
      const close = closingQuote(val, q);
      const after = close === -1 ? '' : val.slice(close + 1).trim();
      if (close !== -1 && (after === '' || after.startsWith('#'))) {
        val = val.slice(1, close);
      } else if (val.length > 1 && val.endsWith(q)) {
        val = val.slice(1, -1);
      }
    } else {
      const hash = val.search(/\s#/);
      if (hash !== -1) val = val.slice(0, hash).trimEnd();
    }
    out.push([key, val]);
  }
  return out;
}

/** The index of the quote that closes `val` (which starts with `q`), or -1.
 *  Inside double quotes a backslash escapes the next character. */
function closingQuote(val: string, q: string): number {
  for (let i = 1; i < val.length; i++) {
    if (q === '"' && val[i] === '\\') { i++; continue; }
    if (val[i] === q) return i;
  }
  return -1;
}

/** Reads a `.env`-style file and overlays it on top of `baseEnv`.
 *  A key already set in `baseEnv` to a non-empty value wins. An *empty* one
 *  does not, on purpose: CI exports a missing secret as `API_KEY=`, and the
 *  committed `.env.test` value is what should fill it. */
export function parseEnvFile(filePath: string, baseEnv: Record<string, string> = {}): Record<string, string> {
  const env = { ...baseEnv };
  if (!existsSync(filePath)) return env;
  for (const [key, val] of parseEnvContent(readFileSync(filePath, 'utf8'))) {
    if (!env[key]) env[key] = val;
  }
  return env;
}
