# Roadmap

Living list of proposed features for `@gachlab/devup`. This is the source of truth; new ideas go here first and graduate to GitHub Issues / a release milestone when prioritized.

## Conventions

For each item:

- **Effort** — rough size: `S` ≤ ~2h, `M` ≤ ~1 day, `L` ≥ ~2 days.
- **Value** — `low` / `med` / `high` based on impact on real-world stacks (the reference today is the GuestHub monorepo: 24 APIs + 8 frontends, lazy mode, Traefik).
- **State** — `proposed` (just an idea), `planned` (scheduled for a release), `in-progress`, `done`.

## Vision and non-goals

devup is a **developer-experience tool for local monorepo orchestration**: phased boot, lazy on-demand starts, live TUI, reverse-proxy config generation. It is not a production process supervisor. Items in the *Production mode* track are open questions about whether to invade that territory or keep the scope tight.

---

## Track 1 — Quick wins

Items here are short to implement and have outsized payoff for daily use.

### 1. Profiles / scenarios
**Effort:** S · **Value:** high · **State:** proposed

Add `profiles: Record<string, string[]>` to the config and a `--profile <name>` CLI flag. Each profile is a named list of services to boot.

Today users hand-type `--services check-in-api,app-api,configurations-api,app-web,authorization-api` from memory. With profiles:

```ts
profiles: {
  'check-in': ['configurations-api', 'authorization-api', 'app-api', 'check-in-api', 'app-web'],
  'pickup':   ['configurations-api', 'pickup-api', 'pickup-drivers-web'],
}
```

then `devup --profile check-in`. Composable with `--skip`. Validator checks profile entries reference real services.

### 2. Pre-flight check for `--watch-path` arguments
**Effort:** S · **Value:** med-high · **State:** proposed

Before spawning, scan `svc.args` for `--watch-path` / `--watch` patterns and validate that each referenced path exists in `cwd`. Stale paths after a rebase cause Node 22 to die with a cryptic message. Report all missing paths up front per service.

### 3. `devup --version` and `devup --help`
**Effort:** S · **Value:** med · **State:** proposed

Today both arguments fall through and launch the TUI. Standard CLI hygiene.

### 4. `npm pkg fix` cleanup
**Effort:** S · **Value:** low · **State:** proposed

The publish workflow warned: `"bin[devup]" script name dist/index.js was invalid and removed` (cosmetic — the bin survived). Normalize `bin` and `repository.url` per `npm pkg fix`. Add a `prepack` script that runs it.

### 5. Regex search in logs
**Effort:** S · **Value:** med · **State:** proposed

`SearchInput` accepts a leading `/` to enable regex mode (mirroring vim). `LogsPanel.isMatch` switches between `.includes` and `RegExp.test`. Invalid regex → fall back to substring with a hint in the search bar.

### 6. Validator warning for `extraEnv.PORT` mismatch
**Effort:** S · **Value:** low · **State:** proposed

If a service has `extraEnv.PORT` and it doesn't equal `port` (or in lazy mode, `realPort`), emit a warning. Common source of confusion.

### 7. Browser open respects TLS
**Effort:** S · **Value:** med · **State:** proposed

Today `o` (open in browser) always builds `http://localhost:port`. If `proxy.tls === true` and the service has a route, open `https://<sub>.<domain>` instead. Otherwise fall back to localhost.

### 8. Crash-loop badge
**Effort:** S · **Value:** med · **State:** proposed

In `StatsPanel`, mark services that have exhausted their auto-restart budget (`restarts >= MAX_RESTARTS` and `status === 'crashed'`) with a distinct color/icon. They are easy to miss in a long list.

---

## Track 2 — Config features (medium effort, high payoff)

### 9. Implement `preBuild` and `watchBuild`
**Effort:** M · **Value:** high · **State:** proposed

These fields exist in `ServiceConfig` but `ProcessManager.start()` ignores them. GuestHub works around this with `cmd: 'sh', args: ['-c', 'npm run build && (npx tsup --watch &) && node ...']`.

Implementation:
- `preBuild`: run synchronously before the service spawn; if it fails, skip the service and mark it `crashed`.
- `watchBuild`: spawn alongside the service as a sibling child process; pipe its stdout/stderr to the same log tag with a `[build]` prefix.

Both should be visible in the TUI (separate health column or sub-state).

### 10. `readyPattern` per service
**Effort:** M · **Value:** high · **State:** proposed

Add `readyPattern?: string | RegExp` to `ServiceConfig`. When the pattern matches in a service's stdout, immediately mark `health: 'up'` (and move to the next phase) without waiting for the next 3-second health poll. Vite and ng-serve already print recognizable "ready" lines.

This shaves potentially 3-5 seconds off every phase transition. Especially valuable in `--once` mode for CI.

### 11. `external` / `pre` hooks
**Effort:** M · **Value:** high · **State:** proposed

A top-level `external?: ExternalService[]` array runs before phase 0. Each entry has `cmd`, `args`, optional `healthCheck`, and an optional `stopCmd`. Typical use: `docker compose up -d` for Mongo/Redis.

devup waits for each external's healthCheck before starting phase 0, and runs `stopCmd` (or just `docker compose down`) on shutdown.

### 12. `healthCheck.startPeriod`
**Effort:** S · **Value:** med · **State:** proposed

Grace period before the first health probe runs. Useful for Angular (`ng serve` takes 30–60 s on cold start) so failed probes during boot don't pollute `state.errors`.

### 13. Customizable error/warn patterns
**Effort:** S · **Value:** low-med · **State:** proposed

Today `state.errors++` is incremented per non-empty stderr line. Many libraries write info messages to stderr (Angular CLI does). Allow a per-service `errorPattern?: RegExp` so only matching lines count.

---

## Track 3 — TUI improvements

### 14. CLI standalone commands
**Effort:** M · **Value:** high · **State:** proposed

Reuse `LogSink` and the orchestrator without launching the TUI:

- `devup logs <svc>` — tail the persisted log file (`~/.devup/logs/<proj>/<svc>.log`).
- `devup logs --follow <svc>` — `tail -f` semantics.
- `devup status` — read live state (via the unix socket from item #24, or by polling health endpoints if devup is running).
- `devup install` — run `npm install` in parallel across every service without booting anything. Useful right after `git clone` or branch switches.

### 15. Fuzzy filter in `ServiceList`
**Effort:** S · **Value:** med · **State:** proposed

`ServiceList` (used by `f`, `r`, `o`) currently navigates with arrows. Add inline typing that filters the list as you type — sub-second selection for stacks with 30+ services.

### 16. Filter by log level
**Effort:** M · **Value:** med · **State:** proposed

Detect levels by pattern (`error`, `warn`, `info`, `debug`) and add a TUI binding to toggle visibility. Keep it simple: regex per level, default English keywords, configurable.

### 17. Active-service color in filtered logs panel
**Effort:** S · **Value:** low · **State:** proposed

When a filter is set, paint the panel border / header in the filtered service's tag color. Subtle reinforcement of context.

### 18. Verbose mode in stats panel
**Effort:** S · **Value:** low · **State:** proposed

Press `v` in the stats panel to expand the row with `cmd`, fully-resolved `args`, and `extraEnv`. Often you want to confirm "did devup actually pass the flag I expected?" without leaving the TUI.

### 19. Contextual tips
**Effort:** S · **Value:** low · **State:** proposed

When the logs panel has > 1000 lines and no `searchTerm`, show a dim hint: `tip: press / to search`. Similar nudges for `Tab` (when only logs is focused for a while), `f` (filter), etc. Toggle off via config.

---

## Track 4 — Robustness / operations

### 20. Hot reload of `devup.config.ts`
**Effort:** L · **Value:** med · **State:** proposed

Watch the config file. On change: reload the config, diff against the running set, and apply (start newly added services, stop removed ones, restart services whose `cmd`/`args`/`extraEnv` changed). Tricky because phases reorder and lazy proxies need to rebind. Probably ships behind `--watch-config`.

### 21. Resource awareness
**Effort:** M · **Value:** med · **State:** proposed

Add a memory/CPU watchdog: when system RAM > 80%, surface a TUI notice listing the top-N consumers. Optionally, in lazy mode, auto-kill the least-recently-used idle-able services.

### 22. Session attach / detach (daemon mode)
**Effort:** L · **Value:** med · **State:** open question

devup runs as a background process owning all the services; `devup attach` connects a TUI to it. Lets the developer close the terminal without killing everything. This is the main feature pm2 has and devup doesn't.

Trade-off: significant complexity (IPC, state serialization, multiple attached UIs). Maybe not worth it for "dev only".

### 23. Unix socket / JSON-RPC control plane
**Effort:** M · **Value:** med · **State:** proposed (depends on #22)

`~/.devup/sock-<project>.sock` exposes commands: `restart <svc>`, `stop <svc>`, `status`, `logs <svc> --tail`. Foundation for IDE plugins, external file-watchers (e.g. tilt-style file watchers), `devup logs` standalone, etc. Useful even without daemon mode.

---

## Track 5 — Production mode (open question)

Items here would push devup into pm2 territory. Decide first whether to scope-creep that way.

### 24. `--prod` mode
**Effort:** L · **Value:** open · **State:** open question

Sans TUI, sans watch, aggressive restart, daemonized. Either devup keeps pure dev focus and ignores this, or commits to being a unified dev+prod tool.

### 25. Cluster mode
**Effort:** L · **Value:** open · **State:** open question

Spawn N instances of the same service with TCP round-robin. pm2's bread and butter. Useful for single-VM deployments. Same scope question as #24.

### 26. Prometheus metrics
**Effort:** M · **Value:** low for dev, high if `--prod` ships · **State:** open question

Expose `/metrics` on a configurable port: restart counter, error counter, request rate per service.

### 27. Crash webhooks
**Effort:** S · **Value:** low for dev, med for prod · **State:** open question

POST to a configured URL when a service exhausts its restart budget. Slack-incoming-webhook shape.

---

## Track 6 — Extensibility

### 28. Plugin system for proxy providers
**Effort:** M · **Value:** med · **State:** proposed

`detect.ts` hardcodes `traefik | nginx | caddy`. Let users register custom providers from their config:

```ts
proxy: {
  provider: 'custom',
  customProvider: () => new MyOwnProvider(),
  ...
}
```

Useful for HAProxy, Envoy, or in-house proxies.

### 29. Custom health-check types
**Effort:** M · **Value:** low-med · **State:** proposed

`healthCheck: { type: 'custom', check: async (svc) => boolean }`. Opens gRPC / GraphQL / SQL ping use cases.

---

## Suggested release cadence

### 0.3.0 — "GuestHub-shaped"

Items that directly improve the daily-use experience for the reference stack. Two evenings of work.

- #1 Profiles
- #9 `preBuild` / `watchBuild`
- #10 `readyPattern`
- #11 `external` hooks

### 0.4.0 — polish + standalone CLI

Once 0.3.0 lands, focus on the rough edges that show up after adoption.

- #2 Pre-flight `--watch-path`
- #3 `--version` / `--help`
- #4 `npm pkg fix`
- #7 Browser open respects TLS
- #8 Crash-loop badge
- #14 CLI standalone (`devup logs`, `devup install`, `devup status`)
- #15 Fuzzy filter in `ServiceList`
- #19 Contextual tips

### 0.5.0 — config power

- #5 Regex search
- #12 `healthCheck.startPeriod`
- #13 Customizable error patterns
- #16 Log-level filter
- #18 Verbose stats
- #21 Resource awareness

### 0.6.0 — control plane

- #20 Hot reload of config
- #23 Unix socket / JSON-RPC

### Future / unresolved

- #6 `extraEnv.PORT` warning (could slot anywhere)
- #17 Active-service color (cosmetic)
- #22 Daemon mode (pending product decision)
- #24, #25, #26, #27 Production-mode items (pending product decision)
- #28, #29 Extensibility (pending demand)

---

## Adding ideas

Open a PR editing this file. New items get a number that doesn't conflict, an effort/value estimate, and at least one paragraph explaining the motivation. Don't graduate to a GitHub Issue until the item has a clear scope and an owner.
