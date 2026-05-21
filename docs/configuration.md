# Configuration reference

Every field of `devup.config.ts`.

## File formats

devup looks for, in order:

1. `devup.config.ts` — TypeScript with full type checking (recommended)
2. `devup.config.js` — JavaScript (ESM or CJS)
3. `devup.config.json` — JSON (no functions or imports)

Or pass `--config path/to/file` to override.

## `DevStackConfig`

The top-level export of your config file.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | ✅ | Project name shown in the TUI header and in `~/.devup/logs/<name>/` |
| `icon` | `string` | | Emoji shown before the project name. Default: `📦` |
| `envFile` | `string` | | Path to `.env` file relative to project root. Default: `.env` |
| `env` | `Record<string, string>` | | Extra environment variables. Won't overwrite vars already present in `process.env` |
| `services` | `ServiceConfig[]` | ✅ | The list of services devup manages |
| `lazy` | `LazyConfig` | | Lazy mode configuration (see [Lazy mode](./lazy-mode.md)) |
| `proxy` | `ProxyConfig` | | Reverse proxy config generation (see [Reverse proxy](./proxy.md)) |
| `profiles` | `Record<string, string[]>` | | Named subsets of services bootable with `--profile <name>` (see [Profiles](./profiles.md)) |
| `external` | `ExternalService[]` | | Dependencies started before phase 0 (DBs, queues — see [External services](./external-services.md)) |

## `ServiceConfig`

One per service.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | ✅ | Unique within the config |
| `cwd` | `string` | ✅ | Working directory relative to project root |
| `cmd` | `string` | ✅ | Command to spawn (`node`, `npx`, etc.) |
| `args` | `string[]` | ✅ | Command arguments |
| `type` | `'api' \| 'web'` | ✅ | APIs are health-checked between phases; webs are assumed ready shortly after spawn |
| `port` | `number` | ✅ | Port the service listens on. Must be unique across services |
| `phase` | `number` | ✅ | Boot order. Phase 0 services start first; devup waits for all APIs in a phase to be healthy before starting the next phase |
| `maxMem` | `number` | | Max memory in MB. Injects `--max-old-space-size` for `node`, or `NODE_OPTIONS` for `npx` |
| `preBuild` | `string` | | Shell command run **before** the service spawns. Non-zero exit marks the service `crashed`. See [Build hooks](./build-hooks.md) |
| `watchBuild` | `string` | | Shell command spawned **alongside** the service (e.g. `npx tsup --watch`). Killed when the service stops. See [Build hooks](./build-hooks.md) |
| `nodeArgs` | `string[]` | | Extra Node.js arguments prepended before `args` |
| `extraEnv` | `Record<string, string>` | | Extra environment variables for this service only |
| `healthCheck` | `HealthCheckConfig` | | Override the readiness check. Default: TCP probe on `port`. See [Health checks](./health-checks.md) |
| `readyPattern` | `string` | | Regex matched against stdout/stderr; on match the service is marked `up` immediately. Plain string or vim-style `/pattern/flags`. See [Health checks](./health-checks.md) |
| `errorPattern` | `string` | | Only stderr lines matching this regex bump `state.errors`. Without it every non-empty stderr line counts |

### Phases

Services within the same phase start in parallel. devup waits for **every API** in a phase to become healthy before moving to the next phase. Webs are not waited for — once spawned, devup considers them ready (the assumption is that their dev server has its own readiness signal you can watch with `readyPattern`).

Phase numbers are arbitrary, just sort comparably. Typical layout for a monorepo:

```
Phase 0: Core infrastructure (config server, auth)
Phase 1: Base APIs (app, users, files, events)
Phase 2: Dependent APIs (notifications, search)
Phase 3: Final APIs (anything that needs phase 1/2 to exist)
Phase 4: Frontends (vite, ng serve, etc.)
```

## `LazyConfig`

```typescript
lazy: {
  alwaysOn: ['config-api', 'app-web'],
  timeout: 10,  // minutes
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `alwaysOn` | `string[]` | ✅ | Services that always start immediately (use this for your gateway / entry-points) |
| `timeout` | `number` | | Minutes of inactivity before an idle service shuts down. Default: `10` |

See [Lazy mode](./lazy-mode.md) for the on-demand spawning details.

## `ProxyConfig`

```typescript
proxy: {
  provider: 'traefik',  // or 'nginx' or 'caddy'
  routes: {
    'app-web':  '',        // root of the domain
    'admin-web': 'admin',  // admin.<domain>
    'api':      'api',
  },
  host: '172.17.0.1',         // optional, defaults per platform
  tls: true,                   // default true
  entrypoint: 'websecure',     // Traefik-only
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | `'traefik' \| 'nginx' \| 'caddy'` | ✅ | Built-in providers |
| `routes` | `Record<string, string>` | ✅ | Map of service name → subdomain. Empty string = root domain |
| `confPath` | `string` | | Path to write the generated config. Defaults to `~/.traefik/traefik_conf.yaml` or `~/.devup/<provider>.conf` |
| `host` | `string` | | Target host for proxy URLs. Default: auto-detected per platform (`172.17.0.1` on Linux, `host.docker.internal` on macOS/Windows) |
| `tls` | `boolean` | | Generate TLS config. Default: `true` |
| `entrypoint` | `string` | | Traefik entrypoint name. Default: `'websecure'`. Ignored for Nginx/Caddy |

The proxy config file is only written when `--proxy` is passed on the CLI. Only services with `health === 'up'` appear in the generated config. See [Reverse proxy](./proxy.md).

## `HealthCheckConfig`

See [Health checks](./health-checks.md) for the full discussion. Summary:

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `'tcp' \| 'http'` | ✅ | TCP probe (default) or HTTP GET |
| `path` | `string` | | HTTP-only request path. Default `/`. Must start with `/` |
| `expect` | `number \| number[]` | | HTTP-only acceptable status codes. Default: any 2xx |
| `host` | `string` | | Override target host. Default: `127.0.0.1` |
| `timeoutMs` | `number` | | Per-probe timeout. Default: `2000` |
| `startPeriod` | `number` | | Seconds to wait before the first probe. Useful for slow boots. Default: `0` |

## `ExternalService`

See [External services](./external-services.md). Summary:

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | ✅ | Friendly name; logs tagged `ext:<name>` |
| `cmd` | `string` | ✅ | Shell command. Pipes and `&&` work |
| `cwd` | `string` | | Working directory relative to project root |
| `extraEnv` | `Record<string, string>` | | Extra env vars |
| `healthCheck` | `HealthCheckConfig` | | Readiness probe; devup waits for it before phase 0 |
| `port` | `number` | required if `healthCheck` set | Port to probe |
| `startTimeout` | `number` | | Max seconds to wait for healthCheck. Default: `60` |
| `stopCmd` | `string` | | Shell command run on shutdown (e.g. `docker compose down`) |

## Validation

devup runs two passes at config-load time:

1. **Errors** (block boot, exit 1): required fields missing, duplicate names/ports, type mismatches, invalid regex in `readyPattern` / `errorPattern`, healthCheck without port, etc.
2. **Warnings** (printed, boot continues): things that look suspicious but might be intentional — e.g. `extraEnv.PORT` set to a value different from `svc.port`.

Both blocks are printed grouped, with the field path so you can find them fast.
