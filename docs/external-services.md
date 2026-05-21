# External services

Real stacks need databases, message queues, caches running before the application services. The `external` field tells devup how to start them, when to wait, and how to clean up.

## Why externals

You probably already have a `docker-compose.dev.yml` for Mongo / Redis / Postgres. Without devup's external hook you'd do:

```bash
docker compose -f docker-compose.dev.yml up -d
devup
```

Two-step. Easy to forget the first one. Worse, on `Ctrl+C` you have to remember to also `docker compose down`. With `external`:

```bash
devup    # one command, full stack
```

devup brings Mongo/Redis/etc up first, waits for them to be reachable, boots phase 0 only then. On exit, it kills them and runs the `stopCmd` you provided.

## Config

```typescript
export default defineConfig({
  // ...
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
    },
  ],
});
```

## Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | ✅ | Friendly name. Logs use the prefix `ext:<name>` and persist to `~/.devup/logs/<proj>/ext_<name>.log` |
| `cmd` | `string` | ✅ | Shell command (passed through `sh -c` / `cmd /c`) |
| `cwd` | `string` | | Working directory relative to project root. Default: project root |
| `extraEnv` | `Record<string, string>` | | Extra env vars merged on top of project env |
| `healthCheck` | `HealthCheckConfig` | | Readiness probe (TCP or HTTP) |
| `port` | `number` | ✅ when `healthCheck` is set | Port to probe |
| `startTimeout` | `number` | | Max seconds to wait for `healthCheck` to pass. Default: `60` |
| `stopCmd` | `string` | | Shell command on shutdown |

## Flow

1. devup spawns each external **sequentially**, in declaration order. Output is captured and logged with the `ext:<name>` prefix.
2. For each external that has a `healthCheck`, devup polls the probe until it passes or `startTimeout` expires.
3. If any external fails its healthCheck within the timeout, devup **aborts the boot**:
   - Logs `✗ externals failed: <names>`
   - Runs `stopCmd` for every external started (best-effort)
   - In `--once` mode: exits 1
   - In TUI mode: stays open, no services start
4. On clean shutdown (`Ctrl+C`, `q`):
   - Kills the external (kill-tree).
   - Runs `stopCmd` if provided (10 s cap so a hung `docker compose down` doesn't block forever).

Externals without `healthCheck` are spawned and assumed ready — devup logs `✅ started (no healthCheck)` and moves on.

## Patterns

### docker-compose, one file, multiple services

```typescript
external: [
  {
    name: 'mongo',
    cmd: 'docker compose -f docker-compose.dev.yml up -d mongo',
    port: 27017,
    healthCheck: { type: 'tcp' },
    stopCmd: 'docker compose -f docker-compose.dev.yml stop mongo',
  },
  // … repeat per service
],
```

The repetition is the price for explicit shutdown control. If you don't care about per-service shutdown order, use one `up` for everything:

```typescript
external: [
  {
    name: 'docker-stack',
    cmd: 'docker compose -f docker-compose.dev.yml up -d',
    // no port / healthCheck — assume "up" is enough
    stopCmd: 'docker compose -f docker-compose.dev.yml down',
  },
],
```

But then a failure to bring up Mongo isn't distinguishable from one in Redis. Granular is usually better.

### Health-check before phase 0 explicitly

If your application needs the DB schema migrated:

```typescript
external: [
  {
    name: 'postgres',
    cmd: 'docker compose up -d postgres',
    port: 5432,
    healthCheck: { type: 'tcp' },
    stopCmd: 'docker compose stop postgres',
  },
  {
    name: 'migrate',
    cmd: 'npm run db:migrate',
    // no port — devup just waits for exit 0; no healthCheck
  },
],
```

`migrate` runs after `postgres` is healthy. If it fails, the whole boot aborts. (Edge case: `migrate` is a one-shot command, not a long-running process. devup spawns it, waits for it to exit, and considers it "running" as long as it didn't crash. For a true one-shot you might prefer a `preBuild` on the API instead — see [Build hooks](./build-hooks.md).)

### HTTP healthcheck (Mongo with sidecar, Elastic, etc.)

```typescript
external: [
  {
    name: 'elastic',
    cmd: 'docker compose up -d elastic',
    port: 9200,
    healthCheck: { type: 'http', path: '/_cluster/health', expect: [200] },
    startTimeout: 90,  // Elastic boots are slow
    stopCmd: 'docker compose stop elastic',
  },
],
```

### Skip externals during fast dev

If you have a DB running natively and don't want devup to bring up docker every time, just don't put it in `external`. devup only manages what's listed.

For sometimes-want-it, sometimes-not, use the [profiles](./profiles.md) feature — but `external` is currently a single top-level field, not per-profile. (Future work; if you need it, file an issue.)

## Logs

External output appears in the logs panel with the `ext:<name>` prefix. The full log is also persisted to disk:

```
~/.devup/logs/<project>/ext_mongo.log
~/.devup/logs/<project>/ext_redis.log
```

So you can `tail -f` them or `devup logs ext:mongo` after the fact.

## Shutdown gotchas

- `stopCmd` runs **best-effort** — its exit code is ignored and a 10 s cap prevents a stuck docker from blocking devup's exit.
- If `Ctrl+C` is hit twice within ~3 s, devup escalates to SIGKILL on its tree but the external's `stopCmd` may not have had time to run. That's intentional: the second Ctrl+C is the "I want to leave NOW" signal.
- On `--watch-config` hot reload, externals are **not** restarted (current limitation). Only services in `services[]` are diffed.
