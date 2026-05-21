# Getting started

A 5-minute tour. We'll define a tiny stack with two services — one API and one web — and boot it.

## Prerequisites

- Node.js ≥ 22
- npm
- A terminal with TTY support (the TUI needs it)

## Install

In the root of your monorepo:

```bash
npm install -D @gachlab/devup
```

## Write the config

Create `devup.config.ts` at the project root:

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
      readyPattern: 'listening on',  // optional: speeds up phase transition
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

`type: 'api'` services are health-checked before devup moves to the next phase. `type: 'web'` services are assumed ready as soon as they print their boot line (`readyPattern`) or shortly after spawn.

## Boot

```bash
npx devup
```

You should see the TUI: a logs panel on top, a stats panel on the bottom, and a status bar with key bindings. The api boots first (phase 0); once it's healthy, the web boots (phase 1).

## Quick keys to try

- `↑` / `↓` — scroll the focused panel
- `Tab` — switch focus between Logs and Stats
- `/` — search in logs (`/error/` for regex)
- `f` — filter logs to a single service
- `o` — open a web service in the browser
- `r` — restart a service
- `q` or `Ctrl+C` — quit (devup kills every spawned process before exiting)

For the full list see [TUI tour](./tui.md).

## Next steps

- **Multiple services with dependencies** → [Configuration reference](./configuration.md)
- **HTTP health checks instead of just port-listening** → [Health checks](./health-checks.md)
- **TypeScript services that need a compile step** → [Build hooks](./build-hooks.md)
- **Don't want to boot all 30 services every time** → [Lazy mode](./lazy-mode.md) or [Profiles](./profiles.md)
- **External dependencies like Mongo/Redis** → [External services](./external-services.md)
- **CI / scripting (no TUI)** → [CLI reference](./cli.md#scripting-flags-dry-run--once)
