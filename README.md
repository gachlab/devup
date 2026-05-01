# devup

A terminal UI dev stack runner for Node.js monorepos. Define your services in a config file, and devup handles the rest: phased startup, health checks, lazy on-demand proxies, process stats, and reverse proxy config generation — all in a single TUI dashboard.

Built with TypeScript 6, Ink (React for terminals), and zero test dependencies (uses `node:test` natively).

## Features

- **Phased startup** — boot services in dependency order with automatic port readiness detection
- **Lazy mode** — only start services when they receive traffic. Idle services shut down after a configurable timeout
- **TUI dashboard** — live logs and process stats (CPU, memory, health, errors, restarts) in a split-panel terminal UI
- **Cross-platform** — Linux, macOS, and Windows. Platform-specific process management, stats collection, and browser opening
- **Reverse proxy config** — generate Traefik (or other) dynamic config from running services. Health-aware: only routes to healthy services
- **Project-agnostic** — works with any Node.js monorepo. Your project defines a `devup.config.ts`, devup does the rest
- **npm install management** — automatic dependency installation with hash-based stamps to skip redundant installs
- **Auto-restart with backoff** — crashed services restart automatically with exponential backoff (2s → 4s → 8s), max 3 attempts
- **Port conflict detection** — checks if a port is already in use before starting a service

## Quick start

### 1. Install

```bash
npm install -D @gachlab/devup
```

### 2. Create config

Create `devup.config.ts` in your project root:

```typescript
import { defineConfig } from '@gachlab/devup';

export default defineConfig({
  name: 'MyProject',
  icon: '🚀',
  envFile: '.env',

  services: [
    {
      name: 'api',
      cwd: 'packages/api',
      cmd: 'node',
      args: ['--watch-path', 'src', 'src/index.js'],
      type: 'api',
      port: 3000,
      phase: 0,
      maxMem: 256,
    },
    {
      name: 'web',
      cwd: 'packages/web',
      cmd: 'npx',
      args: ['vite', '--port', '4200'],
      type: 'web',
      port: 4200,
      phase: 1,
      maxMem: 512,
    },
  ],
});
```

### 3. Run

```bash
npx devup
```

## Config reference

### `DevStackConfig`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | ✅ | Project name shown in the TUI header |
| `icon` | `string` | | Emoji shown before the project name. Default: `📦` |
| `envFile` | `string` | | Path to `.env` file relative to project root. Default: `.env` |
| `env` | `Record<string, string>` | | Extra environment variables. Won't overwrite existing ones |
| `services` | `ServiceConfig[]` | ✅ | List of services to manage |
| `lazy` | `LazyConfig` | | Lazy mode configuration |
| `proxy` | `ProxyConfig` | | Reverse proxy config generation |

### `ServiceConfig`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | ✅ | Unique service name |
| `cwd` | `string` | ✅ | Working directory relative to project root |
| `cmd` | `string` | ✅ | Command to run (`node`, `npx`, etc.) |
| `args` | `string[]` | ✅ | Command arguments |
| `type` | `'api' \| 'web'` | ✅ | Service type. APIs get health-checked; webs are assumed ready after start |
| `port` | `number` | ✅ | Port the service listens on. Must be unique |
| `phase` | `number` | ✅ | Startup phase (0 = first). Services in the same phase start together; devup waits for all APIs in a phase to be ready before starting the next phase |
| `maxMem` | `number` | | Max memory in MB. Injects `--max-old-space-size` for `node` commands, or `NODE_OPTIONS` for `npx` |
| `preBuild` | `string` | | Command to run before starting (e.g., `npm run build`) |
| `watchBuild` | `string` | | Watch command to run alongside the service (e.g., `npx tsup --watch`) |
| `nodeArgs` | `string[]` | | Extra Node.js arguments |
| `extraEnv` | `Record<string, string>` | | Extra environment variables for this service |

### `LazyConfig`

| Field | Type | Required | Description |
|---|---|---|---|
| `alwaysOn` | `string[]` | ✅ | Service names that always start immediately |
| `timeout` | `number` | | Minutes of inactivity before stopping a lazy service. Default: `10` |

When lazy mode is active (default), services not in `alwaysOn` start a TCP proxy on their port. The real service only boots when something connects to that port. After `timeout` minutes of no connections, the service shuts down and returns to idle.

### `ProxyConfig`

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | `string` | ✅ | Proxy provider name. Currently: `'traefik'` |
| `routes` | `Record<string, string>` | ✅ | Map of service name → subdomain. Empty string = root domain |
| `confPath` | `string` | | Path to write the config file. Default: `~/.traefik/traefik_conf.yaml` |
| `host` | `string` | | Target host for proxy URLs. Default: auto-detected per platform |
| `tls` | `boolean` | | Enable TLS config. Default: `true` |
| `entrypoint` | `string` | | Proxy entrypoint name. Default: `'websecure'` |

The proxy config is only generated when `--proxy` is passed on the CLI. Only services with `health === 'up'` are included in the generated config.

## CLI flags

```
devup [options]
```

### Service selection

| Flag | Description |
|---|---|
| `--only apis` | Only start API services |
| `--only webs` | Only start web services |
| `--services api,web,auth` | Start only the named services |
| `--skip tasks-api,pickup-api` | Start everything except these |
| `--config path/to/config.ts` | Use a custom config file |

### Lazy mode

| Flag | Description |
|---|---|
| `--lazy` | Enable lazy mode (default) |
| `--no-lazy` | Disable lazy mode — start everything immediately |
| `--timeout 15` | Idle timeout in minutes (default: 10) |

### Reverse proxy

| Flag | Description |
|---|---|
| `--proxy` | Enable proxy config generation |
| `--proxy-host 127.0.0.1` | Override target host |
| `--proxy-conf /path/to/file` | Override config file path |
| `--proxy-tls` | Enable TLS (default) |
| `--no-proxy-tls` | Disable TLS |
| `--proxy-entrypoint web` | Override entrypoint name |

## TUI keybindings

| Key | Action |
|---|---|
| `q` / `Ctrl+C` | Quit and stop all services |
| `Tab` | Switch focus between Logs and Stats panels |
| `f` | Filter logs by service |
| `a` | Show all logs (clear filter) |
| `/` | Search in logs |
| `p` | Pause/resume log output |
| `t` | Toggle timestamps |
| `c` | Clear logs |
| `s` | Cycle sort mode (name → memory → errors) |
| `r` | Restart a service |
| `o` | Open a web service in browser |
| `T` | Toggle reverse proxy config sync |

## Config file formats

devup looks for config files in this order:

1. `devup.config.ts` — TypeScript with full type checking and intellisense
2. `devup.config.js` — JavaScript (ESM or CJS)
3. `devup.config.json` — JSON (no functions or imports)

Or pass `--config path/to/file` to use a custom path.

## Phases

Services boot in phase order. Within a phase, all services start simultaneously. devup waits for all API services in a phase to respond on their port before moving to the next phase.

```
Phase 0: Core infrastructure (config server, auth)
Phase 1: Base APIs (app, users, files, events)
Phase 2: Dependent APIs (communications, notifications)
Phase 3: Final APIs
Phase 4: Frontends (Angular, Svelte, React, Vite)
```

Phase numbers are arbitrary — use whatever makes sense for your dependency graph.

## Lazy mode

In lazy mode, devup creates a TCP proxy on each lazy service's original port. The real service runs on `port + 10000` when started.

```
Client → :3000 (proxy) → :13000 (real service)
```

When a connection arrives and the service is idle, devup:
1. Runs `npm install` if needed
2. Starts the service on the offset port
3. Waits for the port to be ready
4. Pipes the buffered connection through

After `timeout` minutes with no connections, the service stops and returns to idle.

Services listed in `lazy.alwaysOn` skip the proxy and start normally.

## Platform support

| Feature | Linux | macOS | Windows |
|---|---|---|---|
| Process stats (CPU, memory) | `ps` | `ps` | `wmic` |
| Kill process tree | `kill -pid` | `kill -pid` | `taskkill /T /F` |
| Open browser | `xdg-open` | `open` | `cmd /c start` |
| Default proxy host | `172.17.0.1` | `host.docker.internal` | `host.docker.internal` |

## Reverse proxy providers

devup generates dynamic config for reverse proxies. Currently supported:

### Traefik

Generates a YAML file for Traefik's [file provider](https://doc.traefik.io/traefik/providers/file/). Mount the config file as a volume in your Traefik container.

```yaml
# docker-compose.yml
services:
  traefik:
    volumes:
      - ~/.traefik:/etc/traefik/dynamic
```

```bash
devup --proxy --proxy-host 172.17.0.1
```

Adding a new provider (Nginx, Caddy, etc.) requires implementing the `ProxyConfigProvider` interface:

```typescript
interface ProxyConfigProvider {
  readonly name: string;
  generate(services: Map<string, ServiceState>, opts: ProxyOpts): string;
  write(content: string, opts: ProxyOpts): void;
  clear(opts: ProxyOpts): void;
}
```

## Example: full config

```typescript
import { defineConfig } from '@gachlab/devup';

export default defineConfig({
  name: 'MyApp',
  icon: '⚡',
  envFile: '.env',
  env: {
    DOMAIN: 'localhost',
  },

  services: [
    // Phase 0 — Core
    { name: 'config-api', cwd: 'config/api', cmd: 'node', args: ['src/index.js'], type: 'api', port: 2999, phase: 0, maxMem: 192 },

    // Phase 1 — APIs
    { name: 'auth-api',   cwd: 'auth/api',   cmd: 'node', args: ['src/index.js'], type: 'api', port: 3002, phase: 1, maxMem: 192 },
    { name: 'app-api',    cwd: 'app/api',    cmd: 'node', args: ['src/index.js'], type: 'api', port: 3000, phase: 1, maxMem: 256 },
    { name: 'files-api',  cwd: 'files/api',  cmd: 'node', args: ['src/index.js'], type: 'api', port: 3013, phase: 1, maxMem: 192 },

    // Phase 1 — TypeScript API with build step
    { name: 'orders-api', cwd: 'orders/api', cmd: 'node', args: ['dist/index.js'], type: 'api', port: 3031, phase: 1, maxMem: 256,
      preBuild: 'npm run build', watchBuild: 'npx tsup --watch' },

    // Phase 2 — Dependent APIs
    { name: 'notifications-api', cwd: 'notifications/api', cmd: 'node', args: ['src/index.js'], type: 'api', port: 3010, phase: 2, maxMem: 256 },

    // Phase 4 — Frontends
    { name: 'app-web',   cwd: 'app/web',   cmd: 'npx', args: ['ng', 'serve', '--port', '4201'], type: 'web', port: 4201, phase: 4, maxMem: 512 },
    { name: 'admin-web', cwd: 'admin/web', cmd: 'npx', args: ['vite', '--port', '4204'],        type: 'web', port: 4204, phase: 4, maxMem: 384 },
    { name: 'staff-web', cwd: 'staff/web', cmd: 'npx', args: ['vite', '--port', '4040'],        type: 'web', port: 4040, phase: 4, maxMem: 384 },
  ],

  lazy: {
    alwaysOn: ['config-api', 'app-web'],
    timeout: 10,
  },

  proxy: {
    provider: 'traefik',
    routes: {
      'app-web':   '',
      'admin-web': 'admin',
      'staff-web': 'staff',
      'app-api':   'app-api',
      'auth-api':  'auth-api',
      'files-api': 'files-api',
    },
  },
});
```

## Requirements

- Node.js >= 22
- npm (for dependency installation)
- A terminal with TTY support (for the interactive TUI)

## Development

```bash
git clone https://github.com/gachlab/devup.git
cd devup
npm install
npm run build
npm test              # 112 tests, node:test native
npm run test:coverage # coverage report
```

## License

MIT © gachlab
