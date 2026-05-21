import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProxyConfigProvider, ProxyOpts, ServiceState } from './types.js';

const EMPTY_CONFIG = '# devup: no healthy services\n';

/** Generates an Nginx server-block config file.
 *  Drop it into /etc/nginx/conf.d/ or include from your main nginx.conf. */
export class NginxProvider implements ProxyConfigProvider {
  readonly name = 'nginx';

  generate(services: Map<string, ServiceState>, opts: ProxyOpts): string {
    const blocks: string[] = [];

    for (const [name, st] of services) {
      if (st.health !== 'up') continue;
      const sub = opts.routes[name];
      if (sub === undefined) continue;

      const serverName = sub ? `${sub}.${opts.domain}` : opts.domain;
      const port = st.realPort ?? st.port;
      const listen = opts.tls ? '443 ssl' : '80';

      const tlsBlock = opts.tls
        ? `    ssl_certificate     /etc/nginx/certs/${serverName}.crt;\n` +
          `    ssl_certificate_key /etc/nginx/certs/${serverName}.key;\n`
        : '';

      blocks.push(
        `server {\n` +
        `    listen ${listen};\n` +
        `    server_name ${serverName};\n` +
        tlsBlock +
        `    location / {\n` +
        `        proxy_pass http://${opts.host}:${port};\n` +
        `        proxy_set_header Host $host;\n` +
        `        proxy_set_header X-Real-IP $remote_addr;\n` +
        `        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n` +
        `        proxy_set_header X-Forwarded-Proto $scheme;\n` +
        `        proxy_http_version 1.1;\n` +
        `        proxy_set_header Upgrade $http_upgrade;\n` +
        `        proxy_set_header Connection "upgrade";\n` +
        `    }\n` +
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
