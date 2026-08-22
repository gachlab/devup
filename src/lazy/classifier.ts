import type { ServiceConfig, LazyConfig } from '../config/types.js';

export const LAZY_PORT_OFFSET = 10000;
export const DEFAULT_LAZY_TIMEOUT = 10;

export interface ClassifiedServices {
  alwaysOn: ServiceConfig[];
  lazy: ServiceConfig[];
}

export function classifyServices(services: ServiceConfig[], config?: LazyConfig): ClassifiedServices {
  const alwaysOnSet = new Set(config?.alwaysOn ?? []);
  const alwaysOn: ServiceConfig[] = [];
  const lazy: ServiceConfig[] = [];

  for (const svc of services) {
    if (alwaysOnSet.has(svc.name)) alwaysOn.push(svc);
    else lazy.push(svc);
  }
  return { alwaysOn, lazy };
}

export function getLazyRealPort(originalPort: number): number {
  return originalPort + LAZY_PORT_OFFSET;
}

export function rewriteServicePort(svc: ServiceConfig): ServiceConfig & { realPort: number; originalPort: number } {
  const realPort = getLazyRealPort(svc.port);
  const args = svc.args.map(a => a === String(svc.port) ? String(realPort) : a);
  const extraEnv = { ...svc.extraEnv, PORT_OVERRIDE: String(realPort) };
  return { ...svc, port: realPort, args, extraEnv, realPort, originalPort: svc.port };
}

/** Tear down and forget the lazy proxy for a service that has been removed.
 *
 *  The proxy listens on the service's *public* port, so it outlives the process
 *  it fronts: until it is destroyed, a single connection re-enters the
 *  on-demand start path and resurrects a service every client was just told had
 *  gone. Call this before announcing the removal, not after.
 *
 *  Returns whether a proxy was actually released, which callers can log. */
export function releaseLazyProxy(
  proxies: Map<string, { destroy: () => void }> | undefined | null,
  name: string,
): boolean {
  const proxy = proxies?.get(name);
  if (!proxy) return false;
  proxy.destroy();
  proxies!.delete(name);
  return true;
}
