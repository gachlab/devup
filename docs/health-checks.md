# Health checks

devup decides when a service is "ready" using one of three signals, in priority order:

1. **`readyPattern`** — a regex matched against the service's stdout/stderr. The first match flips the service to `health: 'up'` immediately.
2. **`healthCheck`** — a periodic probe (TCP or HTTP) run by the polling loop every ~3 seconds.
3. **Default TCP probe on `port`** — if no `healthCheck` is configured, devup opens a TCP socket to `127.0.0.1:port` and considers the service ready when it accepts the connection.

`readyPattern` and `healthCheck` are **additive**, not exclusive. Both run in parallel. The first one to flip `health` to `up` wins.

## When to use which

| Situation | Best choice |
|---|---|
| Service just listens on a port; no HTTP framework | default (TCP) |
| Service has an HTTP healthcheck endpoint | `healthCheck: { type: 'http', path: '/healthz' }` |
| You want the phase transition to happen the millisecond the service prints "ready" | `readyPattern` (faster than waiting for the next 3-second poll) |
| Boot is slow (Angular, big webpack) and probes during boot fail noisily | `healthCheck.startPeriod` |

## `readyPattern`

The fastest way to mark a service ready. Frameworks usually print a recognisable line:

```typescript
// Vite: "ready in 423 ms"
{ name: 'web', cmd: 'npx', args: ['vite'], readyPattern: 'ready in' }

// Angular: "Compiled successfully"
{ name: 'app', cmd: 'npx', args: ['ng', 'serve'], readyPattern: '/compiled successfully/i' }

// Fastify: "Server listening at"
{ name: 'api', cmd: 'node', args: ['index.js'], readyPattern: 'server listening' }

// NestJS: "Nest application successfully started"
{ name: 'core', cmd: 'node', args: ['dist/main.js'], readyPattern: 'application successfully started' }
```

Grammar:

- **Plain string** → case-insensitive regex, matched against each stdout/stderr line
- **Vim-style `/pattern/flags`** → explicit regex; `i` is added if you don't include it

The pattern is compiled once when the service starts. Invalid regex is rejected at config-load time.

The periodic healthCheck still runs as a fallback after a match — if for some reason `readyPattern` matches but the service crashes immediately, the next probe will flip it back to `down`.

## `healthCheck: TCP`

Default behavior when `healthCheck` is absent. Just opens a socket:

```typescript
healthCheck: { type: 'tcp', timeoutMs: 2000 }
```

| Field | Default | Description |
|---|---|---|
| `type` | — | Must be `'tcp'` |
| `host` | `127.0.0.1` | Target host |
| `timeoutMs` | `2000` | Per-probe socket timeout |
| `startPeriod` | `0` | Grace window (see below) |

## `healthCheck: HTTP`

Real protocol probe:

```typescript
healthCheck: {
  type: 'http',
  path: '/healthz',
  expect: [200, 204],
  timeoutMs: 1500,
  startPeriod: 30,
}
```

| Field | Default | Description |
|---|---|---|
| `type` | — | Must be `'http'` |
| `path` | `'/'` | Request path; must start with `/` |
| `expect` | any 2xx | Acceptable status codes. Pass a `number` for exact, or `number[]` for a set |
| `host` | `127.0.0.1` | Target host |
| `timeoutMs` | `2000` | Per-request timeout |
| `startPeriod` | `0` | Grace window |

devup issues an HTTP GET and reads only the status code. Body is consumed and discarded.

## `startPeriod`

Seconds to wait after `start()` before the first probe runs. During the window:

- `status` stays `starting`
- `health` stays `wait`
- No socket/HTTP call is made (no failed probes, no inflated `errors`)
- The service is **not** considered ready

After the window, probes resume normally.

Use this when boot is genuinely slow and probes during the dead time would be a distraction. Don't set it as a buffer "just in case" — it makes the boot feel sluggish.

Typical values:

- Fastify / Express small app: 0 (default is fine)
- NestJS with many modules: 5–15
- Angular `ng serve --configuration=development`: 30–60
- Anything compiling a large webpack bundle: 30+

## `errorPattern`

Distinct concept from health, but lives nearby: limits which stderr lines count as errors.

By default every non-empty stderr line bumps `state.errors`. That column on the stats panel becomes noise the moment your tools write info to stderr (Angular CLI is a chronic offender). Set `errorPattern` to a regex that only matches real errors:

```typescript
{
  name: 'app-web',
  cmd: 'npx', args: ['ng', 'serve'],
  errorPattern: '/^(error|fatal):/i',
}
```

Doesn't change behavior — devup still logs every line. Only the error counter on the stats panel gets quieter.

Same `/pattern/flags` grammar as `readyPattern`.

## Order of operations in `start()`

1. Spawn the child process.
2. Compile `readyPattern` (if set).
3. Wire stdout/stderr to the log buffer + log file + readyPattern check + errorPattern check.
4. Mark `state.status = 'starting'`, `state.health = 'wait'`.
5. The periodic poll runs `healthCheck` every 3 s. If `startPeriod` is set and we're still inside it, the probe is skipped this round.
6. First match of `readyPattern` OR first successful probe → `health = 'up'`, `status = 'running'`.

## Examples

### Wait for HTTP /healthz with 30 s grace

```typescript
{
  name: 'app',
  cmd: 'node', args: ['dist/main.js'],
  type: 'api', port: 3000, phase: 1,
  healthCheck: { type: 'http', path: '/healthz', startPeriod: 30 },
}
```

### Combine readyPattern + HTTP probe (recommended for slow boots)

```typescript
{
  name: 'gateway',
  cmd: 'npx', args: ['next', 'dev'],
  type: 'api', port: 3000, phase: 0,
  readyPattern: 'ready started server',   // Next.js boot line — flips immediately
  healthCheck: { type: 'http', path: '/api/health', startPeriod: 5 },
}
```

### Accept either 200 or 503 (e.g. degraded modes during dev)

```typescript
{
  name: 'api',
  cmd: 'node', args: ['index.js'],
  type: 'api', port: 3000, phase: 0,
  healthCheck: { type: 'http', path: '/health', expect: [200, 503] },
}
```
