# Build hooks: `preBuild` and `watchBuild`

For TypeScript services or anything that needs a compile step, devup gives you two hooks per service: `preBuild` (synchronous, runs once) and `watchBuild` (background, runs alongside the service).

## Why hooks instead of `cmd: 'sh'`?

Before these hooks existed, the common workaround for TypeScript services was:

```typescript
// Don't do this anymore.
{
  cmd: 'sh',
  args: ['-c', 'npm run build && (npx tsup --watch &) && node --watch-path dist dist/index.js'],
}
```

That string hides build errors inside the service's mixed output, ties the watcher's lifetime to the shell, and confuses devup's process-tree management. With hooks:

- **Build errors are visible** with the `[build]` prefix.
- **devup owns the watcher's lifecycle** — kills it on stop/restart/cleanup. No orphans.
- **A failed build refuses to spawn the service**, which is shown as `crashed` in the stats panel.

## Syntax

```typescript
{
  name: 'orders-api',
  cwd: 'orders/api',
  cmd: 'node', args: ['dist/index.js'],
  type: 'api', port: 3031, phase: 1,
  preBuild: 'npm run build',
  watchBuild: 'npx tsup --watch',
}
```

## `preBuild`

A shell command that runs **before** the service spawn. devup waits for it to exit:

- Exit code 0 → spawn the service.
- Non-zero exit → mark the service `crashed`, skip the spawn, log the error.

Output is captured line by line, tagged `[build]`, and routed through the same log buffer + log file pipeline as the service. You'll see:

```
[build] 🔨 preBuild: npm run build
[build] > tsc -p .
[build] [02:14:32] Found 0 errors. Watching for file changes.
[build] ✅ done
```

`preBuild` runs through the platform shell (`sh -c` on Unix, `cmd /c` on Windows), so pipes, `&&`, env variables in `${...}` syntax — all work as you'd expect.

It runs once per service start (so it re-runs on `r` restart and on `--watch-config` reload). It does NOT re-run when a `watchBuild` rebuild succeeds — that's the watcher's job.

## `watchBuild`

A shell command spawned **alongside** the service as a sibling child process. devup tracks it via `state.watchProc` and kills it when:

- The service stops (manual `r` restart, `Ctrl+C` quit, crash-loop exhaustion).
- devup itself exits (`cleanup()`).

Output is tagged `[watch]`. Like `preBuild`, runs through the platform shell.

```
[watch] 👀 watchBuild: npx tsup --watch
[watch] [tsup] CLI Building entry: src/index.ts
[watch] [tsup] ESM dist/index.js  3.2 KB
[watch] [tsup] ESM ⚡️ Build success in 24ms
[watch] [tsup] CLI Watching for changes in: src
```

## Recipes

### TypeScript service with `tsup` + Node 22 watch

The classic TypeScript dev loop. `preBuild` produces the initial `dist/`; `watchBuild` keeps it fresh; Node's own `--watch-path dist` re-runs on changes.

```typescript
{
  name: 'orders-api',
  cwd: 'orders/api',
  cmd: 'node', args: ['--watch-path', 'dist', 'dist/index.js'],
  type: 'api', port: 3031, phase: 1,
  preBuild: 'npm run build',           // one-shot tsup
  watchBuild: 'npx tsup --watch',      // background tsup
}
```

### TypeScript service with `tsx` (no compile step)

If you're using `tsx` you don't need a build step at all — just run the source:

```typescript
{
  name: 'orders-api',
  cwd: 'orders/api',
  cmd: 'node',
  args: ['--import', 'tsx', '--watch-path', 'src', 'src/index.ts'],
  type: 'api', port: 3031, phase: 1,
  // no preBuild / watchBuild needed
}
```

### Generate code first, then watch

```typescript
{
  name: 'graphql-api',
  cwd: 'graphql/api',
  cmd: 'node', args: ['--watch-path', 'dist', '--watch-path', 'generated', 'dist/index.js'],
  type: 'api', port: 3050, phase: 1,
  preBuild: 'npm run codegen && npm run build',
  watchBuild: 'npx tsc --watch',
}
```

`preBuild` does codegen + initial compile (codegen first because tsc needs the generated types). `watchBuild` keeps the JS in sync; `--watch-path dist` triggers the Node restart on every successful rebuild.

### Run a sidecar process (like a worker) only while the service runs

`watchBuild` isn't strictly about builds — it's a generic "process pair" mechanism. Use it for any sidecar:

```typescript
{
  name: 'worker-host',
  cwd: 'apps/worker',
  cmd: 'node', args: ['index.js'],
  type: 'api', port: 5000, phase: 1,
  watchBuild: 'node tools/metric-relay.js',  // dies with the service
}
```

## What changes count as build errors?

devup just looks at the **exit code** of the `preBuild` command. Most compilers (`tsc`, `tsup`, `swc`, `esbuild`) exit non-zero on errors. If yours doesn't (some custom build scripts swallow exit codes), wrap it: `preBuild: 'npm run build || exit 1'` is enough.

## Limitations

- `watchBuild` is a single process. Need two background helpers? Chain them in a shell: `watchBuild: 'npx tsup --watch & npx prisma generate --watch'`. devup will kill the parent on shutdown; child processes inherit and die too.
- `preBuild` errors don't retry. devup doesn't re-attempt a failed build on its own — fix the source, restart the service with `r`.
- No incremental cache between devup runs. `preBuild` re-runs every time the service starts. If your build is slow, switch to `watchBuild` only and rely on the watcher for the initial build (just expect a brief period of "service running with stale dist" on first boot).

## Validator behavior

Both fields are validated:

- Empty string → error at config-load time.
- Non-string type → error.

The actual command isn't run during validation (would be too slow and side-effecty); the first run-through-and-fail happens on boot.
