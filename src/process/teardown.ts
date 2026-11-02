import { constants } from 'node:os';

export type FatalSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
const SIGNALS: readonly FatalSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** The slice of `process` this needs, so a test can hand in an EventEmitter. */
export interface FatalHost {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  exit(code: number): void;
}

export interface OnFatalOpts {
  /** Exit code after a signal. Default: 128 + the signal number, the shell
   *  convention a CI runner reads. The daemon passes 0: `devup down` is how it
   *  is meant to stop, not a failure. */
  signalExitCode?: (sig: FatalSignal) => number;
  /** Where to report an uncaught error before tearing down. Default: stderr. */
  report?: (err: unknown) => void;
  host?: FatalHost;
}

/** Run `teardown` once — on the first SIGINT/SIGTERM/SIGHUP, uncaught
 *  exception or unhandled rejection — then exit. Returns a disposer.
 *
 *  Every child devup spawns is `detached`, in its own process group, so it
 *  does **not** die with us: closing the terminal (SIGHUP), a CI job's SIGTERM
 *  or a bug that throws all leave the whole stack running and holding its
 *  ports unless something kills it on the way out. That something is this.
 *
 *  A second signal while tearing down is ignored rather than treated as
 *  "force": exiting then is exactly what orphans the children, and every step
 *  of the teardown is already bounded by its own timeout. */
export function onFatal(teardown: () => Promise<void>, opts: OnFatalOpts = {}): () => void {
  const host: FatalHost = opts.host ?? process;
  const report = opts.report ?? ((err: unknown) => {
    process.stderr.write(`devup: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  });
  const signalExitCode = opts.signalExitCode
    ?? ((sig: FatalSignal) => 128 + ((constants.signals as Record<string, number>)[sig] ?? 0));

  let running = false;
  // A closed terminal turns every write into another error: Ink's next frame,
  // the default `report` itself. Each one lands back here, so reporting has a
  // budget and never throws — a throw inside an 'uncaughtException' listener
  // kills the process on the spot, mid-teardown, which is the orphaning this
  // exists to prevent.
  let reportsLeft = 3;
  const run = (code: number) => {
    if (running) return;
    running = true;
    teardown().then(() => host.exit(code), () => host.exit(code || 1));
  };

  const onSignal = (sig: FatalSignal) => run(signalExitCode(sig));
  const onError = (err: unknown) => {
    // Reported even when a teardown is already under way: a throw from inside
    // the teardown is the one most worth seeing.
    if (reportsLeft > 0) {
      reportsLeft--;
      try { report(err); } catch { /* nowhere left to say it */ }
    }
    run(1);
  };
  // EPIPE/EIO on our own stdio after SIGHUP is an 'error' event; without a
  // listener it is one more uncaught exception per write.
  const swallow = () => {};
  const stdio = opts.host ? [] : [process.stdout, process.stderr];
  for (const s of stdio) s.on('error', swallow);

  const signalListeners = SIGNALS.map(sig => [sig, () => onSignal(sig)] as const);
  for (const [sig, fn] of signalListeners) host.on(sig, fn);
  host.on('uncaughtException', onError);
  host.on('unhandledRejection', onError);

  return () => {
    for (const [sig, fn] of signalListeners) host.off(sig, fn);
    host.off('uncaughtException', onError);
    host.off('unhandledRejection', onError);
    for (const s of stdio) s.off('error', swallow);
  };
}
