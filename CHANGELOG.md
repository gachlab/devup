# Changelog

All notable changes to `@gachlab/devup` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/gachlab/devup/releases/tag/v0.2.0
[0.1.1]: https://github.com/gachlab/devup/releases/tag/v0.1.1
[0.1.0]: https://github.com/gachlab/devup/releases/tag/v0.1.0
