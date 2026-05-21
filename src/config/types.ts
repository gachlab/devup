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

export interface DevStackConfig {
  name: string;
  icon?: string;
  envFile?: string;
  env?: Record<string, string>;
  services: ServiceConfig[];
  lazy?: LazyConfig;
  proxy?: ProxyConfig;
}

export function defineConfig(config: DevStackConfig): DevStackConfig {
  return config;
}
