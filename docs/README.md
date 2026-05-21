# devup documentation

Comprehensive guides for `@gachlab/devup`. If you're new, start with [Getting Started](./getting-started.md). The rest is reference, browsable in any order.

## Guides

- **[Getting started](./getting-started.md)** — 5-minute tutorial. Define two services, boot the stack, see the TUI.
- **[Configuration reference](./configuration.md)** — every field of `devup.config.ts`, with defaults and examples.
- **[Health checks](./health-checks.md)** — TCP, HTTP, `readyPattern`, `startPeriod`, `errorPattern`.
- **[Lazy mode](./lazy-mode.md)** — how the TCP proxy works, idle timeouts, troubleshooting.
- **[Build hooks](./build-hooks.md)** — `preBuild` and `watchBuild` for TypeScript and other compile-step services.
- **[External services](./external-services.md)** — wire docker-compose (databases, queues) into the boot sequence.
- **[Profiles](./profiles.md)** — save service subsets under a name and boot them with `--profile`.
- **[Reverse proxy](./proxy.md)** — generating config for Traefik, Nginx, and Caddy; writing your own provider.
- **[TUI tour](./tui.md)** — every keybinding, scroll, search, filter, tips.
- **[CLI reference](./cli.md)** — flags and subcommands (`logs`, `install`, `status`).
- **[Control plane](./control-plane.md)** — Unix-socket JSON-RPC API for IDE plugins and scripts.
- **[Hot reload](./hot-reload.md)** — `--watch-config` edit-and-apply workflow.
- **[Recipes](./recipes.md)** — patterns for Vite, Angular, Next.js, Fastify, NestJS, monorepos with `preBuild`.
- **[Troubleshooting](./troubleshooting.md)** — what to check when something doesn't behave.
- **[Architecture](./architecture.md)** — for contributors: where code lives, how the pieces fit.

## Versions

All notable changes per release are in [CHANGELOG.md](../CHANGELOG.md). The roadmap for upcoming work lives in [ROADMAP.md](../ROADMAP.md).
