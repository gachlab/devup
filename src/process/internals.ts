/** Buffered line splitter. Calls `onLine` for every newline-terminated chunk,
 *  preserves leftover for the next push. `flush()` emits any remaining tail. */
export function lineBuffer(onLine: (line: string) => void) {
  let buf = '';
  return {
    push(chunk: Buffer) {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.length) onLine(line);
      }
    },
    flush() {
      if (buf.length) { onLine(buf); buf = ''; }
    },
  };
}

/** Accepts both '/foo/' (vim-style) and bare 'foo'. Case-insensitive by default. */
export function compileReadyPattern(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  const slashed = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
  try {
    if (slashed) return new RegExp(slashed[1]!, slashed[2] || 'i');
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/** Extracts the value tokens of `--watch` / `--watch-path` / `--watch=X` / `--watch-path=X`
 *  from a command's args list. Accepts both `--flag value` and `--flag=value` forms. */
export function extractWatchPaths(args: string[]): string[] {
  const watchFlags = new Set(['--watch', '--watch-path']);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (watchFlags.has(a)) {
      const v = args[i + 1];
      if (v && !v.startsWith('-')) { out.push(v); i++; }
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0 && watchFlags.has(a.slice(0, eq))) {
      out.push(a.slice(eq + 1));
    }
  }
  return out;
}

export const MAX_RESTARTS = 3;
export const BACKOFF_BASE_MS = 2000;
