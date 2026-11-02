import { readFileSync } from 'node:fs';
import type { ProcessState } from '../process/types.js';
import type { ProxyConfigProvider, ProxyOpts, ServiceState } from './types.js';

/** What the reverse proxy should route to, per service.
 *
 *  A lazy service is routed to its **public** port — the lazy proxy — and is
 *  always routable: that proxy answers whether the service is up or asleep,
 *  and waking it is its job. Routing to the real port (`port + 10000`) and only
 *  while healthy, as before, made the two features incompatible: a sleeping
 *  service had no route (404 by domain, never woken), and traffic arriving by
 *  domain bypassed the lazy proxy, so it never counted as activity and a
 *  service in use was put to sleep under its users (hazard §3). */
export function routableStates(
  states: Map<string, ProcessState>,
  /** Whether a lazy service's proxy is actually listening. One that failed to
   *  bind (another process holds the port), or was released by a switch that
   *  then failed, must not be routed "up" for good — the route would send
   *  domain traffic to whatever holds that port. Falls back to the service's
   *  own health when false. */
  lazyServing: (name: string) => boolean = () => true,
): Map<string, ServiceState> {
  const out = new Map<string, ServiceState>();
  for (const [name, st] of states) {
    const lazy = st.svc.originalPort !== undefined && !st.remote && lazyServing(name);
    out.set(name, {
      port: st.svc.originalPort ?? st.svc.port,
      health: lazy ? 'up' : st.health,
    });
  }
  return out;
}

/** Keeps a proxy config file in step with the services. One implementation
 *  for the daemon and the TUI: they had a copy each, and only the daemon's
 *  caught a failed write — in the TUI an EACCES inside the interval was an
 *  uncaught exception that took the stack down. */
export class ProxySync {
  private last: string | null = null;
  private failing = false;

  constructor(
    private readonly provider: ProxyConfigProvider,
    private readonly opts: ProxyOpts,
    private readonly read: () => Map<string, ProcessState>,
    private readonly log: (msg: string) => void = () => {},
    private readonly lazyServing?: (name: string) => boolean,
    /** Reads the file as it is on disk — injectable for tests. */
    private readonly readOnDisk: () => string | null = () => {
      try { return readFileSync(this.opts.confPath, 'utf8'); } catch { return null; }
    },
  ) {}

  /** Regenerate and write if anything changed. Never throws. */
  sync(): void {
    const content = this.provider.generate(routableStates(this.read(), this.lazyServing), this.opts);
    // Unchanged *and* still what is on disk. Something else can rewrite the
    // file — another `--instance` sharing the default path clears it when it
    // quits — and trusting `last` alone left this stack's routes gone until
    // some service happened to change health.
    if (content === this.last && this.readOnDisk() === content) return;
    try {
      this.provider.write(content, this.opts);
      this.last = content;
      if (this.failing) this.log(`✅ ${this.provider.name} config written again: ${this.opts.confPath}`);
      this.failing = false;
    } catch (e) {
      // Said once per failure streak, not every 3 s; `last` stays stale so the
      // next tick retries.
      if (!this.failing) this.log(`⚠ cannot write ${this.provider.name} config ${this.opts.confPath}: ${(e as Error).message}`);
      this.failing = true;
    }
  }

  /** Remove every route — on exit, or when sync is turned off — so the proxy
   *  stops sending traffic to services that are no longer there. Never throws. */
  clear(): void {
    this.last = null;
    try { this.provider.clear(this.opts); } catch (e) {
      this.log(`⚠ cannot clear ${this.provider.name} config ${this.opts.confPath}: ${(e as Error).message}`);
    }
  }
}
