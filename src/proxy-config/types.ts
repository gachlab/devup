import type { HealthStatus } from '../process/types.js';

export interface ServiceState {
  port: number;
  health: HealthStatus;
  realPort?: number;
}

export interface ProxyOpts {
  host: string;
  domain: string;
  routes: Record<string, string>;
  tls: boolean;
  entrypoint: string;
  confPath: string;
}

export interface ProxyConfigProvider {
  readonly name: string;
  generate(services: Map<string, ServiceState>, opts: ProxyOpts): string;
  write(content: string, opts: ProxyOpts): void;
  clear(opts: ProxyOpts): void;
}
