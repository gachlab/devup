# Changelog

All notable changes to `@gachlab/devup` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-05-21

Config power release — six features that sharpen day-to-day debugging in a long-running stack.

### Added
- **Regex search in logs** (#8). `/` accepts vim-style `/pattern/flags` in addition to the existing case-insensitive substring mode. `/error/`, `/^api: \d+/`, `/foo/g` all work. Case-insensitive by default — add explicit flags after the slash if needed. Invalid regex falls back to substring search and shows `(invalid regex)` in the logs panel header so the user can correct it. Plain strings (including ones with slashes inside) keep working as substring matches.
- **`healthCheck.startPeriod` grace window** (#15). New optional field, in seconds. Probes are fully suppressed during the window, status stays `starting`, `health` stays `wait`. Eliminates spurious failed probes during slow boots (Angular cold-start, big webpack builds) that otherwise inflate `state.errors` and pollute the TUI.
- **Customizable error pattern per service** (#16). New `errorPattern?: string` field on `ServiceConfig`. When set, only stderr lines matching the regex (same `/pattern/flags` grammar as `readyPattern`) bump `state.errors`. Without it, every non-empty stderr line counts (existing behavior). Useful for libraries that write info to stderr — Angular CLI is the worst offender.
- **Filter logs by level** (#19). Each log line is tagged with a level on ingestion: `error > warn > info`. New `L` key cycles the filter: `all → error → warn+error → all`. Detection is keyword-based with conjugations (`error`, `fail(ed|ure|s)`, `fatal`, `exception`, `crash(ed|es)` → error; `warn(ed|ing|s)`, `deprec` → warn). Devup's own log markers count: `❌`/`✗`/`⛔` → error, `⚠` → warn. `a` (show all) also resets the level filter.
- **Verbose stats** (#21). New `v` key toggles the stats panel between compact mode and verbose mode. Verbose mode adds two dim indented lines per service: `cmd: <cmd> <resolved args>` (after `buildProcessArgs`, so devup-injected flags like `--max-old-space-size` are visible) and `env: KEY=value ...` (only when `extraEnv` is non-empty). Env values are auto-redacted (`***`) for keys matching `/secret|token|password|api[_-]?key|auth/i`.
- **Resource awareness — RAM watchdog banner** (#24). When system RAM usage crosses 80 % the stats panel shows a banner: `⚠ RAM 84% — top: app-api 520MB, staff-web 480MB, admin-web 460MB`. Hysteresis-driven (turns off only below 75 %, no flicker at the boundary). Top consumers are sorted by `stats.get(name).mem` and capped at 3.

### Changed
- `LogEntry` interface gains a required `level: LogLevel` field; both `pushLog()` and the manager-driven `onLog` handler compute it on ingestion.
- StatusBar shows the new `L` Level and `v` Verbose bindings.
- The Logs panel header gains `[level: error]` / `[level: warn+error]` markers when a level filter is active.

### Internals
- New pure helpers in `utils.ts`: `compileSearchPattern`, `detectLogLevel`, `redactSecrets`, `nextRamBannerVisibility`. All exported, all individually tested.
- Test suite grown from 274 to ~299. New suites: `compileSearchPattern` (6), `detectLogLevel` (5), `redactSecrets` (3), `nextRamBannerVisibility` (4), plus 2 manager tests for `errorPattern` and 1 for `healthCheck.startPeriod`.

## [0.4.0] — 2026-05-21

Polish + standalone CLI release. Eight focused improvements landed as a single PR with one commit per issue.

### Added
- **`devup --version` / `-v` and `devup --help` / `-h`** (#6). Both short-circuit before any config loading and exit `0`. Version is read from `package.json` at runtime so dev (via tsx) and the published tarball both report the right number.
- **Standalone subcommands** (#17): `devup logs <service> [--follow|-f]`, `devup install`, `devup status`, `devup help [<subcommand>]`. Reuse the persistent log files and the health-check primitives without launching the TUI. `logs --follow` tails new lines via `watchFile` and exits cleanly on SIGINT. `install` runs `npm install` across every service.cwd in parallel (max 4 at a time), skipping ones whose `.install-stamp` matches. `status` probes each service's healthCheck and prints a table.
- **Pre-flight check for `--watch-path` arguments** (#5). Before spawning a service, devup scans its args for `--watch` / `--watch-path` (both `--flag value` and `--flag=value` forms) and verifies every referenced path exists relative to the service's `cwd`. Missing paths mark the service `crashed` with one grouped error line instead of letting Node 22 die with a cryptic message after a rebase that renamed directories.
- **Browser open respects proxy + TLS** (#10). Pressing `o` in the TUI now opens `https://<sub>.<domain>` when `--proxy` is active and the service has a route. Falls back to `http://localhost:<port>` otherwise. Honors `proxy.tls: false` by using `http://` on the subdomain.
- **Crash-loop badge** (#11). Services that exhausted their auto-restart budget (`status === 'crashed' && restarts >= MAX_RESTARTS`) now render with `✖` (red, bold), status label `looping`, and a `⚠ N need attention` counter in the stats panel header. Easy to spot in a long service list.
- **Fuzzy filter in `ServiceList` modal** (#18). All three picker modals (`f`, `r`, `o`) now accept typed characters to filter the list in real time. Backspace removes a character. First Esc clears the filter, second Esc closes the modal. Sub-second selection on stacks with 30+ services.
- **Contextual tips** (#22). At teachable moments the TUI shows a dim one-liner in the header bar (e.g. "tip: press / to search in logs" once logs exceed 1000 lines, or "tip: press r to restart" when a service crash-loops). Each tip shows at most once per session and auto-clears after 12 s. Priority order favors actionable tips (crash → search → filter).

### Changed
- **`npm pkg fix` cleanup** (#7). `bin.devup` normalised to `dist/index.js` (no leading `./`), `repository.url` to `git+https://...`. New `prepack` script runs `npm pkg fix` on every publish so the warnings from 0.2.0 don't reappear.
- `ServiceList` footer hint updated: `type to filter  ↑↓ navigate  Enter select  Esc clear/close`.
- README gets a new "CLI subcommands" section and additions to the Features list ("Pre-flight validation", "Subcommands").

### Fixed
- Reordering inside the TUI key-binding handler so `Ctrl+F` (PgDn) never falls through to the filter modal (`f`). Same fix applied to other `Ctrl`-modified bindings.

### Internals
- Exported `extractWatchPaths(args)` from `process/manager.ts` (handles `--watch X`, `--watch-path X`, `--watch=X`, `--watch-path=X`; ignores `--watch-path` followed by another flag; doesn't match unrelated flags like `--watcher`).
- Exported `isCrashLooped(st)` + `MAX_RESTARTS` constant from `tui/StatsPanel.tsx` for test reuse and to drive the crash-loop banner.
- Exported `buildServiceUrl(name, port, proxyActive, proxyOpts)` from `tui/App.tsx` for testability.
- New `src/tui/tips.ts` with a pure `pickTip(state)` function — easy to extend by appending to the priority list.
- New `src/orchestrator/subcommands.ts` with `detectSubcommand`, `runLogs`, `runInstall`, `runStatus`, `runHelp`.
- Test suite grown to ~274.

## [0.3.0] — 2026-05-21

### Added
- **Profiles / scenarios** (#4). New `profiles: Record<string, string[]>` field on `DevStackConfig` plus a `--profile <name>` CLI flag. Lets you save common service-subset combinations under a name (e.g. `'check-in'`, `'pickup'`) and boot them with one short command instead of typing `--services` every time. Composable with `--skip`. Unknown profile names produce a friendly error listing what's available.
- **`readyPattern` for instant up detection** (#13). New per-service field accepting a plain string or vim-style `/pattern/flags` regex. On the first matching stdout/stderr line devup flips the service to `up` immediately, short-circuiting the next 3-second health-check poll. Speeds up phase transitions when frameworks print recognisable boot lines (Vite's `ready in 423 ms`, Angular's `Compiled successfully`, Fastify's `server listening`). The periodic health-check still runs as a fallback.
- **`preBuild` and `watchBuild` hooks** (#12). The fields existed in the type but were ignored. Now implemented properly:
  - `preBuild` runs synchronously before the spawn through the platform shell (`sh -c` / `cmd /c`); non-zero exit marks the service `crashed` and skips the spawn.
  - `watchBuild` is spawned as a sibling process and killed (kill-tree) on stop/restart/cleanup.
  - Output is tagged `[build]` / `[watch]` in the logs panel and flows through the same line buffer + log sink pipeline.
  - Replaces the awkward `sh -c 'npm run build && (npx tsup --watch &) && node ...'` workaround in projects with TypeScript services.
- **`external` / pre hooks for external dependencies** (#14). New top-level `external: ExternalService[]` field for databases, queues, etc. Externals run **before phase 0** through the platform shell with optional `healthCheck` gating and `stopCmd` on shutdown. devup aborts the boot (and runs every `stopCmd`) if any external fails its healthCheck within `startTimeout` (default 60 s). Closes the "do `docker compose up -d` then run devup" loop. Logs are tagged `ext:<name>` and persisted to `~/.devup/logs/<proj>/ext_<name>.log`.

### Changed
- `filterServices()` now accepts an optional `config` arg to resolve `--profile`. Calls from `index.ts` updated.
- `--dry-run` header now shows the active profile and a new `Externals (N):` section with each entry's healthCheck tag.
- `ProcessState` gains an optional `watchProc` field tracking the `watchBuild` side-car.
- `useProcessManager` exposes `pushLog()` so non-service log lines (externals, future side-cars) flow through the same pause buffer and log sink as regular service lines.

### Fixed
- Validator catches profile entries that reference unknown services or are empty arrays.
- Validator catches invalid `readyPattern` regex and empty strings.
- Validator catches empty `preBuild` / `watchBuild` strings.
- Validator catches external dependencies with missing `cmd`, duplicate names, missing `port` when a healthCheck is set, or `http` healthCheck paths without a leading `/`.

### Internals
- New module `src/process/external.ts` (`startExternals` / `stopExternals`).
- Test suite grown from 200 to ~237 — new suites: `ready-pattern`, `external` (Unix-only, follows the existing skip-on-Windows convention used by integration tests), validator coverage for every new field.
- Shell-dependent `preBuild`/`watchBuild` integration tests skipped on Windows. The feature itself works on both platforms because the runtime code path already routes through `sh -c` / `cmd /c`; only writing a single test command that exercises spawn behaviour across both shells without per-platform branching is awkward.

## [0.2.0] — 2026-05-21

### Added
- **HTTP health-checks per service.** New `healthCheck` config field on `ServiceConfig`. Supports `type: 'tcp'` (default) and `type: 'http'` with configurable `path`, `expect` (status code or list), `host`, and `timeoutMs`. Used by both the periodic in-TUI health poll and `--once`.
- **Persistent log files.** Every line streamed to `~/.devup/logs/<project>/<service>.log`, prefixed with an ISO-8601 timestamp. On each launch the previous file is rotated to `<service>.log.prev`. New flags `--no-log-file` (disable) and `--log-dir <path>` (override root).
- **`--dry-run`.** Prints the resolved boot plan — phases, commands with their final args/env, lazy proxies with their `realPort`, and the proxy YAML/conf that would be generated — then exits `0` without starting anything.
- **`--once` (+ `--once-timeout N`).** Boots every service phase-by-phase without rendering the TUI, waits for each API to become healthy, and exits `0` (all up) or `1` (timeout). Default timeout: 90s. Built for CI smoke tests.
- **Nginx proxy provider.** Generates one `server { }` block per healthy service, with TLS / non-TLS variants and WebSocket-upgrade headers wired by default.
- **Caddy proxy provider.** Generates a Caddyfile with `reverse_proxy` directives; TLS provisioning is delegated to Caddy by default.
- **Scroll indicators.** `[SCROLL]` badge appears in the Logs and Stats panel headers when the view is off the natural anchor (bottom for logs, top for stats).
- **`fmtUptime` now formats days.** Services running longer than a day display as `2d3h` instead of `120h0m`.

### Changed
- **TUI scroll completely rewritten.** Logs now use a `bottomOffset` model (0 = follow latest, N = N lines back); Stats use a coherent `topOffset` model. Arrow keys, `[`/`]`, `Ctrl+B`/`Ctrl+F`, and `Ctrl+A`/`Ctrl+E` always move in the expected visual direction regardless of which panel is focused.
- **Auto-pause when scrolling Logs.** New lines are buffered (capped at 5,000) while you're scrolled up, then replayed when you return to the bottom (`Ctrl+E`). The `p` key still works manually.
- **`p` (pause logs) actually pauses.** Before, it only changed the header label while logs kept streaming.
- **`c` (clear logs) actually clears.** Was a no-op; now properly cabled to `pm.clearLogs()`.
- **Manual `r` (restart) resets the auto-restart counter to 0.** Lets the user grant a fresh budget after fixing a flapping service.
- **`install()` accepts an explicit `colorIdx`.** Install logs no longer all appear in cyan; they match the service's tag color.
- **`cleanup()` is now async** and the TUI awaits it before `process.exit(0)`. Ensures the SIGKILL fallback (3 s after SIGTERM) actually has time to run.
- **`useProxySync` no longer recreates its interval on every state change** and skips writes when the generated content hasn't changed.
- **Reverse proxy provider docs.** README now covers Traefik, Nginx, and Caddy each with a code snippet.

### Fixed
- **Lazy proxy idle timer respects active connections.** Long-lived connections (WebSockets, SSE, HTTP/2 keep-alive) no longer get the underlying service killed mid-flight. The timer only fires when there are no active connections and no recent activity.
- **Lazy proxy fails cleanly when the on-demand start fails.** Pending connections are destroyed with a logged error instead of being piped to a dead target.
- **Log lines are no longer split mid-message.** Per-stream line buffer (`lineBuffer`) reassembles partial chunks from stdout/stderr.
- **`stderr` error count is no longer inflated.** Was counting blank lines from chunk splits; now counts one error per real line.
- **Terminal resize is now respected.** `stdout.on('resize')` re-renders the layout. Before, the height was captured on first paint and never updated.
- **Validator detects lazy-port collisions** between `service.port` and `otherService.port + 10000` and reports them at config-load time.
- **Validator validates `healthCheck` shape.** Rejects unknown `type` values and paths without a leading `/`.
- **Key bindings: `Ctrl+F` (page down) no longer triggers the filter modal.** Reordered handler so ctrl-modified keys are checked before single-letter shortcuts.

### Removed
- Dead `blessed`-style helpers from `utils.ts`: `highlightSearch`, `findSearchMatch`, `formatLogLine`, `shouldLogLine`, `buildLogsLabel`. The TUI is fully Ink-based and never used them.
- `installBatch` from `installer.ts`. Unused, with a subtle race in its `Promise.race` cleanup.

### Internals
- Test suite grown from 122 to 200 (`+78`). New: `health.test.ts` HTTP cases, `log-sink.test.ts`, `dry-run.test.ts`, `once.test.ts` (integration), `nginx.test.ts`, `caddy.test.ts`.
- New `src/orchestrator/` directory (`dry-run.ts`, `once.ts`) separates non-TUI flows from the React layer.

## [0.1.1] — 2026-05-07

### Added
- TUI panel navigation: `Tab` to switch focus between Logs and Stats, with focused-border highlighting.

### Fixed
- Cross-platform glob quoting in `test:*` npm scripts (Windows).
- Integration tests: more socket-error codes accepted (Windows), `os.tmpdir()` in validator test (Windows), longer timeouts on macOS CI, lifecycle test enabled on macOS while skipped on Windows.

### CI / packaging
- GitHub Actions workflow runs on Linux, macOS, and Windows.
- Split unit (every branch, 3 OSes) and integration (main only, 3 OSes) jobs.
- Upgraded actions to v5 / Node 24 runner.
- Publish workflow added — triggered by GitHub Release, runs tests on 3 OSes, then publishes to npm using trusted publishing (OIDC, no `NPM_TOKEN`).

## [0.1.0] — 2026-05-01

Initial release.

### Added
- Phased startup of services with TCP port-readiness detection.
- Lazy mode: on-demand start via a TCP proxy on the public port; service runs on `port + 10000`; idle timeout to stop the underlying process.
- Cross-platform process management (Linux/macOS via `ps` + `kill -pid`; Windows via `wmic` + `taskkill /T /F`) and browser-opening (`xdg-open`, `open`, `cmd /c start`).
- TUI dashboard built with Ink: live logs (filter, search, pause, timestamps), stats panel (CPU, memory, health, errors, restarts) with sort modes.
- Reverse-proxy config generation: Traefik file provider (YAML), health-aware (only `health === 'up'` services routed).
- Automatic dependency installation with hash-based stamps to skip redundant `npm install`s.
- Auto-restart with exponential backoff (2s → 4s → 8s), capped at 3 attempts.
- Port-in-use detection before starting a service.
- Config file resolution order: `devup.config.ts` → `.js` → `.json`, with `--config <path>` override. TypeScript loaded via the `tsx` import hook.
- CLI flags: `--only`, `--services`, `--skip`, `--lazy`/`--no-lazy`, `--timeout`, `--proxy`, `--proxy-host`, `--proxy-conf`, `--proxy-tls`/`--no-proxy-tls`, `--proxy-entrypoint`, `--config`.

[0.5.0]: https://github.com/gachlab/devup/releases/tag/0.5.0
[0.4.0]: https://github.com/gachlab/devup/releases/tag/0.4.0
[0.3.0]: https://github.com/gachlab/devup/releases/tag/0.3.0
[0.2.0]: https://github.com/gachlab/devup/releases/tag/0.2.0
[0.1.1]: https://github.com/gachlab/devup/releases/tag/0.1.1
[0.1.0]: https://github.com/gachlab/devup/releases/tag/0.1.0
