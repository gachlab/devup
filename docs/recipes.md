# Recipes

Patterns for common stacks and tools. Copy, adapt, ship.

## Vite (any frontend framework)

```typescript
{
  name: 'web',
  cwd: 'packages/web',
  cmd: 'npx',
  args: ['vite', '--port', '4200', '--host', '0.0.0.0'],
  type: 'web',
  port: 4200,
  phase: 4,
  readyPattern: 'ready in',
  maxMem: 512,
}
```

Vite prints `vite v5 ready in 423 ms` once it's ready. The `readyPattern` flips devup's health to `up` immediately. `--host 0.0.0.0` makes the dev server reachable through Docker bridges if you're using the reverse-proxy feature.

## Angular `ng serve`

```typescript
{
  name: 'app-web',
  cwd: 'app/web',
  cmd: 'npx',
  args: ['ng', 'serve', '--configuration', 'development',
         '--port', '4201', '--host', '0.0.0.0'],
  type: 'web',
  port: 4201,
  phase: 4,
  readyPattern: '/compiled successfully/i',
  maxMem: 1024,  // Angular CLI is hungry
  healthCheck: { type: 'tcp', startPeriod: 60 },  // first compile takes a while
  errorPattern: '/^(error|fatal):/i',  // Angular CLI writes a lot of warnings to stderr
}
```

The combination of `readyPattern` (fast on warm cache) + `healthCheck.startPeriod: 60` (suppresses noise during the slow first compile) keeps the boot clean.

## Next.js dev server

```typescript
{
  name: 'next',
  cwd: 'apps/next',
  cmd: 'npx', args: ['next', 'dev', '-p', '3000'],
  type: 'web',
  port: 3000, phase: 4,
  readyPattern: 'ready started server',
}
```

## NestJS

```typescript
{
  name: 'core-api',
  cwd: 'apps/core',
  cmd: 'node', args: ['dist/main.js'],
  type: 'api', port: 3000, phase: 1,
  preBuild: 'npm run build',
  watchBuild: 'npx tsc --watch',
  readyPattern: 'application successfully started',
  healthCheck: { type: 'http', path: '/health' },
}
```

## Fastify

```typescript
{
  name: 'api',
  cwd: 'packages/api',
  cmd: 'node', args: ['--watch-path', 'src', 'src/index.js'],
  type: 'api', port: 3000, phase: 1,
  readyPattern: 'server listening',
}
```

## TypeScript service with `tsx` (no build step)

```typescript
{
  name: 'orders-api',
  cwd: 'orders/api',
  cmd: 'node',
  args: ['--import', 'tsx', '--watch-path', 'src', 'src/index.ts'],
  type: 'api', port: 3031, phase: 1,
}
```

## TypeScript service with `tsup` + node-watch

```typescript
{
  name: 'orders-api',
  cwd: 'orders/api',
  cmd: 'node', args: ['--watch-path', 'dist', 'dist/index.js'],
  type: 'api', port: 3031, phase: 1,
  preBuild: 'npm run build',
  watchBuild: 'npx tsup --watch',
}
```

`preBuild` produces the initial `dist/`. `watchBuild` keeps it fresh. Node's `--watch-path dist` re-runs the service on every rebuild.

## Service with Prisma codegen

```typescript
{
  name: 'graphql-api',
  cwd: 'graphql/api',
  cmd: 'node', args: ['dist/index.js'],
  type: 'api', port: 3050, phase: 1,
  preBuild: 'npx prisma generate && npm run build',
  watchBuild: 'npx tsc --watch',
}
```

`prisma generate` first because tsc needs the generated client types.

## Docker-compose dependencies (Mongo + Redis)

```typescript
external: [
  {
    name: 'mongo',
    cmd: 'docker compose -f docker-compose.dev.yml up -d mongo',
    port: 27017,
    healthCheck: { type: 'tcp' },
    stopCmd: 'docker compose -f docker-compose.dev.yml stop mongo',
  },
  {
    name: 'redis',
    cmd: 'docker compose -f docker-compose.dev.yml up -d redis',
    port: 6379,
    healthCheck: { type: 'tcp' },
    stopCmd: 'docker compose -f docker-compose.dev.yml stop redis',
  },
],
```

## Postgres with migration step

```typescript
external: [
  {
    name: 'postgres',
    cmd: 'docker compose up -d postgres',
    port: 5432,
    healthCheck: { type: 'tcp' },
    startTimeout: 90,
    stopCmd: 'docker compose stop postgres',
  },
  {
    name: 'migrate',
    cmd: 'npm run db:migrate',
    // no port — devup just spawns and continues after exit
  },
],
```

## Sharing config across many similar services

Helper functions make the config concise:

```typescript
import { defineConfig, type ServiceConfig } from '@gachlab/devup';

const apiDefaults = (name: string, port: number, dir = name): ServiceConfig => ({
  name: `${name}-api`,
  cwd: `${dir}/api`,
  cmd: 'node',
  args: ['--watch-path', 'src', 'src/index.js'],
  type: 'api',
  port,
  phase: 1,
  maxMem: 192,
  readyPattern: 'listening',
});

export default defineConfig({
  name: 'MyMonorepo',
  services: [
    apiDefaults('auth', 3002),
    apiDefaults('users', 3003),
    apiDefaults('files', 3013),
    // ...
  ],
});
```

`ServiceConfig` is exported from the package so you can type your helpers.

## Multi-tenant with `extraEnv`

```typescript
{
  name: 'app-api',
  cwd: 'app/api',
  cmd: 'node', args: ['index.js'],
  type: 'api', port: 3000, phase: 1,
  extraEnv: {
    NODE_ENV: 'development',
    TENANT_ID: 'dev-tenant-1',
    DATABASE_URL: 'mongodb://localhost:27017/dev_tenant_1',
  },
},
```

Secrets-like keys (`API_KEY`, `JWT_SECRET`, anything matching `/secret|token|password|api[_-]?key|auth/i`) are auto-redacted in the verbose stats view (`v`).

## Different commands per OS (rare)

If you absolutely need OS-specific args, branch in the config:

```typescript
const isWin = process.platform === 'win32';

export default defineConfig({
  services: [
    {
      name: 'api',
      cmd: isWin ? 'npm.cmd' : 'npm',
      args: ['run', 'dev'],
      // ...
    },
  ],
});
```

In practice you rarely need this — devup spawns through the OS without a shell, so paths and binaries usually just work.

## CI smoke test

```yaml
# .github/workflows/smoke.yml
- run: npx devup --once --once-timeout 120 --no-log-file
```

Exit 0 means the stack booted cleanly. Pair with health-check assertions:

```bash
npx devup --once --once-timeout 120 &
DEVUP_PID=$!
sleep 5
curl -fsS http://localhost:3000/healthz || (kill $DEVUP_PID; exit 1)
kill $DEVUP_PID
```

Or use `devup status` against a separate running devup:

```bash
npx devup &
DEVUP_PID=$!
trap "kill $DEVUP_PID" EXIT
sleep 30
npx devup status     # exits 0 only if every healthCheck passes
```

## Profile per workflow

```typescript
profiles: {
  'gateway-only': ['config-api', 'app-api', 'app-web'],
  'fast-frontend': ['app-web', 'admin-web', 'staff-web'],  // talks to remote API
  'check-in': ['config-api', 'auth-api', 'app-api', 'check-in-api', 'app-web'],
  'pickup': ['config-api', 'pickup-api', 'pickup-drivers-web'],
}
```

Then `devup --profile check-in`, `devup --profile fast-frontend`. See [Profiles](./profiles.md).

## Live-editable config

```bash
devup --watch-config
```

Now editing `devup.config.ts` in another terminal applies diffs without restarting the TUI. See [Hot reload](./hot-reload.md).
