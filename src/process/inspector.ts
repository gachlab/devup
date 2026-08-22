/** Node prints its inspector endpoint to stderr on startup:
 *
 *      Debugger listening on ws://127.0.0.1:39481/8f2c…-…
 *
 *  With `--inspect=0` the port is chosen by the OS, so reading it back from
 *  this line is the only way to know where to attach. Matching is deliberately
 *  narrow — an application logging a ws:// URL of its own must not be mistaken
 *  for the inspector. */
const DEBUGGER_LINE = /^Debugger listening on ws:\/\/[^:/]+:(\d{1,5})\//;

/** The inspector port announced by a line of output, or null. */
export function parseDebugPort(line: string): number | null {
  const m = DEBUGGER_LINE.exec(line.trim());
  if (!m) return null;
  const port = Number(m[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** Node's own inspector banner, which it writes to stderr.
 *
 *  Without an `errorPattern` every stderr line bumps `state.errors`, so a
 *  service started under `--inspect` showed two errors before doing anything —
 *  and the TUI sorts by error count. */
export function isInspectorNotice(line: string): boolean {
  const t = line.trim();
  return DEBUGGER_LINE.test(t)
    || t === 'Debugger attached.'
    || t.startsWith('For help, see: https://nodejs.org/en/docs/inspector')
    || t === 'Waiting for the debugger to disconnect...';
}
