# Changelog

All notable changes to `@gachlab/devup` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`logs.tail` can be asked by time, not just by line count** (#108): `{ "since": 1755800000000 }` over the socket, `devup ctl logs <svc> --since 5m` from the shell — a duration, an ISO timestamp, or epoch milliseconds.

  "The last N lines" is right for looking over a service's shoulder and wrong for the question a test harness has: *what did this service do while the test that just failed was running*. With a line count alone you have to guess how many — too few and you miss the beginning, too many and you drag in the previous test — and a service that recompiles on every save pushes the window out of the tail before you ask for it. The lines have carried an ISO timestamp since LogSink was written; there was just no way to ask by it.

  The result now also carries `oldestRetained`, because the file rotates on every launch and at 10 MB: a window that starts before a rotation has lost its beginning, and a short answer that looks complete is the failure mode worth naming. It reports when the log *starts*, which is a fact — devup cannot tell "rotated away" from "the service had not written yet", and says both rather than picking one. A window read reaches into the rotated `.log.prev` so that one spanning a rotation stays whole; a plain tail does not, since "the last N lines" has always meant the current file.

  The result also carries `truncated`, because `lines` still caps a window and the cap keeps the most *recent* — so what a window loses is its **beginning**, and a full-looking answer is exactly what a truncated one looks like. Counting the lines that came back cannot tell; the daemon can, because it did the dropping.

  The reader is now **one** implementation. It was written twice — once in the daemon, once in the TUI's control plane — so a feature added to one silently missed the other, and `--since` would have worked against `devup up -d` and done nothing against the TUI.

- **`logs.tail` no longer serialises the whole file for a malformed `lines`.** It was coerced with `Number()`, so `"abc"` became `NaN`, the clamp stayed `NaN`, the reader's cap was never true, and the daemon sent back up to 10 MB. It must be a positive integer now, like `since` must be a number.

- **`info` says what the daemon is** (#107): its `version`, a `contract` number, and the `methods` it answers.

  Every recent release changed what the control plane can do — `originalPort` in 0.12.0, `removed`/`debugPort`/`cpuPercent` in 0.14.0, `brk` in 0.15.0, `crashes` here — and no client could ask. So they sniffed: the VS Code extension decided whether to offer the debugger by looking for `debugPort` in the snapshot, and found out `--inspect-brk` was unavailable when the RPC answered `unknown method`. That turns every "requires ≥ X" into an inference and every error message into a guess.

  `contract` is the field to check, not `version`: it answers "can I trust this field" directly, where the release number makes every client keep its own table of what arrived when — and those tables are what go stale. `methods` is derived from the dispatch table, so a method added without being advertised is not possible; the streaming pair, handled before dispatch, is named explicitly. All three are composed by the server rather than by the `RpcContext` behind it, so the daemon and the TUI — which implement `getInfo` separately and have drifted before — cannot disagree.

  Additive: older clients ignore them, and their **absence** is the answer when what you are asking is how old a daemon is — give it its own branch, because `!info.methods?.includes('debug')` reads as `true` for a 0.15 daemon that debugs perfectly well.

- **`devup exec -- <cmd>`** (#106) — the mode between `--once` and `up -d`. Boots the stack if it is not already up, waits until it is ready, runs the command against it, and stops **only what it started**, whatever the command did.

  The three hard parts all need something a shell script does not have. *Reuse or boot*: `up -d` refuses when a daemon is already running, which is the right failure for it and leaves every harness parsing that message to decide — here an existing daemon is used and left alone, and only one this invocation started gets stopped. *Teardown on the error path*: a bash `trap` is forgotten, or it kills the stack the developer already had open. *`--fail-on-crash`*: whether a service died **while the command ran** has to be photographed at both ends, and only the daemon has the counters — without it a suite goes green while an API throws on every request.

  Also `--start` (warm the idle lazy services first, in phase order) and `--wait-timeout`. Everything after `--` is the command, untouched: `devup exec -- npx playwright test --timeout 30` would otherwise have set devup's own lazy idle timeout to 30 minutes. If the running daemon was started with a different set of services, `exec` refuses rather than narrowing to the intersection — a green suite that never exercised half the stack is worse than a clear failure.

- **`devup ctl wait [svc...]`** (#105) — block until services are ready; `0` when they are, `1` naming the ones that did not make it. With `--profile`, `--start`, `--timeout` and `--json`.

  What it knows that a hand-written polling loop does not: a lazy service that is **`idle` is ready, not down** — its proxy holds the configured port, so the stack serves and the first request just pays the start, and probing that port to decide is a false positive because the proxy answers either way. `--start` pays that cost up front instead, in phase order, which is what a suite with a ten-second action timeout actually wants. A service in `timeout` fails the wait immediately rather than burning the clock: the health poller skips that status outright, so it cannot leave it on its own.

  The same logic is importable as `waitForServices` from `@gachlab/devup/client`, so a Node harness does not have to shell out for it.

- **`@gachlab/devup/client`** (#104) — the control-plane client the CLI already used, now importable. `createClient(socketPath)` gives a typed handle with one method per RPC (`status`, `logsTail`, `debug`, `followStatus`, …) plus `call()` for anything newer than your copy; `sendRpc` / `openStream` remain available raw. The snapshot types (`ServiceSnapshot`, `StatusResult`, `ProxyInfo`, `StatsResult`, …) ship with it, so a consumer no longer re-declares the wire shape by hand — which is what shipped a broken release of the VS Code extension once, and is trap 4 in `CLAUDE.md`.

  `serializeState` is now typed as returning `ServiceSnapshot` rather than `Record<string, unknown>`, so a field renamed there stops compiling instead of surfacing in a client weeks later.

  Two behaviours worth knowing before scripting against it: a one-shot call has **no timeout** by default (`restart` and `debug` restart a service, and a slow pre-build is not a dead daemon — pass `timeoutMs` where it matters), and a throw from a stream's `onFrame` is still not caught. Both are documented in [the control plane docs](docs/control-plane.md#from-node).

### Changed
- **`--once` waits for web services too** (#105), and its default timeout went from 90 s to 120 s because of it.

  It used to wait only for `type: 'api'`, so it handed back control while the front end was still compiling — and the caller then had to wait again, which is the one thing `--once` exists to spare them. It now picks the signal that is honest for each service: a **web with a `readyPattern`** is ready when a line matches it, and its port is ignored (`ng serve` opens the port long before the bundle exists, so the port says ready while a browser gets nothing); an **API** is ready when its port answers, the same bar the daemon uses at boot. A web with no `readyPattern` has nothing better than its port — and the failure message now says so, because the fix is a pattern in the config, not a longer timeout.

  **This can fail a build that passed before**, and that is the point: it was passing on a front end that was not serving yet. Raising `--once-timeout` is the usual answer for a slow cold start.

### Fixed
- **The control plane no longer answers for `Object.prototype`.** Converting the dispatch `switch` into a lookup table (for `info.methods`, above) made a plain object the router, and a plain object answers for its prototype: `{"method":"toString"}` came back `"[object Undefined]"`, `"constructor"` echoed the request's params, and neither is a method the daemon advertises. The method name arrives off the wire, so the table is a `Map` — a shape where this cannot happen, rather than a guard someone has to remember.
- **A `readyPattern` is no longer overruled by a port probe**  <!-- keep first: it is the load-bearing one --> — the fix that makes `ctl wait`, `devup exec` and the TUI agree with reality. `HealthPoller` probed every service the same way and promoted it to `up` the moment its port answered, so a web that declares `readyPattern: 'compiled successfully'` was marked ready by `ng serve` opening :4200 seconds before the bundle existed. Everything reading `health` believed it. A service that has said how it announces itself now gets the startup window to itself; once the startup timer has given up, a live port is accepted again, so a pattern with a typo cannot keep a working service down for ever.

  The window is keyed on `health`, not on `status === 'starting'` — boot flips every web to `running` the moment it is spawned and the poller only starts afterwards, so a status-based guard would never have fired for the very services it was written for.
- **`status: 'timeout'` is no longer a state nothing comes back from.** The health poller skipped it outright, so a service that started slowly and then served perfectly well stayed marked down for the rest of the session. It is probed like any other now, and promoted to `running` when it answers. (This is the wart the 0.15.0 notes worked around for `--inspect-brk`; it is fixed at the source now.)
- **`crashes`, a monotonic crash counter, joins the status snapshot.** `restarts` looks like the way to ask "did anything die while my command ran?" and is not: it is a *budget*, and both `Restarter.restart` and `startService` reset it to 0 — so a suite whose own setup called `devup ctl restart` hid every crash that followed it from `--fail-on-crash`.
- **An RPC no longer hangs for ever when the daemon dies mid-request.** `sendRpc` waited on a response line that a killed daemon never sends, with nothing watching the socket close. It rejects now — the failure mode a test harness can least afford.
- **A stream no longer reports the same failure twice.** `openStream` listened for `'error'` on both the socket and the readline interface, and readline re-forwards its input's errors — so one `ECONNREFUSED` called `onError` twice, and a consumer that reconnects from it doubled its connections on every retry.
- **A stream now reports an error the daemon sends *after* the ack.** `logs.follow` is acknowledged before the log file is read, so a failure in that read answers with an error frame and never registers the watcher — the stream was dead, and a client looking only for `event` frames dropped the message and waited for ever on a socket that would never speak again.
- **A stream now says when the daemon goes away.** `devup down` destroys its clients, and over a Unix socket that is a clean EOF: no error fired, nothing was called, and a long-lived consumer went quietly stale across a daemon restart. `openStream` takes an `onClose` — not called for a stream you aborted yourself, or the caller replacing its subscription would tear down the replacement.

## [0.15.0] — 2026-08-22

Depurar de verdad: romper en la primera línea, y que nada del daemon se lleve por delante un proceso vivo mientras estás parado en un breakpoint.

### Added
- **`debug: { brk: true }`** — start a service with `--inspect-brk`, stopped before its first line, so its startup path can be debugged instead of everything that happens after it. Available in config and through the `debug` RPC (`"brk": true`). `debug` now also accepts an object form, `{ port?, brk? }`; `true` and `<port>` keep working unchanged.

  **Tres** timeouts tuvieron que aprender de esto, y los tres eran fallos silenciosos: un servicio detenido en su primera línea no abre su puerto hasta que alguien se acopla, así que (1) el `startupTimeout` de 45 s lo dejaba en `timeout`, estado del que el health poller ya no lo saca nunca; (2) el arranque bajo demanda de lazy se rendía a los 45 s y destruía las conexiones en cola; y (3) `startService` esperaba el puerto otros 45 s y devolvía fallo, con lo que el propio RPC `debug` deshacía el flag y contestaba "no volvió a levantar" — sobre un proceso que estaba corriendo, suspendido, exactamente como se le pidió. Ese tercero hacía la función inservible justo para los servicios `type: 'api'`, que son su público.

  También: `devup ctl debug <svc> --brk`.

### Fixed
- **`debugPort` ya no se queda obsoleto con `node --watch`** (#100). `captureDebugPort` descartaba cualquier banner posterior al primero, lo cual vale mientras un proceso equivalga a un inspector — y no es el caso con `node --watch`, donde el reinicio ocurre *dentro* de node: el hijo que devup vigila no se cierra, nada limpia el puerto, y el proceso reiniciado anuncia uno nuevo que se descartaba. A partir del primer rebuild, el snapshot apuntaba a un inspector muerto el resto de la sesión, y un cliente que lo leyera —la extensión de VS Code lo hace para acoplarse— no tenía forma de saberlo.
- **El reaper de inactividad ya no para un servicio que está bajo el inspector** (#95). Un servicio pausado en un breakpoint no recibe tráfico por definición, así que el modo lazy lo apagaba a los diez minutos y se llevaba por delante la sesión de depuración. Ojo al alcance: esto **fija** el servicio arriba hasta que se apague el flag de debug — el inspector de Node sigue escuchando tras un desacople, así que no hay señal de "ya nadie me depura". Documentado en [lazy mode](docs/lazy-mode.md).
- **Un puerto ocupado por el propio proceso del servicio ya no se reporta como crash** (#96). `Spawner.start` no distinguía "otro programa tiene mi puerto" de "mi proceso, que sigue vivo, lo tiene", y el segundo caso era peor que no hacer nada: registrar el crash reemplazaba el estado por uno con `proc: null`, y a partir de ahí `lifecycle.stop` salía temprano para siempre — el proceso se quedaba con el puerto, imparable, el resto de la sesión. Un stop en curso también cuenta como vivo (`stop()` sólo manda SIGTERM), así que ahora se espera a que drene en vez de declararlo caído.

## [0.14.0] — 2026-08-22

### Fixed

- **Hot reload no longer restarts every lazy service on every save** (#93). `applyConfigChange` diffed the *live* config against the file, but a lazy service's live config carries the port rewrite — `13002` in state against `3002` in the file — so it could never compare equal. Every save stopped and restarted every lazy service, each with an 800 ms pause, **and restarted it from the file config**: onto the public port its own proxy was already holding, while `onDemandStart` polled the internal port for 45 s and the next request hung.

  The reload now diffs file against file, with the last loaded config as the baseline. A runtime `devup ctl debug` toggle is carried over, since it lives on the service rather than in the file; the file wins when it says something.

### Added

- **Debugging** (#84), both declared and on demand.

  Per service in the config: `debug: true` runs it under `--inspect`, or `debug: 9230` to pin the port. Only meaningful for `cmd: 'node'`, and the validator says so rather than letting the flag be swallowed as a script argument.

  On demand through the control plane: `devup ctl debug <svc>` (and `--off`, `--port n`) restarts a service under the inspector without editing the config. The flag lives on the service, so it survives the crash and auto-restart that usually prompt a debugging session.

  The lazy path needed a fix of its own: the on-demand start closed over the config captured at boot, so a runtime toggle set the flag and then had it overwritten — the feature was a silent no-op for exactly the services most worth debugging. It reads the live config now. `debug` also joins the respawn-relevant fields, so changing it under `--watch-config` actually restarts the service.

  **`debug: true` uses `--inspect=0`**, letting the OS pick: the fixed 9229 collides the moment two services are debugged at once. The port Node actually chose is parsed from its startup line and reported as `debugPort` in the status snapshot, so a client can attach without guessing — which is what the VS Code extension needs to offer "attach debugger".

- **`start` in the control plane** (#85), with `devup ctl start <svc>` alongside it. `restart` and `stop` existed with no way to bring one stopped service up; `restart` happened to work, which was a coincidence rather than an interface.

  The policy lives in one place (`startService`) rather than being duplicated between the daemon and the TUI, so `devup` foreground and `devup up -d` cannot drift on what the same command means.

  A first attempt was pulled from #88 because it did not work: it guarded with `if (st.pid) return`, and a stopped service keeps a dead `pid`, so it was a permanent no-op for the one case it existed for. Liveness is now read from the child process. It also spawned lazy services directly, leaving the proxy's readiness flags false so the next request started a second process — `LazyProxy` gained `ensureStarted()`, which shares a single start between concurrent callers, and `start` routes through it.

- **A contract fixture for the `status` wire shape** (#87). `contract/status-snapshot.json` is generated from `serializeState` itself and ships with the package, covering an always-on service and a lazy one so the `port` / `originalPort` distinction is pinned rather than described in prose.

  The shape is written down twice — here, and by hand in the VS Code extension, which deliberately has no runtime dependency on this package. Nothing kept the two honest: `docs/control-plane.md` described `port` as "from config", the extension believed it, and shipped a release connecting to the wrong port. Renaming a field now fails a golden test here, and clients can assert against the fixture instead of trusting the documentation:

  ```js
  import golden from '@gachlab/devup/contract/status-snapshot.json' with { type: 'json' };
  ```

  Regenerate deliberately with `UPDATE_CONTRACT=1 npm run test:unit` and treat the diff as an API change.

## [0.13.0] — 2026-08-21

Control-plane gaps found while building the VS Code extension against it. All additive.

### Added

- **`removed` frames on `status.follow`** (#82) — the stream only ever carried additions and updates, so a service dropped by a `--watch-config` reload stayed in every client until it reconnected. `ProcessManager.remove()` now stops the service, drops it from the state map and announces it; `config-watcher` uses it instead of deleting from `state` behind the manager's back.
- **Host CPU in `stats`** (#83) — `system` carries `loadAvg1` and `cpuPercent` (load as a share of `cpuCores`, so it compares across machines). Both are **omitted on Windows**, where `os.loadavg()` is hardcoded to `[0, 0, 0]` and a zero would render as an idle machine. Clients previously had no CPU figure at all, and at least one filled the gap with a memory percentage.

### Fixed

- **A manual restart cancels the queued auto-restart.** `restart()` never cleared a pending backoff timer, so a crash followed by `devup ctl restart api` spawned a second process ~2 s later: the first was overwritten in `state` but stayed in `procs`, leaving two processes fighting over the port behind a single row. Pre-existing; fixable now that timers are tracked.
- **`logs.follow` replay frames carry `svc`.** Only the live subscription set it, so a client routing by `frame.svc` dropped or misattributed the whole replayed tail on every follow.

- **Removal now releases what the service owned.** `remove()` dropped the state entry and left everything else running, so a removed service could come back three different ways:
  - the **lazy proxy kept listening on the public port**, and one connection re-entered the on-demand start path;
  - a **queued auto-restart** fired its 2/4/8 s timer and `spawner.start` re-inserted the service into the state map, leaving the daemon running a process no longer in the config;
  - a **health probe still in flight** wrote its result afterwards, pushing a `status` frame *after* the `removed` one.

  A fourth and fifth surfaced on review: a start already **in flight** when the removal landed (`Spawner.start` awaits the port check and the pre-build, and `Restarter.restart` settles 1500 ms before spawning), and a state change emitted **after** the removal — buffered stdout matching `readyPattern` flushing between the kill and `close` would push a `status` frame after `removed`. The emission is now guarded at the point every consumer shares, rather than one caller at a time.

  All five are closed, and the lazy proxy is torn down *before* the announcement rather than after. The `HealthPoller` failure streak and the per-name CPU baseline are also cleared — the streak would be inherited by a service re-added under the same name and could trip the threshold on its first probe, and the stale CPU baseline made the next `stats` sample report a large negative percentage.
- **`status.follow` now sends its initial snapshot even when empty** — previously suppressed, leaving a client unable to tell "connected, nothing configured" from "still waiting".
- **`devup ctl status --follow` no longer goes silent on a removal.** The new `removed` frames carry names, not service rows, and the handler read `.name` off a string. The resulting `TypeError` was swallowed by the client's frame loop, so the CLI printed nothing further and kept listing the departed service — the exact failure the new event was added to prevent.
- **The stream client no longer swallows consumer errors.** Its `try/catch` wrapped both `JSON.parse` and the `onFrame` callback, so a bug in a frame handler was indistinguishable from a malformed frame. Only the parse is guarded now.

### Documentation

- `docs/control-plane.md` claimed **"No notifications (server-pushed events)"** and pointed readers at `tail -f`. `status.follow` and `logs.follow` have existed since 0.8.0. Both are now documented, along with `stats`, which had never been written up at all.

## [0.12.0] — 2026-08-21

### Added

- **`originalPort` in the `status` snapshot.** For a lazy service, `port` is the *rewritten* port: `rewriteServicePort` moves the service to `port + 10000` and keeps devup's on-demand proxy on the configured one. Clients only ever saw the rewritten value, and nothing in the snapshot let them recover the configured port — which is where the proxy listens, and what applications are actually configured to call. Always-on services are never rewritten, so the two fields agree for them.

  This is not cosmetic: the VS Code extension's remote port forwarding tunnelled `13002` instead of `3002`, reaching the service directly, bypassing the proxy that starts it, and missing the port the frontend calls. Deriving the configured port by subtracting the offset is not safe — lazy mode is opt-in, so in a non-lazy stack a service legitimately configured on `18080` would be misread as `8080`. Only the daemon knows which services were rewritten, so only the daemon can answer.

## [0.11.2] — 2026-06-06

### Fixed

- **`maxMem` now reliably caps the Node.js heap even when the host shell already has `NODE_OPTIONS=--max-old-space-size=<N>` set.** The previous guard compared against the fully-merged env (base + `extraEnv`), so any system-level value (e.g. from nvm, a global `.bashrc`, or a prior devup run) silently blocked the injection and the configured limit was never applied. The guard now compares against `svc.extraEnv` only — `maxMem` always overrides the system env. The sole exception is when the user explicitly places `--max-old-space-size` in `extraEnv`, which still takes precedence as intended. When overriding an existing flag, the value is replaced via regex rather than appended, avoiding duplicate flags.

## [0.9.3] — 2026-05-22

Critical hotfix for `devup down` against the VS Code extension.

### Fixed
- **`devup down` no longer gets SIGKILL'd because the control-plane socket hangs on streaming clients.** The control-plane server's `close()` awaited every client to disconnect on its own, but long-lived streaming subscriptions (`status.follow`, `logs.follow` — exactly what the VS Code extension uses) never close until the daemon tells them to. Result: `devup down` waited the full 10 s grace, then SIGKILL'd the daemon. SIGKILL skips the cleanup handler → all spawned services orphaned to init, ports left busy, next `devup up -d` hits EADDRINUSE on every port. Fix: track every active client socket and `destroy()` them before awaiting `server.close()`. Clean shutdowns now complete in milliseconds even with the extension connected.
- **Pre-boot port-conflict scan now covers web services too.** They were skipped on the assumption that dev servers handle retry themselves, but in daemon mode the user wants devup to own the configured ports — same as APIs. If a web port is held by a stray Vite/ng-serve from a previous run, the scan now flags it and offers to take it over.

### Added
- New unit test asserts `socket.close()` completes in under 2 s with an active `logs.follow` subscription.

## [0.9.2] — 2026-05-22

Critical hotfix. **All 0.9.x users should upgrade immediately.**

### Fixed
- **Bundle's top-level `main()` would fire when devup was imported as a library.** When a user's `devup.config.ts` did `import { defineConfig } from '@gachlab/devup'`, Node loaded our compiled `dist/index.js` to satisfy the import — and the bundle's top-level `main()` invocation ran, starting a SECOND, concurrent devup process. Symptoms: every line of output duplicated, three or more racing instances of the same service spawning in milliseconds, ports clobbered, the daemon's socket created but never bound, `devup ctl ping` ECONNREFUSED. Fix: guard `main()` with a `realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)` check so it only fires when the script is invoked directly (as the `devup` binary), not when imported.
- **`devup ctl` crashed with an unhandled `error` event on ECONNREFUSED.** The socket-error handler was attached to the connection but Node's `readline.createInterface` re-forwarded the error through its own emitter, which had no listener, so the process crashed instead of reporting cleanly. Now we attach the handler on both the socket and the readline interface.

### Why this matters
Every devup invocation that loaded a config file (i.e. everything except `--version` / `--help`) was silently running two instances of itself. That is the root cause of every weird behaviour reported against 0.9.0 / 0.9.1: duplicated prompts, daemons that "die" right after starting, sockets that exist but refuse connections, port-takeover prompts firing for ports the user expected devup to own.

## [0.9.1] — 2026-05-22

Hotfix for two issues reported moments after 0.9.0 hit:

### Fixed
- **The y/N prompt no longer no-ops silently.** The conflict list would print, then the process would just continue without waiting for input on some terminals (IDE integrated terminals, multiplexers, custom shells where `process.stdin.isTTY` is misreported). Replaced `readline.question` with direct stdin handling. TTY detection now also accepts stderr / stdout being a TTY when stdin isn't — covers more real environments.
- **Daemon-already-running guard moved before the port scan.** Running `devup` (TUI) or `devup up -d` while a daemon was already up for the same project caused the scan to list the daemon's own services as conflicts, prompt the user to kill them, restart them (because the daemon's auto-restarter kicked in), then bail with "daemon already running". Now the daemon check runs first and short-circuits cleanly — no churn, single clear error.

## [0.9.0] — 2026-05-22

Pre-boot port-conflict resolution. When devup detects another process already holding a port it needs, it now offers to take it over instead of silently marking the service as crashed.

### Added
- **Pre-boot port conflict scan.** Before mounting the TUI or starting the daemon, devup checks every API-typed service's port. Any conflict is shown to the user with the PID and process name (via `lsof`):
  ```
  ⚠ Port conflicts detected on the following services:

    :3002   authorization-api  pid=12345  process=node
    :3013   files-api          pid=99999  process=docker-proxy

  Kill these processes and continue? [y/N]:
  ```
  Three flavours of resolution:
  - **Interactive TTY** → y/N prompt (default).
  - **`--kill-port-conflicts` flag** → auto-kill, no prompt. Required for `devup up -d`, `--once`, and any non-TTY context (CI).
  - **Non-interactive without the flag** → fail fast with the conflict list as instructions.
- **`devup up -d` runs the scan in the parent** before forking the daemon child, so the user gets the prompt (or the error) in their terminal, not buried in `~/.devup/<project>.boot-error`.

### Internals
- New `src/process/port-conflicts.ts` houses the scan, the lsof-based holder lookup (`findPortHolder`), the resolution flow (`resolvePortConflicts`), and the SIGTERM-then-SIGKILL helper (`killHolder`). Linux + macOS only — Windows holder detection (netstat / Get-NetTCPConnection) is deferred until daemon mode itself supports Windows.
- Test suite: 372 → 384 (+12). New: 4 scan tests, 2 killHolder tests, 4 resolution-flow tests, 1 CLI flag test, 1 lsof-output parser test.

### Notes
- Webs are intentionally skipped from the scan — their dev servers (Vite, Angular CLI, etc.) often handle port reuse themselves, and the user's editor / preview tabs hold web ports far more often than stale dev processes do.

## [0.8.1] — 2026-05-22

Patch focused on two real-world footguns surfaced as soon as 0.8.0 hit users.

### Fixed
- **Spawner port pre-flight was unreliable.** The check used `checkPort` — a connect-based test designed for health checks — which can miss bindings (e.g. a server bound but not yet accepting connections, or listening on a different address family). When the check missed, the service crashed with a raw `EADDRINUSE` Node stack trace dumped to the logs panel. Replaced with `isPortBindable()` — a bind-based test using `net.createServer().listen()` — which catches every case that would actually conflict.
- **Pre-flight failures now record a crashed state.** Previously the spawner returned silently when the port was occupied, leaving no entry in the services list. Now the failed service appears in the stats panel as `crashed` with the `⚠ port N already in use` line in its log, matching the behaviour of other pre-flight failures.

### Added
- **TUI refuses to start when a daemon is already running for the project.** Running `devup` (TUI) on top of `devup up -d` would race for the same ports — every API would fail with EADDRINUSE. The TUI now detects the PID file before mounting Ink and exits with a clear pointer to `devup down` and the `devup ctl` family.

### Internals
- New public `isPortBindable(port, host?)` in `src/process/health.ts`. `checkPort` keeps its connect-based semantics for health checks and `waitForPort`. Three new tests cover free / occupied / bound-but-not-accepting cases.

## [0.8.0] — 2026-05-22

**Headless devup.** The control plane grows up: streaming events, a CLI client that speaks it end-to-end, and the long-requested daemon mode so the stack can be left running while you keep working in the same terminal — `docker compose up -d` for Node monorepos.

### Added
- **Streaming control plane** (#46). Two new RPC methods over the existing Unix socket:
  - `logs.follow { svc, tail? }` — ack, then a replay of the last N tail lines (default 50), then live newline-delimited frames until the socket closes.
  - `status.follow` — ack, then a full snapshot, then deltas as services transition.
  Subscriptions auto-clean on socket close; no explicit unfollow needed. Backed by a small typed `Broadcaster<T>` pub-sub fed from `ProcessManagerEvents.onLog` / `onStateChange`.
- **`devup ctl <method>` CLI client** (#47). Lightweight reference client that exercises every control-plane method, doubles as a useful tool on its own:
  - `devup ctl ping` — liveness check
  - `devup ctl status [--follow]` — snapshot or live stream
  - `devup ctl logs <svc> [--follow]` — tail (last 100) or follow live stream
  - `devup ctl restart <svc>` / `devup ctl stop <svc>` — write operations
  Friendly error when the daemon isn't running. Streaming variants abort on SIGINT.
- **Daemon mode** (#54). `devup up -d` (also `--detach`) boots the stack and returns the terminal immediately, leaving services running until explicitly stopped:
  - Double-forks via `spawn({ detached: true, stdio: 'ignore' })` so the daemon survives terminal close. The parent waits up to 90s for the child to write `~/.devup/<project>.pid` (success signal) or `~/.devup/<project>.boot-error` (failure).
  - Headless: no Ink/TUI mounted in the daemon process. **Feature parity with the TUI**: same `ProcessManager`, `LogSink`, control plane, lazy proxies, externals, proxy-config sync, and `--watch-config` hot-reload — minus the React layer.
  - `devup down` reads the PID file, sends SIGTERM with a 10-second grace window, falls back to SIGKILL, and cleans up the PID + socket files. Reports stale PID files clearly.
  - One daemon per project; trying `devup up -d` while one is running prints the existing PID and exits 1.
  - Not yet supported on Windows; clear error directs users to the TUI.

### Internals
- New `src/orchestrator/config-watcher.ts` extracts the diff/apply logic from `useHotReload` into a pure `applyConfigChange()` + an fs.watch wrapper `watchConfig()`. Both the TUI hook and the daemon now share this code path.

### Notes
- Test suite: 338 → 369 (+31). New: 3 streaming, 8 `ctl`, 10 daemon unit, 3 daemon E2E (boot + clean shutdown, hot-reload, "already running" guard), 6 config-watcher tests, plus 1 fix to existing config tests.

## [0.7.1] — 2026-05-22

Internals cleanup. No user-facing changes; safe drop-in upgrade from 0.7.0.

### Internals
- **Split `utils.ts` into focused modules** (#52). The old junk-drawer became `src/utils/*` with one file per concern: `env`, `format`, `search`, `redact`, `install-stamp`, `process-args`, `stats`, `phases`, `colors`. `src/utils.ts` survives as a re-export façade so existing imports keep working.
- **Extract `App.tsx` useEffects into focused hooks** (#51). Six effects (terminal size, control plane, hot reload, log pause, contextual tips, boot sequence) moved into colocated hooks in `src/tui/hooks/`. `App.tsx` shrank from 397 to 150 lines (-62%); each hook ≤ 144 lines.
- **Split `ProcessManager` into Spawner / Restarter / HealthPoller / Lifecycle** (#50). All four share the same `state` Map and `procs` Set via constructor injection. Public API unchanged. `manager.ts` shrank from 361 to 91 lines (-75%); spawn pipeline isolated in `Spawner`; auto-restart backoff isolated in `Restarter`; cleanup + kill-tree in `Lifecycle`; health polling + grace window in `HealthPoller`.

Test count: 331 → 338. Build clean. Every public call site (TUI, control plane, runOnce, subcommands) keeps working unchanged.

## [0.7.0] — 2026-05-21

Polish release. Two small quality-of-life items that closed out the low-value tail of the roadmap.

### Added
- **Non-blocking config warnings** (#9). Devup now emits warnings — separate from errors — at config-load time. The first warning: `extraEnv.PORT` set to a value different from `svc.port`. That's a common footgun (the service binds to the value in `extraEnv`, devup health-checks `port`, nothing connects). Warnings are advisory: they print and the boot continues. Errors still abort as before. New helpers `collectWarnings()` / `formatValidationWarnings()` parallel to the existing `validateConfig` flow.
- **Active-service color on the LogsPanel border** (#20). When a service filter is active and the Logs panel is not focused, the border takes the filtered service's tag color. Subtle reinforcement of "you're seeing only this service", especially helpful after `Tab`'ing between panels. Focus (cyan) still wins so the active-pane affordance is never lost.

### Internals
- New pure helper `resolveBorder()` exported from `tui/LogsPanel.tsx` for testability.
- Test suite grown to ~331 (+10).

## [0.6.0] — 2026-05-21

Control plane release. Two features that unlock external integrations and editor workflows.

### Added
- **Unix-socket control plane** (#26). devup now binds a JSON-RPC server to `~/.devup/sock-<project>.sock` with `chmod 0600`. Speaks newline-delimited JSON. Methods: `ping` (liveness), `status` (full snapshot of every service), `restart { svc }`, `stop { svc }`, `logs.tail { svc, lines? }` (capped at 10 000). Auth is filesystem-perms-only — strictly local; TCP exposure intentionally out of scope. Designed as the foundation for `devup logs --follow` against a running instance, IDE plugins, and future hot-reload coordination. If `listen()` fails (perms, dir missing) devup keeps running without the control plane and logs a single notice.
- **Hot reload of `devup.config.*`** (#23). Opt-in via `--watch-config`. devup watches the resolved config file and applies add/remove/restart at the service level when it changes — no need to kill the TUI. Validation runs first; a failed config leaves the running set untouched. The diff classifies each service as added / removed / changed / unchanged (changed = any spawn-relevant field differs). Banner via the logs panel summarises each reload: `🔁 config reloaded: +1 added, -2 removed, ~1 changed`. 250 ms debounce because editors emit several change events per save; in-flight guard coalesces back-to-back saves.

### Changed
- README "Features" section reorganised into Orchestration / Readiness / TUI / Operations and brought up to date with everything added since 0.2.0 — every feature now has a one-line entry in the header.

### Internals
- New module `src/control-plane/socket-server.ts` exposing `startSocketServer()` / `defaultSocketPath()` (pure helpers + `RpcContext` interface).
- New module `src/config/diff.ts` exposing `diffServices()` and `summariseDiff()` (pure functions, no side effects).
- Test suite grown to ~321 (+22). New suites: `socket-server` (9), `diff` (11).

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

[0.7.1]: https://github.com/gachlab/devup/releases/tag/0.7.1
[0.7.0]: https://github.com/gachlab/devup/releases/tag/0.7.0
[0.6.0]: https://github.com/gachlab/devup/releases/tag/0.6.0
[0.5.0]: https://github.com/gachlab/devup/releases/tag/0.5.0
[0.4.0]: https://github.com/gachlab/devup/releases/tag/0.4.0
[0.3.0]: https://github.com/gachlab/devup/releases/tag/0.3.0
[0.2.0]: https://github.com/gachlab/devup/releases/tag/0.2.0
[0.1.1]: https://github.com/gachlab/devup/releases/tag/0.1.1
[0.1.0]: https://github.com/gachlab/devup/releases/tag/0.1.0
