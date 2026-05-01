import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProxyConfigProvider, ProxyOpts, ServiceState } from './types.js';

const EMPTY_CONFIG = 'http:\n  routers: {}\n  services: {}\n';

export class TraefikProvider implements ProxyConfigProvider {
  readonly name = 'traefik';

  generate(services: Map<string, ServiceState>, opts: ProxyOpts): string {
    const routers: string[] = [];
    const svcs: string[] = [];

    for (const [name, st] of services) {
      if (st.health !== 'up') continue;
      const sub = opts.routes[name];
      if (sub === undefined) continue;

      const rule = sub ? `Host(\`${sub}.${opts.domain}\`)` : `Host(\`${opts.domain}\`)`;
      const safe = name.replace(/[^a-z0-9-]/g, '-');
      const port = st.realPort ?? st.port;

      let router = `    ${safe}:\n      rule: "${rule}"\n      service: ${safe}\n      entryPoints:\n        - ${opts.entrypoint}`;
      if (opts.tls) router += `\n      tls:\n        certResolver: le`;
      routers.push(router);

      svcs.push(`    ${safe}:\n      loadBalancer:\n        servers:\n          - url: "http://${opts.host}:${port}"`);
    }

    if (!routers.length) return EMPTY_CONFIG;
    return `http:\n  routers:\n${routers.join('\n')}\n  services:\n${svcs.join('\n')}\n`;
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
