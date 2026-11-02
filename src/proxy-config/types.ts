import type { HealthStatus } from '../process/types.js';

export interface ServiceState {
  port: number;
  /** The port to route to. For a lazy service that is its public port —
   *  see `routableStates`. */
  health: HealthStatus;
}

export interface ProxyOpts {
  host: string;
  domain: string;
  routes: Record<string, string>;
  tls: boolean;
  entrypoint: string;
  confPath: string;
  /** Traefik `certResolver` for TLS routers. Default: `le`. */
  certResolver?: string;
}

export interface ProxyConfigProvider {
  readonly name: string;
  generate(services: Map<string, ServiceState>, opts: ProxyOpts): string;
  write(content: string, opts: ProxyOpts): void;
  clear(opts: ProxyOpts): void;
}
