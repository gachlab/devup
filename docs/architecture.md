# Architecture

For contributors. Where the code lives, how the pieces fit, why some things are the way they are.

## High-level shape

devup is a single Node binary. The CLI entry resolves config, validates it, then either:

- **Renders the TUI** (default) — an Ink app that mounts the process manager, lazy proxies, control-plane socket, and optional config watcher.
- **Runs a no-TUI orchestrator** (`--dry-run`, `--once`, subcommands) — same primitives, different lifecycle.

The TUI is just one consumer of the underlying machinery. That separation is intentional: subcommands like `devup logs` and `devup install` should work the same way whether or not the TUI is running.

## Directory map

```
src/
  index.ts                   CLI entry; argv parsing, config loading, dispatch
  config/
    types.ts                 DevStackConfig, ServiceConfig, ExternalService
    loader.ts                find + load + dynamic-import config files
    validator.ts             validateConfig (errors) + collectWarnings
    cli.ts                   parseCliArgs + filterServices + USAGE
    diff.ts                  diffServices (used by --watch-config)
  process/
    types.ts                 ProcessState, ProcessStatus, HealthStatus
    manager.ts               ProcessManager: facade over spawner/restarter/
                             health-poller/lifecycle
    spawner.ts               spawn, port guard, stdio wiring, close handling
    restarter.ts             the auto-restart budget and its queued timers
    health-poller.ts         one probe round across state
    lifecycle.ts             stop, kill-tree, watchBuild teardown, cleanup
    liveness.ts              isRunning / waitForExit — never trust `pid`
    boot.ts                  bootStack: phases + lazy registration, shared by
                             the daemon and the TUI
    start-service.ts         start / restart / debug, shared by both hosts
    restart-service.ts       …
    debug-service.ts         …
    health.ts                checkPort (TCP), isPortBindable, checkHealth
    log-reader.ts            readLogWindow (--lines / --since)
    port-conflicts.ts        scan, blame, kill
    installer.ts             needsInstall, writeInstallStamp
    log-sink.ts              LogSink: persistent per-service log files
    external.ts              startExternals / stopExternals (Mongo, Redis, ...)
  remote/                    remote environments (--remote)
    classifier.ts            local/remote split, selection parsing
    proxy.ts                 the HTTP/WS reverse proxy and its health probe
    headers.ts               the header transforms, pure
    target.ts                where a service's traffic goes
    boot.ts                  registering remote services and their proxies
    switch.ts                moving one between local and an environment
    toggle.ts                which way the TUI's one-key toggle goes
  lazy/
    classifier.ts            split services into always-on vs lazy
    proxy.ts                 createLazyProxy: TCP relay + idle timer
  platform/
    types.ts                 Platform interface (kill, stats, openBrowser)
    detect.ts                platform-specific impl loader
    linux.ts / darwin.ts / win32.ts
  proxy-config/
    types.ts                 ProxyConfigProvider, ProxyOpts, ServiceState
    detect.ts                registry: 'traefik' / 'nginx' / 'caddy'
    traefik.ts / nginx.ts / caddy.ts
  control-plane/
    socket-server.ts         Unix-socket JSON-RPC
  orchestrator/
    dry-run.ts               --dry-run renderer
    once.ts                  --once orchestrator (no TUI)
    subcommands.ts           devup logs / install / status / help
  tui/
    App.tsx                  Top-level Ink component
    LogsPanel.tsx            Logs view
    StatsPanel.tsx           Stats view
    StatusBar.tsx
    ServiceList.tsx          Picker modal (f, r, o)
    SearchInput.tsx          / search input
    tips.ts                  pure pickTip()
    hooks/
      useProcessManager.ts   wraps ProcessManager + logs/stats state
      useKeyBindings.ts      key handler + state
      useProxySync.ts        writes the proxy file every 3 s
  utils.ts                   a re-export façade (17 lines) over utils/
  utils/
    stats.ts                 sortServiceNames, calcCpuPercent, the stats and
                             proxy-info builders both hosts share
    redact.ts                redactSecrets, redactUrl
    env.ts                   parseEnvFile
    format.ts, search.ts, colors.ts, phases.ts, broadcaster.ts,
    process-args.ts, system-load.ts, version.ts, install-stamp.ts

tests/
  unit/        mirrors src/
  integration/ process-lifecycle, lazy-proxy, remote-proxy, remote-switch,
               remote-boot, once, once-remote, exec, installer, daemon
  fixtures/    minimal-config.json, dummy-server.ts, dummy-crash.ts
```

## Data flow

### Boot

```
parseCliArgs
   ↓
findConfigFile + loadConfig (dynamic import for .ts/.js)
   ↓
validateConfig                  ──► exit 1 on errors
collectWarnings                 ──► print, continue
   ↓
filterServices (--profile / --services / --only / --skip)
   ↓
detectPlatform (linux | darwin | win32)
   ↓
[dispatch]
  --dry-run     → renderDryRun, exit 0
  --once        → runOnce (no TUI; ProcessManager + externals + waitHealthy)
  subcommand    → runLogs / runInstall / runStatus
  default       → render(<App />)
```

### The TUI lifecycle (`<App />`)

```
useProcessManager()  → creates ProcessManager; subscribes to onLog / onStateChange
useKeyBindings()     → keyboard state machine
useProxySync()       → conditional setInterval(3000) writing the proxy file

Boot useEffect:
  external?.length    → startExternals (blocks until healthy)
  lazy mode           → classifyServices; for alwaysOn: start in phases; for lazy: createLazyProxy per service
  normal mode         → start every service in phase order
```

Each phase awaits `Promise.all(waitForPort(...))` over the APIs in that phase before moving on. Webs are not awaited — they have no port-independent readiness signal at this level, and nothing downstream needs one to be up.

`--once` is the exception, deliberately: it waits for webs too, because a caller of `--once` must not have to wait again and a front end still compiling is not ready. That is why it keeps its own loop rather than sharing `bootStack` — see the note in `once.ts`.

### A service spawn

```
ProcessManager.start(svc, colorIdx)
  1. isPortBindable(svc.port)   both families; skip if occupied (and not isRestart)
                                — unless our own process still holds it and is draining
  2. runPreBuild()              if svc.preBuild — sh -c, waits for exit
                                non-zero → recordCrashedState, return
  3. extractWatchPaths(args)    pre-flight: verify --watch-path targets exist
                                missing → recordCrashedState, return
  4. spawn(svc.cmd, args, { detached: true })   → detached for kill-tree
  5. compileReadyPattern        regex matched against every line
  6. compileErrorPattern        regex used to decide if stderr line counts as error
  7. lineBuffer on stdout/stderr → markReadyIfMatch + log
  8. spawnWatchBuild()          if svc.watchBuild — sibling process tracked on state.watchProc
  9. proc.on('close')           → either crashed (auto-restart with backoff) or stopped intentionally
```

### Lazy proxy

```
createLazyProxy({ listenPort, targetPort, ... })
  net.Server on listenPort
    on connection:
      bumpActivity()
      if (serviceReady && isAlive) → pipeToTarget()
      else queue + onDemandStart() + waitForPort() + drain queue
  scheduleIdleCheck on a timer
    if activeConns.size === 0 && elapsed > periodMs → onIdleStop()
```

### Reverse-proxy file generation

```
useProxySync(provider, opts, states, enabled)
  setInterval(3000) →
    snapshot states → ServiceState map
    provider.generate(snapshot, opts) → string
    if changed since last write → provider.write(content, opts)
```

The Traefik / Nginx / Caddy providers are pure `generate()` functions plus a thin `write()` wrapper.

### Hot reload

```
useEffect (--watch-config)
  fs.watch(configPath) → debounced 250 ms → reload()
    loadConfig + validate (errors → log, skip)
    diffServices(running, next) → { added, removed, changed, unchanged }
    apply:
      removed → mgr.stop + mgr.state.delete
      changed → mgr.stop + 800 ms + mgr.install + mgr.start
      added   → mgr.install + mgr.start
    log "🔁 config reloaded: +X -Y ~Z"
```

### Control plane

```
startSocketServer(projectName, ctx)
  net.createServer on ~/.devup/sock-<project>.sock
  chmod 0600
  per connection: readline → dispatch(method, params, ctx)
    ping, info, status, status.follow, stats, start, restart, stop, debug, remote, logs.tail, logs.follow
  → JSON response over the same socket
```

## Cross-platform considerations

Three implementations of `Platform`:

- **LinuxPlatform** uses `ps` for stats, `kill -<pid>` for kill-tree (negative pid = process group).
- **DarwinPlatform** extends Linux with macOS-specific quirks (mostly browser opening with `open`).
- **Win32Platform** uses `wmic` for stats, `taskkill /T /F` for kill-tree, `cmd /c start` for browser.

Integration tests are skipped on Windows where they'd rely on Unix-specific shell behavior (sleep, single-quote strings). The features themselves work on Windows because the runtime code path routes through `cmd /c`. Only the test fixtures are awkward to write cross-platform.

## Tests

- **Unit tests**: `node:test` native runner, run in parallel. Test pure helpers, validators, panel rendering (via `ink-testing-library`), process manager with short-lived `node -e` scripts.
- **Integration tests**: spawn real processes via fixture servers (`tests/fixtures/dummy-server.ts`). Run in serial. Skipped on Windows where listed in their respective `{ skip: process.platform === 'win32' }`.

CI runs unit tests on Linux/macOS/Windows for every push. Integration tests only on `main` (3 OSes).

## Why these design choices

- **No EventEmitter event bus.** ProcessManager exposes `events: { onLog, onStateChange }` as plain callbacks. Simpler to test, harder to leak subscribers.
- **Pure helpers everywhere**. `compileSearchPattern`, `detectLogLevel`, `redactSecrets`, `nextRamBannerVisibility`, `diffServices`, `extractWatchPaths`, `compileReadyPattern`, `buildServiceUrl`. Each is exported, individually unit-tested, and lives in a small module. The bigger components (panels, process manager) compose them.
- **Filesystem perms for control plane auth**. Simpler than any in-process auth, no token rotation, no remote concerns. The cost is no multi-user support — fine for a dev tool.
- **`detached: true` + `kill -pid`**. The Unix way to kill a process tree without spawning helpers. Catches grandchildren that the parent doesn't track.
- **Per-PR releases via Trusted Publishing**. No `NPM_TOKEN` secret in the repo; provenance is auto-signed with sigstore.

## Adding a new feature

The pattern that's worked across 20+ features:

1. Where is the **pure logic** that could be tested without spawning anything? Put that in `utils.ts` or a new `<area>/<thing>.ts` with an exported function. Unit-test it before wiring.
2. Where does it **side-effect** (spawn, write file, write to TUI state)? That's a thin layer that calls the pure logic. Integration-test the boundary.
3. Add the CLI flag or config field. Update `validator.ts` if it has shape constraints. Update USAGE / README docs.

The validator pattern (errors block, warnings advisory) is the right place to land "this looks suspicious" feedback. Resist temptation to put it in the spawn path — the user has seen it before they care about runtime.

## Coding conventions

- TypeScript strict mode (`strict: true`). Every invariant here is null-carrying — `proc`, `pid`, `remote`, `crashLog` — so this is the compiler doing the work hazard 2 is about. Prefer explicit return types on exported functions.
- No emojis in code/docs unless the user asked for them. The exception: log output uses 🚀 🔨 ⚡ ⚠ ❌ ✓ to make scanning fast.
- Comments explain **why**, not what. The function name should already say what.
- One change = one branch = one PR, staged into a commit per step when it is large. The **CHANGELOG entry goes in that branch**; the **version bump goes in a separate `release/X.Y.Z` branch** with a `chore(release): X.Y.Z` commit, and publishing the GitHub release triggers `publish.yml`. That is what the last five releases did; the older "bump in the last commit of the branch" rule is not what the history shows.

## Bumping

See [CHANGELOG.md](../CHANGELOG.md) for the format. The flow:

1. Open `release/<version>` from `main`, commit features one by one.
2. Last commit: `chore: release <version>` with `package.json` bump and `CHANGELOG.md` entry.
3. PR → merge to main.
4. `gh release create <version> --target main --title "<version>" --notes-file <(awk '/^## \[<version>\]/,/^## \[<previous>\]/' CHANGELOG.md | sed '$d')`.
5. The `Publish` GitHub Actions workflow runs tests on Linux/macOS/Windows and publishes to npm via OIDC trusted publishing.

If publish fails: look at the workflow log, fix in a separate `ci/...` branch, merge, then `gh run rerun <run-id> --failed`.

## Pointers for the most-touched files

- **`src/process/manager.ts`** — ProcessManager class. Hardest file to navigate; spawn lifecycle lives here.
- **`src/tui/App.tsx`** — top-level Ink component; orchestrates everything for the TUI mode. Lots of useEffects (boot, control plane, hot reload, tips, paused/scrolled coupling).
- **`src/config/validator.ts`** — errors + warnings. Add new shape checks here.
- **`src/utils/`** — the pure helpers, one file per area. `utils.ts` at the root is only a re-export façade, kept so existing imports do not have to move.

## Where it could be better

- **`App.tsx` has too many useEffects** (boot, control plane, hot reload, paused-coupling, tips, resize). Could be split into smaller hooks. Hasn't bothered enough to warrant the refactor yet.
- **`ProcessManager` is a facade, and the shared state map is the part that still needs a decision.** The split into `Spawner` / `Restarter` / `HealthPoller` / `Lifecycle` shipped; `manager.ts` is ~130 lines that compose them. What the split did not settle is **who may write what** to the `state` map they share: the boot paths, the lazy proxy's idle stop and the remote modules all write fields directly, and the rule that such a write must be announced (`notifyStateChange`) is a convention, not a type. A lazy service that idled out went unannounced for exactly this reason, and only the streaming clients could see it — the snapshot was right either way.
- **Tests of TUI components rely on `ink-testing-library` and check substring matches in `lastFrame()`** — brittle if Ink changes its output. Acceptable for now because Ink's output is stable.
