import { spawn } from 'node:child_process';

/**
 * A promise around a child-process call that resolves `fallback` instead of
 * rejecting when the call throws.
 *
 * The `try` is the point. `exec`/`execFile` do not always report through their
 * callback: Node only defers EACCES/EAGAIN/EMFILE/ENFILE/ENOENT to an async
 * `error` event, and any other errno from the spawn — EBADF, seen on macOS —
 * is **thrown synchronously** out of the call. In a bare `new Promise` executor
 * that became a rejection, and the TUI's stats poll dropped it, so one bad
 * sample killed the whole process. Stats are best-effort: a missed sample
 * costs one tick of numbers, never the orchestrator.
 */
export function settleChild<T>(fallback: T, run: (resolve: (value: T) => void) => void): Promise<T> {
  return new Promise<T>(resolve => {
    try { run(resolve); } catch { resolve(fallback); }
  });
}

/** Detached fire-and-forget spawn that can neither throw nor emit an unhandled
 *  `error` — a machine without `xdg-open` would otherwise crash the process. */
export function spawnDetached(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* best effort */ });
    child.unref();
  } catch { /* best effort */ }
}
