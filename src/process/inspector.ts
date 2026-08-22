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
