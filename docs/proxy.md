# Reverse proxy

devup can generate dynamic config for the reverse proxy in front of your stack. Three providers are built in: **Traefik**, **Nginx**, **Caddy**. You can also write your own.

devup updates the generated file every 3 seconds based on the live health state. Only services with `health === 'up'` are written. Flapping services drop out automatically and re-appear when they recover.

## Why generate it

In dev with many services, three things you don't want to do by hand:

1. Maintain a routing table that mirrors `devup.config.ts`.
2. Update it when you add a service.
3. Tell the proxy which subdomain → which backend, with health-aware fall-through.

devup writes the file and reloads it as your stack changes. Your reverse proxy watches the file (Traefik and Caddy do this natively) or you reload it (Nginx).

## Enabling

The config:

```typescript
export default defineConfig({
  // ...
  proxy: {
    provider: 'traefik',  // or 'nginx', 'caddy'
    routes: {
      'app-web':   '',         // root of the domain
      'admin-web': 'admin',    // admin.<domain>
      'api':       'api',
      'auth-api':  'auth-api',
    },
    host: '172.17.0.1',          // optional
    tls: true,                    // default
    entrypoint: 'websecure',      // Traefik only
  },
});
```

The CLI flag activates it:

```bash
devup --proxy
```

Without `--proxy`, the file is never written even if `proxy` is in your config. That way the same config works for both "I'm running my own proxy" and "no proxy today, just the TUI" workflows.

You can override the file path:

```bash
devup --proxy --proxy-conf /etc/traefik/conf.d/devup.yaml
devup --proxy --proxy-host 127.0.0.1   # override target host
devup --proxy --no-proxy-tls           # disable TLS in the generated config
devup --proxy --proxy-entrypoint web   # Traefik entrypoint name (default: websecure)
```

## Domain resolution

Each service in `routes` is mapped to:

- **Empty string**: `<domain>` (the root domain)
- **Any string**: `<value>.<domain>`

The `<domain>` itself comes from the `DOMAIN` env variable (or `GUESTHUB_DOMAIN` for historical reasons), falling back to `localhost`. Set it in your `.env`:

```ini
DOMAIN=dev.example.com
```

So `routes: { 'admin-web': 'admin' }` with `DOMAIN=dev.example.com` produces `admin.dev.example.com`.

For local development you typically map all subdomains to `127.0.0.1` via `/etc/hosts` or a wildcard DNS like nip.io (`*.127.0.0.1.nip.io`).

## Traefik

The default. Generates a YAML file for Traefik's [file provider](https://doc.traefik.io/traefik/providers/file/). Traefik watches the file natively — no reload needed.

```yaml
# docker-compose.yml
services:
  traefik:
    image: traefik:v3
    command:
      - --providers.file.directory=/etc/traefik/dynamic
      - --providers.file.watch=true
    volumes:
      - ~/.traefik:/etc/traefik/dynamic
    ports:
      - "443:443"
```

Run:

```bash
devup --proxy --proxy-host 172.17.0.1
```

Default config path: `~/.traefik/traefik_conf.yaml`. Override with `--proxy-conf`.

## Nginx

Generates one `server { }` block per healthy service. WebSocket upgrade headers are wired by default.

```typescript
proxy: {
  provider: 'nginx',
  confPath: '/etc/nginx/conf.d/devup.conf',
  routes: { 'app-web': '', 'api': 'api' },
}
```

With `tls: true` (default) each block listens on `:443 ssl` and points to `/etc/nginx/certs/<server_name>.crt` and `.key`. With `tls: false` it listens on `:80`.

> ⚠️ Nginx doesn't watch config files automatically. You'll need `nginx -s reload` (or a sidecar like [nginx-reload](https://github.com/imkulwant/nginx-reload-watcher)) to pick up devup's updates. For a watch-and-reload workflow, Traefik or Caddy is less friction.

## Caddy

Generates a Caddyfile. Caddy auto-reloads on file change (`caddy run --watch`), so updates take effect without intervention.

```typescript
proxy: {
  provider: 'caddy',
  confPath: '/etc/caddy/devup.Caddyfile',
  routes: { 'app-web': '', 'api': 'api' },
}
```

With `tls: true` (default) Caddy provisions TLS automatically — Let's Encrypt for public domains, local CA for `.local` or unknown TLDs. With `tls: false` each site is prefixed `http://`.

## Toggling at runtime

In the TUI, `T` (capital) toggles whether devup writes the proxy file. Useful when you want to inspect what would be written, or pause syncing while you edit by hand. The toggle state is per-session.

## Lazy mode interaction

When a service is lazy, devup's TCP proxy listens on `svc.port` and the actual service runs on `svc.port + 10000`. The generated reverse-proxy config points to the **real port** (`+ 10000`), not the devup-relayed one. That way the reverse proxy talks directly to the service, avoiding an extra hop.

For services in `lazy.alwaysOn` (no lazy proxy), the public `port` is used as-is.

## Writing your own provider

If you need HAProxy, Envoy, or an in-house reverse proxy, implement the `ProxyConfigProvider` interface:

```typescript
interface ProxyConfigProvider {
  readonly name: string;
  generate(services: Map<string, ServiceState>, opts: ProxyOpts): string;
  write(content: string, opts: ProxyOpts): void;
  clear(opts: ProxyOpts): void;
}
```

`generate()` is pure — it takes the current healthy-service snapshot and returns the file content. `write()` is the side-effecting save (typically `mkdir -p` + `writeFileSync`). `clear()` is called when the proxy sync is toggled off in the TUI.

There's a draft plugin mechanism in the roadmap (issues #31, #32) for registering custom providers via config without forking. Open if you'd find it useful.

## How often does it write?

Every 3 seconds, but **only** if the generated content changed since the last write. So a healthy idle stack doesn't churn the file (which matters if your file watcher is on a SUM-mounted filesystem). The first run after starting devup always writes, even if the content matches a previous run — to make sure the file is at least present.

## Debugging the generated file

`devup --dry-run --proxy` prints the YAML/conf that would be generated without booting anything. Useful for sanity checks when adding routes.

You can also `cat ~/.traefik/traefik_conf.yaml` (or wherever) while devup is running — the file is regenerated in place every 3 s.
