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
   *  written down. Only applies when `cmd` is `node`. */
  debug?: boolean | number;
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
}

export function defineConfig(config: DevStackConfig): DevStackConfig {
  return config;
}
