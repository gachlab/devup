/** Reading a service's persisted log, by line count and by time.
 *
 *  One module because the same reader is wired into the control plane twice —
 *  once by the daemon and once by the TUI (`useControlPlane`) — and they were
 *  copies of each other. A feature added to one silently missed the other, so
 *  `devup ctl logs --since` would have worked against `devup up -d` and done
 *  nothing against the TUI. */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

/** How LogSink writes them: `2026-08-23T20:15:00.123Z <line>`. */
const ISO_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) /;

export interface LogWindowOpts {
  /** Cap on how many lines come back, most recent kept. */
  lines: number;
  /** Only lines written at or after this epoch-ms timestamp. */
  since?: number;
}

export interface LogWindow {
  lines: string[];
  /** When the oldest line in the files this call read was written, or `null`
   *  when there were none — and `null` too when no `since` was given, because
   *  a plain tail only opens the current file and answering "the oldest devup
   *  holds" from a partial view is worse than not answering.
   *
   *  A fact, not a verdict. It does **not** mean data was lost: on a stack
   *  that booted a minute ago it is simply when the service first wrote. The
   *  caller compares it with the window it asked for and says something true —
   *  "the log starts after your window" covers both "rotated away" and "not
   *  running yet", and devup cannot tell those apart from here. */
  oldestRetained: number | null;
}

/** Parse the timestamp LogSink puts at the head of every line. */
export function lineTimestamp(line: string): number | null {
  const m = ISO_PREFIX.exec(line);
  if (!m) return null;
  const t = Date.parse(m[1]!);
  return Number.isNaN(t) ? null : t;
}

/** Read a window out of `<svc>.log`, and out of `<svc>.log.prev` when a
 *  `since` is given and the rotated file might still hold part of it. */
export async function readLogWindow(file: string, opts: LogWindowOpts): Promise<LogWindow> {
  // The current file first, then the rotated one — order that matters when
  // `LogSink` rotates *between* the two reads, which a chatty service crossing
  // the 10 MB threshold can do. Reading `.prev` first would then read the old
  // `.prev`, and the file that was current a moment ago — now `.prev` — would
  // vanish from the window with nothing to show for it. This way the second
  // read picks it up, and `.prev` is older than the current file either way,
  // so prepending it is chronological in both cases.
  const current = await readOneFile(file, opts);
  const previous = opts.since !== undefined ? await readOneFile(`${file}.prev`, opts) : null;

  // The last N of (last N of prev ++ last N of current) is the last N of the
  // whole thing, so each file stays bounded by `lines` rather than being read
  // into memory whole.
  const combined = [...(previous?.lines ?? []), ...current.lines];
  const lines = combined.length > opts.lines ? combined.slice(-opts.lines) : combined;

  return {
    lines,
    // Only meaningful when a window was asked for — see the field's own note.
    oldestRetained: opts.since === undefined ? null : (previous?.oldest ?? current.oldest ?? null),
  };
}

interface OneFile {
  lines: string[];
  /** First timestamp seen in this file, or null if it had none. */
  oldest: number | null;
}

async function readOneFile(file: string, opts: LogWindowOpts): Promise<OneFile> {
  const lines: string[] = [];
  let oldest: number | null = null;
  // A line with no timestamp of its own inherits the last one seen: the log
  // holds whatever a service printed, and a stack-trace continuation must not
  // be cut away from the header that dates it.
  let lastSeen: number | null = null;

  await eachLine(file, line => {
    const ts = lineTimestamp(line) ?? lastSeen;
    if (ts !== null) {
      lastSeen = ts;
      if (oldest === null) oldest = ts;
    }
    // An undated line before any dated one cannot be placed in time. Keeping
    // it would put the head of an old file inside a window it may predate.
    if (opts.since !== undefined && (ts === null || ts < opts.since)) return;
    lines.push(line);
    if (lines.length > opts.lines) lines.shift();
  });

  return { lines, oldest };
}

function eachLine(file: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let size = 0;
    try { size = statSync(file).size; } catch { resolve(); return; }
    if (size === 0) { resolve(); return; }
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }) });
    rl.on('line', onLine);
    rl.on('close', () => resolve());
    rl.on('error', reject);
  });
}

/** Turn `--since` into an epoch-ms timestamp.
 *
 *  Three spellings, and anything else is an error rather than a quiet "from
 *  the beginning": a harness that mistypes its window and silently gets the
 *  whole log attaches the wrong evidence to a failure, which is worse than no
 *  evidence at all.
 *
 *  - `30s`, `5m`, `2h`, `1d` — that long ago
 *  - an ISO-8601 timestamp — that moment
 *  - a bare integer — epoch milliseconds
 *
 *  A bare number is *not* read as a duration. `--since 500` meaning "500ms
 *  ago" and `--since 1755800000000` meaning a timestamp cannot both be true,
 *  and a unit is cheap to type. */
export function parseSince(value: string, now: number): number {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('--since needs a value: a duration (30s, 5m, 2h, 1d), an ISO timestamp, or epoch ms');

  const duration = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(trimmed);
  if (duration) {
    const scale: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return now - Number(duration[1]) * scale[duration[2]!]!;
  }

  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return parsed;

  throw new Error(
    `invalid --since: ${value}. Use a duration (30s, 5m, 2h, 1d), an ISO timestamp, or epoch milliseconds`,
  );
}
