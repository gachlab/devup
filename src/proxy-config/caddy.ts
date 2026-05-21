import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProxyConfigProvider, ProxyOpts, ServiceState } from './types.js';

const EMPTY_CONFIG = '# devup: no healthy services\n';

/** Generates a Caddyfile.
 *  Tip: point Caddy at it with `caddy run --config <path> --adapter caddyfile` or include it. */
export class CaddyProvider implements ProxyConfigProvider {
  readonly name = 'caddy';

  generate(services: Map<string, ServiceState>, opts: ProxyOpts): string {
    const blocks: string[] = [];

    for (const [name, st] of services) {
      if (st.health !== 'up') continue;
      const sub = opts.routes[name];
      if (sub === undefined) continue;

      const host = sub ? `${sub}.${opts.domain}` : opts.domain;
      const port = st.realPort ?? st.port;
      const siteAddr = opts.tls ? host : `http://${host}`;

      blocks.push(
        `${siteAddr} {\n` +
        `    reverse_proxy ${opts.host}:${port}\n` +
        `}`,
      );
    }

    if (!blocks.length) return EMPTY_CONFIG;
    return blocks.join('\n\n') + '\n';
  }

  write(content: string, opts: ProxyOpts): void {
    const dir = dirname(opts.confPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(opts.confPath, content);
  }

  clear(opts: ProxyOpts): void {
    this.write(EMPTY_CONFIG, opts);
  }
}
