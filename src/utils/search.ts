export interface SearchMatcher {
  test: (line: string) => boolean;
  /** Set when the input was a vim-style /pattern/flags — used to drive highlighting. */
  regex?: RegExp;
  /** True when input started with `/` but produced an invalid regex; UI may show a hint. */
  invalid?: boolean;
}

/** Compiles a search term to a matcher.
 *  - `/foo/` → regex (case-insensitive by default; honors flags after the closing slash)
 *  - anything else → case-insensitive substring (existing behavior)
 *  - invalid regex → falls back to substring, sets `invalid: true` */
export function compileSearchPattern(term: string | null): SearchMatcher | null {
  if (!term) return null;
  const slashed = /^\/(.+)\/([gimsuy]*)$/.exec(term);
  if (slashed) {
    // `g` and `y` dropped: they make `test` stateful through `lastIndex`, so a
    // pattern that matched every line highlighted every other one.
    const given = slashed[2]!.replace(/[gy]/g, '');
    const flags = given.includes('i') ? given : given + 'i';
    try {
      const re = new RegExp(slashed[1]!, flags);
      return { test: (l: string) => re.test(l), regex: re };
    } catch {
      // The pattern, not the slashes around it: searching for `/foo(/` as a
      // substring matched nothing, ever.
      const lower = slashed[1]!.toLowerCase();
      return { test: (l: string) => l.toLowerCase().includes(lower), invalid: true };
    }
  }
  const lower = term.toLowerCase();
  return { test: (l: string) => l.toLowerCase().includes(lower) };
}

export type LogLevel = 'error' | 'warn' | 'info';

/** Detects the level of a log line by case-insensitive keyword priority:
 *  error (and synonyms) > warn > info. Used by the L-level filter. */
export function detectLogLevel(line: string): LogLevel {
  const l = line.toLowerCase();
  // Conjugations covered for fail/crash; `error` and `exception` matched as exact word.
  if (/\b(?:error|err|fail(?:ed|ure|ures|s)?|fatal|exception|crash(?:ed|es)?)\b/.test(l) || /❌|✗|⛔/.test(line)) return 'error';
  // `deprecat\w*` and a bare `warning`: Node prints `DeprecationWarning: …
  // is deprecated`, and `\bdeprec\b` / `\bwarn` matched neither — so the
  // `L` filter hid exactly the warnings it exists to surface.
  if (/\b(?:warn(?:ed|ing|s|ings)?|deprecat\w*)\b|warning\b/.test(l) || /⚠/.test(line)) return 'warn';
  return 'info';
}
