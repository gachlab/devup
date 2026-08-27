# Roadmap

Living list of proposed features for `@gachlab/devup`. This is the source of truth; new ideas go here first and graduate to GitHub Issues / a release milestone when prioritized.

## Status

Last released: **[0.19.1](https://github.com/gachlab/devup/releases/tag/0.19.1)** (2026-08-27) — with `--remote`, an empty local selection is a legitimate configuration and is no longer rejected.

Full history is in [CHANGELOG.md](CHANGELOG.md); this file is only for what is *not* built yet.

The VS Code extension lives in its own repo: **[gachlab/devup-vscode](https://github.com/gachlab/devup-vscode)** (0.11.0 on the Marketplace). It consumes this package's control plane and has its own release cadence.

> **Reconciled 2026-08-21.** Every item below was checked against the source, and 25 of 29 turned out to be shipped while still marked `proposed` — including profiles, hot reload and the control plane itself. Per-item release attribution was not reconstructed; `done` here means *verified present in `src/`*, and the CHANGELOG is authoritative for when. Keep this honest: a roadmap that lists finished work as pending is worse than no roadmap, because it gets believed.

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
**Effort:** S · **Value:** high · **State:** done

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
**Effort:** S · **Value:** med-high · **State:** done

Before spawning, scan `svc.args` for `--watch-path` / `--watch` patterns and validate that each referenced path exists in `cwd`. Stale paths after a rebase cause Node 22 to die with a cryptic message. Report all missing paths up front per service.

### 3. `devup --version` and `devup --help`
**Effort:** S · **Value:** med · **State:** done

Today both arguments fall through and launch the TUI. Standard CLI hygiene.

### 4. `npm pkg fix` cleanup
**Effort:** S · **Value:** low · **State:** done

The publish workflow warned: `"bin[devup]" script name dist/index.js was invalid and removed` (cosmetic — the bin survived). Normalize `bin` and `repository.url` per `npm pkg fix`. Add a `prepack` script that runs it.

### 5. Regex search in logs
**Effort:** S · **Value:** med · **State:** done

`SearchInput` accepts a leading `/` to enable regex mode (mirroring vim). `LogsPanel.isMatch` switches between `.includes` and `RegExp.test`. Invalid regex → fall back to substring with a hint in the search bar.

### 6. Validator warning for `extraEnv.PORT` mismatch
**Effort:** S · **Value:** low · **State:** done

If a service has `extraEnv.PORT` and it doesn't equal `port` (or in lazy mode, `realPort`), emit a warning. Common source of confusion.

### 7. Browser open respects TLS
**Effort:** S · **Value:** med · **State:** done

Today `o` (open in browser) always builds `http://localhost:port`. If `proxy.tls === true` and the service has a route, open `https://<sub>.<domain>` instead. Otherwise fall back to localhost.

### 8. Crash-loop badge
**Effort:** S · **Value:** med · **State:** done

In `StatsPanel`, mark services that have exhausted their auto-restart budget (`restarts >= MAX_RESTARTS` and `status === 'crashed'`) with a distinct color/icon. They are easy to miss in a long list.

---

## Track 2 — Config features (medium effort, high payoff)

### 9. Implement `preBuild` and `watchBuild`
**Effort:** M · **Value:** high · **State:** done

These fields exist in `ServiceConfig` but `ProcessManager.start()` ignores them. GuestHub works around this with `cmd: 'sh', args: ['-c', 'npm run build && (npx tsup --watch &) && node ...']`.

Implementation:
- `preBuild`: run synchronously before the service spawn; if it fails, skip the service and mark it `crashed`.
- `watchBuild`: spawn alongside the service as a sibling child process; pipe its stdout/stderr to the same log tag with a `[build]` prefix.

Both should be visible in the TUI (separate health column or sub-state).

### 10. `readyPattern` per service
**Effort:** M · **Value:** high · **State:** done

Add `readyPattern?: string | RegExp` to `ServiceConfig`. When the pattern matches in a service's stdout, immediately mark `health: 'up'` (and move to the next phase) without waiting for the next 3-second health poll. Vite and ng-serve already print recognizable "ready" lines.

This shaves potentially 3-5 seconds off every phase transition. Especially valuable in `--once` mode for CI.

### 11. `external` / `pre` hooks
**Effort:** M · **Value:** high · **State:** done

A top-level `external?: ExternalService[]` array runs before phase 0. Each entry has `cmd`, `args`, optional `healthCheck`, and an optional `stopCmd`. Typical use: `docker compose up -d` for Mongo/Redis.

devup waits for each external's healthCheck before starting phase 0, and runs `stopCmd` (or just `docker compose down`) on shutdown.

### 12. `healthCheck.startPeriod`
**Effort:** S · **Value:** med · **State:** done

Grace period before the first health probe runs. Useful for Angular (`ng serve` takes 30–60 s on cold start) so failed probes during boot don't pollute `state.errors`.

### 13. Customizable error/warn patterns
**Effort:** S · **Value:** low-med · **State:** done

Today `state.errors++` is incremented per non-empty stderr line. Many libraries write info messages to stderr (Angular CLI does). Allow a per-service `errorPattern?: RegExp` so only matching lines count.

---

## Track 3 — TUI improvements

### 14. CLI standalone commands
**Effort:** M · **Value:** high · **State:** done

Reuse `LogSink` and the orchestrator without launching the TUI:

- `devup logs <svc>` — tail the persisted log file (`~/.devup/logs/<proj>/<svc>.log`).
- `devup logs --follow <svc>` — `tail -f` semantics.
- `devup status` — read live state (via the unix socket from item #24, or by polling health endpoints if devup is running).
- `devup install` — run `npm install` in parallel across every service without booting anything. Useful right after `git clone` or branch switches.

### 15. Fuzzy filter in `ServiceList`
**Effort:** S · **Value:** med · **State:** done

`ServiceList` (used by `f`, `r`, `o`) currently navigates with arrows. Add inline typing that filters the list as you type — sub-second selection for stacks with 30+ services.

### 16. Filter by log level
**Effort:** M · **Value:** med · **State:** done

Detect levels by pattern (`error`, `warn`, `info`, `debug`) and add a TUI binding to toggle visibility. Keep it simple: regex per level, default English keywords, configurable.

### 17. Active-service color in filtered logs panel
**Effort:** S · **Value:** low · **State:** done

When a filter is set, paint the panel border / header in the filtered service's tag color. Subtle reinforcement of context.

### 18. Verbose mode in stats panel
**Effort:** S · **Value:** low · **State:** done

Press `v` in the stats panel to expand the row with `cmd`, fully-resolved `args`, and `extraEnv`. Often you want to confirm "did devup actually pass the flag I expected?" without leaving the TUI.

### 19. Contextual tips
**Effort:** S · **Value:** low · **State:** done

When the logs panel has > 1000 lines and no `searchTerm`, show a dim hint: `tip: press / to search`. Similar nudges for `Tab` (when only logs is focused for a while), `f` (filter), etc. Toggle off via config.

---

## Track 4 — Robustness / operations

### 20. Hot reload of `devup.config.ts`
**Effort:** L · **Value:** med · **State:** done

Watch the config file. On change: reload the config, diff against the running set, and apply (start newly added services, stop removed ones, restart services whose `cmd`/`args`/`extraEnv` changed). Tricky because phases reorder and lazy proxies need to rebind. Probably ships behind `--watch-config`.

### 21. Resource awareness
**Effort:** M · **Value:** med · **State:** done

Add a memory/CPU watchdog: when system RAM > 80%, surface a TUI notice listing the top-N consumers. Optionally, in lazy mode, auto-kill the least-recently-used idle-able services.

### 22. Session attach / detach (daemon mode)
**Effort:** L · **Value:** med · **State:** done

devup runs as a background process owning all the services; `devup attach` connects a TUI to it. Lets the developer close the terminal without killing everything. This is the main feature pm2 has and devup doesn't.

Trade-off: significant complexity (IPC, state serialization, multiple attached UIs). Maybe not worth it for "dev only".

### 23. Unix socket / JSON-RPC control plane
**Effort:** M · **Value:** med · **State:** done

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
**Effort:** M · **Value:** med · **State:** done

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
**Effort:** M · **Value:** low-med · **State:** done

`healthCheck: { type: 'custom', check: async (svc) => boolean }`. Opens gRPC / GraphQL / SQL ping use cases.

---

## Suggested release cadence

### 0.3.0 — "GuestHub-shaped" — ✅ released

- Profiles, `preBuild`/`watchBuild`, `readyPattern`, `external` hooks.

### 0.4.0 — polish + standalone CLI — ✅ released

- Pre-flight `--watch-path`, `--version`/`--help`, `npm pkg fix`, browser TLS, crash-loop badge, `devup logs/install/status`, fuzzy filter, contextual tips.

### 0.5.0 — config power — ✅ released

- Regex search, `healthCheck.startPeriod`, `errorPattern`, log-level filter, verbose stats, resource awareness.

### 0.6.0 — control plane — released as part of 0.7.0

- Hot reload of config, Unix socket / JSON-RPC.

### 0.7.0 — polish tail — ✅ released

- `extraEnv.PORT` warning, active-service border color. Closed the last low-value items of the original roadmap.

### 0.7.1 — internals cleanup

No user-facing changes. Sets the stage for 0.8.0 by splitting the three biggest files into focused units:

- **#52 split `utils.ts`** into `src/utils/*` (one file per concern; façade preserves imports)
- **#51 extract `App.tsx` useEffects** into colocated hooks (`useBootSequence`, `useControlPlane`, `useHotReload`, etc.)
- **#50 split `ProcessManager`** into `Spawner` / `Restarter` / `HealthPoller` / `Lifecycle` units sharing the same `state` Map

Daemon mode (#54) will compose these units directly, without the TUI's `events.onLog` indirection — easier with units than with a god class.

### 0.8.0 — headless devup

The goal: make devup feel like `docker compose` for Node monorepos. A daemon run mode + the plumbing that makes inspection from the daemon possible:

- **#46 control-plane streaming** (`logs.follow`, `status.follow`) — required for real-time `devup logs --follow` against a running daemon and for the 0.9.0 extension's live output channels
- **#47 `devup ctl <method>` subcommand** — dogfooding CLI client that exercises every method; doubles as a reference impl for third-party clients and proves the protocol surface is enough before we build UI on it
- **#54 daemon mode** (`devup up -d` + `devup down`) — the actual "run and forget" experience that devs are asking for. PID file in `~/.devup/<project>.pid`, control plane stays bound, logs persist to disk. Linux + macOS v1; Windows users keep using the TUI

Order: #46 → #47 → #54. Each unblocks the next.

After 0.8.0 the dev workflow looks like:

```bash
devup up -d                    # boots, returns the shell prompt
devup status                   # snapshot
devup logs --follow app-api    # tail in real time
devup ctl restart app-api      # control plane via CLI
devup down                     # clean shutdown
```

The TUI mode (`devup` without `-d`) stays for interactive sessions. The two modes coexist; the daemon is just the headless variant.

### 0.9.0 — VS Code extension MVP

- **#48 VS Code extension** (new repo `gachlab/devup-vscode`) — tree view, status bar, restart/stop/logs commands, per-service output channels. Consumes the headless devup + control plane stabilised in 0.8.0.

The extension is the "GUI rich" alternative for devs who live in VS Code. With 0.8/0.9 done, a dev has three frontends to choose from: TUI (interactive sessions), CLI subcommands (scripting, CI), VS Code extension (editor-integrated). All three speak to the same core via the same control plane.

### Future / unresolved

The original roadmap's "open question" items still live in the issue tracker without a milestone:

- Production-mode items: `--prod`, cluster, Prometheus metrics, crash webhooks (#24, #25, #26, #27 — pending product decision on whether devup pivots to dev+prod)
- Plugin systems: custom proxy providers, custom healthCheck types (#28, #29 — pending demand from external users)

These graduate into a milestone if/when there's a concrete commitment to ship them. **#22 (daemon mode) is no longer here** — it became #54 and was promoted to 0.8.0 once devs asked for it explicitly.

These graduate into a milestone if/when there's a concrete commitment to ship them.

---

## Adding ideas

Open a PR editing this file. New items get a number that doesn't conflict, an effort/value estimate, and at least one paragraph explaining the motivation. Don't graduate to a GitHub Issue until the item has a clear scope and an owner.
