# devup

[![CI](https://github.com/gachlab/devup/actions/workflows/ci.yml/badge.svg)](https://github.com/gachlab/devup/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@gachlab/devup.svg)](https://www.npmjs.com/package/@gachlab/devup)

A terminal UI dev-stack runner for Node.js monorepos. Define your services in a config file; devup handles **phased startup, health checks, lazy on-demand proxies, build hooks, persistent logs, reverse-proxy config generation, and a JSON-RPC control plane** — all from a single TUI dashboard.

Built with TypeScript 6, Ink (React for terminals), and zero test dependencies (uses `node:test` natively).

## Features

### Orchestration
- **Phased startup** — boot services in dependency order with automatic port readiness detection.
- **Lazy mode** — only start services when they receive traffic; idle services shut down after a configurable timeout (respects active connections, no killing mid-WebSocket).
- **Profiles** — name common service subsets in config; boot with `devup --profile check-in`.
- **External hooks** — start `docker compose` (DBs, queues) before phase 0, with health gating and `stopCmd` on shutdown.
- **Build hooks** — `preBuild` (must succeed before spawn) and `watchBuild` (runs alongside the service), both managed by devup with kill-tree cleanup.
- **Hot reload** — `--watch-config` diffs `devup.config.*` on save and applies add/remove/restart without killing the TUI.
- **Auto-restart with backoff** — crashed services restart automatically with exponential backoff (2s → 4s → 8s), max 3 attempts; manual restart resets the counter; crash-loop badge surfaces services that need attention.
- **Pre-flight validation** — `--watch-path` arguments are checked against disk before spawn so a stale config after a rebase fails loudly instead of silently.
- **Port-conflict detection** — refuses to boot when ports collide, including lazy-mode `port + 10000` clashes.
- **npm install management** — automatic dependency installation with hash-based stamps to skip redundant installs.

### Readiness
- **TCP or HTTP health checks** — per-service `healthCheck` with configurable path, status codes, timeout, and `startPeriod` grace window.
- **`readyPattern`** — regex matched against stdout/stderr; the first match flips the service to `up`, short-circuiting the next health poll.
- **`errorPattern`** — only matching stderr lines bump the error counter (filters info-on-stderr noise).

### TUI
- **Live logs and process stats** — CPU, memory, health, errors, restarts in a split-panel terminal UI.
- **Scrolling, search, filter** — ↑/↓/PgUp/PgDn/Home/End; auto-pause when you scroll up; regex search with `/pattern/flags`.
- **Level filter** — `L` cycles `all → error → warn+error`.
- **Verbose stats** — `v` expands rows to show resolved `cmd`/args/env (secrets redacted).
- **Fuzzy filter** — service-picker modals (`f`/`r`/`o`) filter as you type.
- **Contextual tips** — one-liner nudges at teachable moments (high log volume, crash loop), once per session.
- **RAM watchdog** — banner surfaces when system RAM crosses 80% with top consumers (hysteresis: clears below 75%).
- **TLS-aware open** — `o` opens `https://<sub>.<domain>` when `--proxy` is active and TLS is on.

### Operations
- **Persistent logs** — every line streamed to `~/.devup/logs/<project>/<svc>.log` with rotation on each launch.
- **Subcommands** — `devup logs <svc> [--follow]`, `devup install`, `devup status`, `devup help` work without launching the TUI.
- **CI-ready** — `--dry-run` prints the resolved boot plan; `--once` boots, waits for readiness, exits `0/1` without a TUI.
- **Daemon mode** — `devup up -d` boots the stack detached (like `docker compose up -d`) so you can keep using the same terminal. `devup down` stops it. Linux + macOS.
- **Port-conflict takeover** — when something else is already on a configured port, devup shows you the holder (PID + process name) and offers to kill it. `--kill-port-conflicts` for non-interactive runs.
- **`devup ctl`** — CLI client for the control plane: `ping`, `status [--follow]`, `logs <svc> [--follow]`, `restart`, `stop`.
- **Reverse-proxy config** — generate Traefik, Nginx, or Caddy config from running services; health-aware.
- **Unix-socket control plane** — local JSON-RPC at `~/.devup/sock-<project>.sock` (chmod 0600); `status`, `restart`, `stop`, `logs.tail`, `logs.follow`, `status.follow`, `ping`.
- **Cross-platform** — Linux, macOS, and Windows for the TUI; daemon mode is Linux + macOS only.

## Quick start

```bash
npm install -D @gachlab/devup
```

Create `devup.config.ts`:

```typescript
import { defineConfig } from '@gachlab/devup';

export default defineConfig({
  name: 'MyApp',
  icon: '🚀',

  services: [
    {
      name: 'api',
      cwd: 'packages/api',
      cmd: 'node',
      args: ['--watch-path', 'src', 'src/index.js'],
      type: 'api',
      port: 3000,
      phase: 0,
      readyPattern: 'listening on',
    },
    {
      name: 'web',
      cwd: 'packages/web',
      cmd: 'npx',
      args: ['vite', '--port', '4200'],
      type: 'web',
      port: 4200,
      phase: 1,
      readyPattern: 'ready in',
    },
  ],
});
```

Run:

```bash
npx devup
```

See [docs/getting-started.md](./docs/getting-started.md) for a full walkthrough.

## Documentation

The comprehensive guide lives in [docs/](./docs/README.md):

- **[Getting started](./docs/getting-started.md)** — 5-minute tutorial
- **[Configuration reference](./docs/configuration.md)** — every field of `devup.config.ts`
- **[Health checks](./docs/health-checks.md)** — TCP / HTTP / `readyPattern` / `startPeriod` / `errorPattern`
- **[Lazy mode](./docs/lazy-mode.md)** — on-demand spawning, idle timeouts, troubleshooting
- **[Build hooks](./docs/build-hooks.md)** — `preBuild` and `watchBuild` for TypeScript services
- **[External services](./docs/external-services.md)** — wire docker-compose into the boot sequence
- **[Profiles](./docs/profiles.md)** — save service subsets under a name
- **[Reverse proxy](./docs/proxy.md)** — Traefik / Nginx / Caddy generators
- **[TUI tour](./docs/tui.md)** — every keybinding
- **[CLI reference](./docs/cli.md)** — flags + subcommands
- **[Control plane](./docs/control-plane.md)** — Unix-socket JSON-RPC
- **[Hot reload](./docs/hot-reload.md)** — `--watch-config`
- **[Recipes](./docs/recipes.md)** — patterns for Vite, Angular, NestJS, TypeScript, Docker
- **[Troubleshooting](./docs/troubleshooting.md)**
- **[Architecture](./docs/architecture.md)** — for contributors

## Requirements

- Node.js ≥ 22
- npm
- A terminal with TTY support (for the TUI; subcommands don't need it)

## Development

```bash
git clone https://github.com/gachlab/devup.git
cd devup
npm install
npm run build
npm test              # 331 tests, node:test native
npm run test:coverage
```

See [docs/architecture.md](./docs/architecture.md) for the codebase tour.

## Changelog

[CHANGELOG.md](./CHANGELOG.md) — every release, every notable change.

## Roadmap

[ROADMAP.md](./ROADMAP.md) — what's next, open questions, scope discussions.

## License

MIT © gachlab
