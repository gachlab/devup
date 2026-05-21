import type { ProxyConfigProvider } from './types.js';
import { TraefikProvider } from './traefik.js';
import { NginxProvider } from './nginx.js';
import { CaddyProvider } from './caddy.js';

const providers: Record<string, () => ProxyConfigProvider> = {
  traefik: () => new TraefikProvider(),
  nginx: () => new NginxProvider(),
  caddy: () => new CaddyProvider(),
};

export function detectProxyProvider(name: string): ProxyConfigProvider {
  const factory = providers[name];
  if (!factory) {
    const available = Object.keys(providers).join(', ');
    throw new Error(`Unknown proxy provider: "${name}". Available: ${available}`);
  }
  return factory();
}
