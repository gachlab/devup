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
  /** Grace period (seconds) before the first probe runs. Useful for slow boots
   *  (Angular cold-start, big webpack builds) so failed probes during boot don't
   *  pollute state.errors. Default: 0 (no grace). */
  startPeriod?: number;
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
