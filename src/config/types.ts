export interface ServiceConfig {
  name: string;
  cwd: string;
  cmd: string;
  args: string[];
  type: 'api' | 'web';
  port: number;
  phase: number;
  maxMem?: number;
  preBuild?: string;
  watchBuild?: string;
  nodeArgs?: string[];
  extraEnv?: Record<string, string>;
  healthCheck?: HealthCheckConfig;
  /** Case-insensitive regex. When a line of the service's stdout/stderr matches,
   *  the service is immediately marked as `up` without waiting for the next
   *  health-check poll. Speeds up phase transitions on cold boots.
   *  Examples: '/ready in \\d+ ms/' (Vite), '/compiled successfully/' (Angular). */
  readyPattern?: string;
  /** Case-insensitive regex. When set, only stderr lines matching this pattern
   *  bump `state.errors`. Without it, every non-empty stderr line counts.
   *  Useful for libraries that write info messages to stderr (Angular CLI). */
  errorPattern?: string;
  /** Run this service under the Node inspector.
   *
   *  `true` uses `--inspect=0` so the OS picks a free port — with a dozen
   *  services the fixed 9229 collides immediately. The port Node actually
   *  chose is reported back as `debugPort` in the status snapshot, parsed from
   *  its startup line, so a client can attach without guessing.
   *
   *  A number pins the port instead, for a launch config that has to be
   *  written down. The object form adds `brk`, which stops the service on its
   *  first line so the startup path can be debugged too. Only applies when
   *  `cmd` is `node`. */
  debug?: boolean | number | DebugOptions;
}

export interface DebugOptions {
  /** Inspector port. Omitted means `0`: the OS picks, and the choice is
   *  reported back as `debugPort` in the status snapshot. */
  port?: number;
  /** Start with `--inspect-brk`, stopping before the first line of the
   *  service's own code.
   *
   *  The service does **not** listen on its own port until a debugger attaches
   *  and resumes it, so devup suspends the startup timeout for it — otherwise
   *  the service lands in `timeout`, a state the health poller then skips for
   *  good. In lazy mode the on-demand start waits far longer for the same
   *  reason. */
  brk?: boolean;
}

export interface HealthCheckConfig {
  /** 'tcp' (default) checks that the port accepts connections. 'http' makes an HTTP GET. */
  type: 'tcp' | 'http';
  /** HTTP-only: request path. Default: '/' */
  path?: string;
  /** HTTP-only: acceptable status code(s). Default: 200-299 */
  expect?: number | number[];
  /** Override host for the HTTP check. Default: 127.0.0.1 */
  host?: string;
  /** Per-check socket timeout in ms. Default: 2000 */
  timeoutMs?: number;
  /** Grace period (seconds) before the first probe runs. Default: 0 */
  startPeriod?: number;
  /** How long (ms) to wait for first healthy probe before marking as `timeout`. Default: 45 000. */
  startupTimeoutMs?: number;
  /** Consecutive failed probes required before marking health `down`. Default: 2. */
  failureThreshold?: number;
}

/** How a service that is *not* running locally is served: devup binds its
 *  configured port and forwards to a remote environment.
 *
 *  The point of cut is the port, not the service's own configuration, because
 *  that is where every consumer already looks — a frontend that resolves its
 *  backend as `http://localhost:3050` keeps working untouched. See
 *  docs/remote-environments.md. */
export interface EnvironmentConfig {
  /** Domain the environment is served under. The per-service host is built
   *  from `proxy.routes[name]` plus this — the same map the reverse-proxy
   *  generator uses, and the same subdomains the deployed frontends call. */
  domain?: string;
  /** Per-service absolute URL, for a service whose remote host does not follow
   *  `proxy.routes` (or a stack with no `proxy` block at all). Wins over
   *  `domain`. */
  targets?: Record<string, string>;
  /** Scheme for targets built from `domain`. Default: true (https).
   *  Ignored for entries in `targets`, which carry their own scheme. */
  tls?: boolean;
  /** Verify the upstream's TLS certificate. Default: true. Set false only for
   *  an environment with a self-signed certificate. */
  tlsVerify?: boolean;
  /** What to send as `Origin` and `Referer`, and what to restore in the
   *  response's `Access-Control-Allow-Origin`.
   *
   *  Absent means passthrough: the browser's own origin travels up. That works
   *  where the upstream allowlists localhost, and fails where the origin
   *  selects a tenant — the request never reaches a database. Both halves are
   *  driven from this one option on purpose: rewriting the request origin
   *  without restoring the CORS header makes the browser reject every reply,
   *  and two separate options can drift apart. */
  origin?: string;
  /** `Host` sent upstream. 'target' (default) uses the target's own host,
   *  which is what an ingress routes on; 'passthrough' forwards the local one. */
  host?: 'target' | 'passthrough';
  /** Send `X-Forwarded-Host` / `-Proto` / `-For` with the *local* values.
   *
   *  Default false, which is not the obvious choice. An upstream that resolves
   *  a tenant from headers may read `x-forwarded-host` as a fallback: filling
   *  it with the local host either matches nothing or, worse, selects the
   *  wrong tenant without a word. Opt in per environment. */
  forwarded?: boolean;
  /** Request headers, applied after every rule above. Values interpolate
   *  `${VAR}` from the process environment. */
  headers?: { set?: Record<string, string>; remove?: string[] };
  /** `Set-Cookie` handling. 'localize' (default) drops `Domain` and `Secure`
   *  so a cookie scoped to the remote domain, and marked https-only, is kept
   *  by a browser on `http://localhost`. Without it there is no session. */
  cookies?: 'localize' | 'passthrough';
  /** `Location` handling on redirects. 'localize' (default) rewrites a
   *  redirect back to the remote origin into the local one, so a login flow
   *  does not walk the browser out of the local stack. */
  location?: 'localize' | 'passthrough';
  /** Reject every method other than GET/HEAD/OPTIONS with 405.
   *
   *  Default **false**, deliberately. Logging in is a POST, so a restrictive
   *  default breaks the first thing anyone tries and teaches them to turn it
   *  off without reading why. The warning lives where it cannot be skipped
   *  instead: a boot banner and a permanent marker in the TUI. */
  readOnly?: boolean;
  /** Upstream request timeout in ms. Default: 30 000. */
  timeoutMs?: number;
  /** Liveness probe against the environment. */
  healthCheck?: RemoteHealthCheckConfig;
}

export interface RemoteHealthCheckConfig {
  /** Request path. Default: '/' */
  path?: string;
  /** Acceptable status code(s). Default: any response at all — an upstream
   *  that answers 401 is reachable, which is what this probe asks. */
  expect?: number | number[];
  /** Milliseconds between probes. Default: 30 000 — a remote environment is
   *  shared, and the 3 s cadence used for local services is rude at 24
   *  services. */
  intervalMs?: number;
  /** Per-probe timeout in ms. Default: 5000 */
  timeoutMs?: number;
}

/** How far a lazy service's real port sits from its configured one.
 *
 *  Lives here rather than in `lazy/` because the validator needs it to catch a
 *  service configured on a port that collides with another service's rewritten
 *  one — and a config module reaching into a feature module for a constant is
 *  the wrong direction. `lazy/classifier.ts` re-exports it, so every existing
 *  import keeps working. */
export const LAZY_PORT_OFFSET = 10000;

export interface LazyConfig {
  alwaysOn: string[];
  timeout?: number;
}

export interface ProxyConfig {
  provider: string;
  routes: Record<string, string>;
  confPath?: string;
  host?: string;
  tls?: boolean;
  entrypoint?: string;
}

export interface ExternalService {
  /** Friendly name (used in logs and the stats panel). Must be unique within `external`. */
  name: string;
  /** Shell command to start. Will be passed through `sh -c` / `cmd /c`. */
  cmd: string;
  /** Optional working directory (relative to the project root). */
  cwd?: string;
  /** Extra env vars merged on top of the project env. */
  extraEnv?: Record<string, string>;
  /** Optional readiness probe. devup waits for this to return `up` before starting phase 0. */
  healthCheck?: HealthCheckConfig;
  /** Port to probe when `healthCheck` is set. Required for tcp checks. */
  port?: number;
  /** Max seconds to wait for healthCheck to pass before giving up. Default: 60. */
  startTimeout?: number;
  /** Optional shell command run on shutdown (e.g. `docker compose down`). */
  stopCmd?: string;
}

export interface DevStackConfig {
  name: string;
  icon?: string;
  envFile?: string;
  env?: Record<string, string>;
  services: ServiceConfig[];
  lazy?: LazyConfig;
  proxy?: ProxyConfig;
  /** Named lists of service names — selectable with --profile <name>. */
  profiles?: Record<string, string[]>;
  /** Optional external dependencies (DBs, queues) started before phase 0. */
  external?: ExternalService[];
  /** Named remote environments — selectable with `--remote <name>`. A service
   *  not selected to run locally is served by forwarding its configured port
   *  to the environment instead of being absent. */
  environments?: Record<string, EnvironmentConfig>;
}

export function defineConfig(config: DevStackConfig): DevStackConfig {
  return config;
}
