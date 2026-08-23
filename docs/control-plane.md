# Control plane

devup exposes a local JSON-RPC server over a Unix-domain socket. It's the foundation for IDE plugins, custom shells, and anything that wants to programmatically poke at a running devup instance.

> **Scope**: strictly local. The socket is bound to the user's home directory with `chmod 0600`. There is no TCP exposure, no remote auth, no remote management. By design.

## Socket location

```
~/.devup/sock-<project-name>.sock
```

The project name is sanitised (`/`, spaces, etc. replaced with `_`). The socket is created when devup boots and deleted when devup exits cleanly. A stale socket left by a crashed previous run is removed before the new server binds.

If `listen()` fails (perms, missing parent directory, port-already-in-use on the inode), devup logs a single warning and keeps running without the control plane.

## Protocol

Newline-delimited JSON. One JSON object per line, both for requests and responses.

**Request:**
```json
{ "id": <anything>, "method": "<name>", "params": <object> }
```

`id` is optional but echoed in the response — use it to correlate concurrent requests.

**Response:**
```json
{ "id": <same as request>, "result": <object> }
```

or

```json
{ "id": <same>, "error": { "code": <number>, "message": "<string>" } }
```

Error codes follow JSON-RPC conventions:

- `-32700` — parse error (malformed JSON)
- `-32600` — invalid request (missing `method`)
- `-32603` — internal error (method threw)

## Methods

### `ping`

Liveness check. Returns the server's local timestamp.

```json
{ "id": 1, "method": "ping" }
→ { "id": 1, "result": { "ok": true, "ts": 1716279183421 } }
```

### `status`

Snapshot of every service.

```json
{ "method": "status" }
→ {
    "result": {
      "services": [
        {
          "name": "app-api",
          "status": "running",
          "health": "up",
          "port": 13000,
          "originalPort": 3000,
          "type": "api",
          "phase": 1,
          "cmd": "node",
          "cwd": "app/api",
          "errors": 0,
          "restarts": 0,
          "crashes": 0,
          "pid": 12345,
          "startedAt": 1716279183421,
          "crashLog": null
        },
        ...
      ],
      "proxy": { "active": true, "provider": "traefik", "domain": "guesthub.test",
                 "tls": true, "routes": { "app-web": "" } }
    }
  }
```

`proxy` is `null` when no proxy is running. Note that `status.follow` frames
carry the **bare array** as `data`, not this wrapper.

Fields per service mirror `ProcessState`:

- `name`: from config
- `status`: `starting` | `running` | `stopped` | `crashed` | `idle` | `timeout`
- `health`: `up` | `down` | `wait` | `idle`
- `port`: where the **service process** listens. For a lazy service this is *not* the configured port — devup runs it on `port + 10000` and keeps its on-demand proxy on the configured one. Use this to attach a debugger or read the service's own logs.
- `originalPort`: the **configured** port, and the one to connect to — it is where the lazy proxy listens, so reaching it starts the service on demand. Equal to `port` for always-on services and whenever lazy mode is off. Added in 0.12.0; absent in earlier daemons.
- `type`: `api` | `web`
- `phase`: boot phase from config
- `cmd`, `cwd`: as resolved for the spawn — `cwd` is relative to the project root
- `errors`: cumulative since spawn
- `restarts`: the **auto-restart budget spent**, not a history — every manual
  `restart` and every explicit `start` resets it to 0. Do not use it to ask
  whether something died between two moments
- `crashes`: how many times the service has crashed since the daemon started.
  Only ever goes up, which is what makes it usable as a window signal — this is
  what `devup exec --fail-on-crash` compares. Added in 0.16.0
- `pid`: OS pid, `null` if not currently running
- `startedAt`: epoch ms of the current spawn, `null` if not running. Nulled together with `pid`, so it is not a liveness signal of its own
- `crashLog`: `string[]` of the last stderr lines when the service crashed, otherwise `null`
- `debugPort`: port the Node inspector bound to, parsed from the process's startup line. `null` unless the service is running under `--inspect`

### `info`

What this daemon is, and what it can do.

```json
{ "method": "info" }
→ { "result": {
      "project": "Guesthub",
      "profiles": { "e2e": ["app-api", "app-web"] },
      "version": "0.16.0",
      "contract": 1,
      "methods": ["debug", "info", "logs.follow", "logs.tail", "ping",
                  "restart", "start", "stats", "status", "status.follow", "stop"]
   } }
```

- `project`, `profiles`: from the config the daemon booted with.
- `version`: the devup release running it, or `"unknown"` if it could not read
  its own manifest.
- `contract`: which revision of the wire shapes it speaks. **This is the field
  to check**, not `version`: it answers "can I trust this field" directly,
  where the release number makes every client keep its own table of what
  arrived when — `originalPort` in 0.12.0, `debugPort` in 0.14.0, `crashes` in
  0.16.0. Those tables are exactly what goes stale.
- `methods`: every RPC this daemon answers, streaming ones included. Ask this
  rather than sending a request and looking for `unknown method` in the error.

**The last three are absent from daemons before 0.16.0** — which is itself the
answer when what you are asking is how old one is.

That absence needs its own branch, and getting it wrong is worse than not
checking at all:

```javascript
const info = await devup.info();
if (info.methods === undefined) {
  // Older than 0.16.0. It still answers everything that existed before then —
  // `debug` since 0.14.0, `start` since 0.14.0 — so assume the old surface
  // rather than refusing. `!info.methods?.includes('debug')` would be `true`
  // here and would turn away a daemon that debugs perfectly well.
} else if (!info.methods.includes('debug')) {
  throw new Error(`this daemon cannot debug (devup ${info.version})`);
}
```

The same shape applies to `contract`: `undefined` means "older than the first
numbered contract", not "contract 0".

`version`, `contract` and `methods` are added by the server itself rather than
by the `RpcContext` behind it, so the daemon and the TUI — which implement
`getInfo` separately, and have drifted apart before — cannot disagree about
them. `methods` is derived from the dispatch table, so a method added without
being advertised is not possible.

Added in 0.16.0.

### `start`

Start a stopped service. No-op when it is already running.

```json
{ "method": "start", "params": { "svc": "app-api" } }
→ { "result": { "ok": true } }
```

**`ok` is the outcome, not an acknowledgement.** The spawner returns normally
after recording a crash — a failed pre-build, a missing watch path, a port
already taken — so `ok: false` means the service did not come up. Check its
logs.

Errors with `unknown service: <name>` when the name is not in the current set.

Details worth knowing:

- **Liveness is read from the process, not from `pid`.** A stopped or crashed service keeps a dead `pid`, so a `pid`-based guard would make this a permanent no-op.
- **A stop in flight is awaited.** `stop` only sends SIGTERM, so a service that drains on shutdown still looks alive; `start` waits up to 5 s for it to exit rather than reporting success and leaving it down.
- **A queued auto-restart is cancelled first**, or it would spawn a second process for the same name seconds later.
- **A lazy service is started through its proxy**, not around it, and the proxy confirms something is actually listening rather than trusting its own readiness flag — which an external stop never clears.
- **An API is "up" when its port answers**, the same bar `bootNormal` uses; a web service is reported started once spawned, as at boot.
- **The restart budget is reset**, so a service that exhausted `MAX_RESTARTS` auto-restarts again after an explicit start.

Added in 0.14.0.

### `debug`

Restart a service under the Node inspector, or without it.

```json
{ "method": "debug", "params": { "svc": "app-api", "enable": true } }
→ { "result": { "debug": true, "port": 39481, "ok": true } }
```

`port` is where the inspector is listening — attach to `127.0.0.1:<port>`. It
is `null` while the service is still starting; `status` reports it as
`debugPort` once Node announces it.

Pass `"port": 9230` to pin one instead of letting the OS choose. Pass
`"enable": false` to restart without the inspector.

Pass `"brk": true` to start the service with `--inspect-brk`, stopped before
its first line, so its startup path can be debugged. Note what that implies:
the service does not open its own port until a debugger attaches and resumes
it, so devup suspends its startup timeout, and a lazy on-demand start waits
ten minutes rather than 45 seconds.

Errors when the service does not run `node`: the flag would be handed to the
command as a script argument and silently ignored, leaving you waiting for a
debugger that never listens.

The flag is stored on the service, so it survives crashes and auto-restarts —
a debugging session usually outlives whatever prompted it. It is the same
field as the config's `debug`, so a transient toggle and a declared setting
cannot disagree.

Added in 0.14.0.

### `restart`

```json
{ "method": "restart", "params": { "svc": "app-api" } }
→ { "result": { "ok": true } }
```

Stops the current process (kill-tree), resets the auto-restart counter to 0, and spawns it again.

```json
{ "method": "restart", "params": { "svc": "app-api" } }
→ { "result": { "ok": true, "skippedIdle": false } }
```

`ok` is the **outcome**, as it is for `start`, not an acknowledgement.

A **lazy** service goes back up through its on-demand proxy, not around it:
spawning around it leaves the proxy's readiness flag false, so the next request
to the public port starts a second process — for an API the `isPortBindable`
pre-flight catches that, but a lazy web has no such guard and the two fight
over the port until the daemon loses its handle on the one actually serving.
A lazy service that is **idle** is left asleep and answers `skippedIdle: true`:
there is nothing to restart, and waking it is not what a caller resetting state
between test suites asked for. `skippedIdle` added in 0.16.0.

**The call blocks until the respawn has happened.** The daemon waits ~1.5 s for
the old process to settle before spawning, and a `preBuild` runs inside that
window too, so a second or a minute are both normal. What it does *not* wait
for is health: the answer means "spawned", not "serving". Query `status` for
that. Do not put a short timeout on this call — the daemon carries on either
way, and giving up early only loses you the answer.

Errors:

- Missing `svc` param → `{ error: { code: -32603, message: "param \"svc\" must be a non-empty string" } }`
- Unknown service → **errors** with `unknown service: <name>`. Until 0.16.0 it
  was a silent no-op that still answered `ok: true`, so a typo looked like a
  success; `start` has always errored, and now the two agree.

### `stop`

```json
{ "method": "stop", "params": { "svc": "app-api" } }
→ { "result": { "ok": true } }
```

Calls `ProcessManager.stop(name)`. Sends SIGTERM to the process tree. The service's intentionalStop flag is set so the auto-restart logic doesn't kick in.

### `logs.tail`

Read a window out of a service's persistent log — by line count, by time, or both:

```json
{ "method": "logs.tail", "params": { "svc": "app-api", "lines": 50 } }
→ { "result": {
    "lines": [
      "2026-05-21T22:14:32.123Z [api] Listening on port 3000",
      "2026-05-21T22:14:33.041Z [api] Connected to mongo"
    ],
    "oldestRetained": 1716329672123
  } }
```

- `lines` defaults to 100, capped at 10 000, and must be a **positive
  integer** — it is not coerced, for the same reason `since` is not.
- `truncated` says whether lines were dropped to fit `lines`. Check it: the cap
  keeps the most **recent**, so what a window loses is its *beginning*, and a
  full-looking answer is exactly what a truncated one looks like. The default
  of 100 applies to a `since` window too, so a 30-second test on a chatty
  service will hit it. Sent since 0.16.0.
- `since` (epoch ms) returns everything written from that moment on. **This is
  the question a failing test has**: with a line count alone you must guess how
  many, and a service that recompiles on every save pushes the interesting part
  out of the tail before you ask for it. Combine the two and `lines` still caps.
- `oldestRetained` is when the oldest line **in the files this call read** was
  written; `null` when there were none, and `null` too when no `since` was
  given, since a plain tail only opens the current file and half an answer is
  worse than none.

  It is a fact, not a verdict: `oldestRetained > since` means the log *starts*
  after your window, which covers both "the earlier lines were rotated away"
  and "the service had not written yet". devup cannot tell those apart, so do
  not report it as data loss. Added in 0.16.0.
- A window read also reaches into the rotated `.log.prev`, so one that spans a
  rotation stays whole. A plain tail does not: "the last N lines" has always
  meant the current file.
- A line with no timestamp of its own — a stack-trace continuation — is kept
  with the line that dates it, rather than cut away from it.
- Returns no lines when the LogSink is disabled (`--no-log-file`) or the
  service has not written yet.
- Reads from disk — works the same as `devup logs <svc>` would, just over the socket.

`since` must be a **number**. It is not coerced: `"yesterday"` becoming `NaN`
and then silently meaning "everything" is how a harness attaches the wrong
evidence to a failure and never finds out.

```json
{ "method": "logs.tail", "params": { "svc": "app-api", "since": 1755800000000 } }
```

## Auth model

The socket file is bound with `chmod 0600`. That means:

- Only the same uid can read/write it.
- No tokens, no signatures, no rate-limiting are needed inside the protocol because filesystem perms already enforce the policy.

Don't loosen those perms unless you have a very specific reason.

For multi-user setups (rare in dev) you'd need a different model entirely; that's deliberately out of scope.

## Talking to it from the shell

```bash
# Quick status check (requires socat or nc with -U)
echo '{"method":"status"}' | socat - UNIX-CONNECT:$HOME/.devup/sock-MyProject.sock
```

Or netcat with Unix-domain support:

```bash
echo '{"method":"ping"}' | nc -U $HOME/.devup/sock-MyProject.sock
```

## From Node

devup ships the client it uses itself, as a subpath export:

```javascript
import { createClient, resolveSocket } from '@gachlab/devup/client';

const devup = createClient(resolveSocket('MyProject'));

const { services, proxy } = await devup.status();
for (const s of services) {
  // `originalPort` is the one to connect to — see the note under `status`.
  console.log(`${s.name} ${s.status}/${s.health} :${s.originalPort}`);
}
```

The types come with it, so nothing has to be re-declared by hand:

```ts
import type { ServiceSnapshot, StatusResult, ProxyInfo } from '@gachlab/devup/client';
```

### Waiting for the stack

```javascript
import { createClient, waitForServices } from '@gachlab/devup/client';

const devup = createClient(resolveSocket('MyProject'));
const res = await waitForServices(devup, { start: true, timeoutMs: 120_000 });
if (!res.ok) throw new Error(`not ready: ${res.notReady.map(s => s.name).join(', ')}`);
```

Exported rather than left to each consumer because the loop is the easy half.
The hard half is what the snapshot means:

- **A lazy service that is `idle` is ready**, not down — its on-demand proxy
  holds `originalPort`, so the stack serves and the first request pays the
  start. Polling that port to find out is a false positive: the proxy answers
  either way. Pass `start: true` to have the start paid up front instead, in
  ascending `phase` order.
- **`status: 'timeout'` is not terminal.** It means the service's startup
  timer gave up — 45 s by default — not that devup did. The health poller keeps
  probing it, so a cold front end that lands at 60 s still counts. Treating it
  as terminal would cap every wait at 45 s, well under the two minutes this
  function defaults to.
- **A crash does not fail the wait.** `Restarter` bumps the restart count to
  its maximum and *then* schedules the last auto-restart, so "crashed with the
  budget spent" is also what a service looks like for the eight seconds before
  the restart that saves it. Nothing in the snapshot separates them, and
  aborting on a service that was about to come back is the worse mistake. Only
  a service the daemon no longer has ends a wait early.
- **Readiness is `health`**, and the daemon computes that from the service's
  own `readyPattern` when it declares one — a bare port probe is not allowed to
  speak for a service that said how it announces itself.

Pass a `signal` (an `AbortSignal`, or anything with `aborted`) to end a wait
early — it is checked once per poll, so a Ctrl-C during a two-minute wait is
acted on in well under a second. The result says `aborted: true`.

An unknown service name throws `UnknownServicesError`, which carries `missing`
and `running`. Its own type because the same call also raises transport
failures, and telling someone to fix their service selection when their daemon
has just died sends them looking in the wrong place.

Two things it cannot know. **The daemon's own health lags.** A service stopped
or killed a moment ago still reads `running`/`up` until the health poller
(every 3 s) has failed `failureThreshold` probes in a row — two by default. A
wait issued immediately after a stop will correctly report ready about a
service that is already gone. Give the daemon a beat, or watch `status.follow`.

`classify` and `selectServices` are exported too, for a consumer that wants the
policy without the loop.

### What `./client` exports

| | |
|---|---|
| `createClient(socketPath, opts?)` | typed handle on one daemon |
| `waitForServices(client, opts?)`, `classify`, `selectServices`, `DEFAULT_WAIT_TIMEOUT_MS` | readiness, as devup itself defines it |
| `createClientForProject(name, opts?)` | the same, resolving the default socket path |
| `resolveSocket(name, override?)`, `defaultSocketPath(name)`, `assertSocketExists(path, name)` | locating a daemon |
| `sendRpc(path, method, params?, opts?)`, `openStream(path, method, params, onFrame, onError?, onClose?)` | the raw transport, for methods newer than your copy of the client |
| types | `ServiceSnapshot`, `StatusResult`, `ProxyInfo`, `StatsResult`, `ServiceStatEntry`, `ProjectInfo`, `PingResult`, `OkResult`, `DebugResult`, `LogsTailResult`, `StreamFrame`, `ProcessStatus`, `HealthStatus` |

`DevupClient` has one method per RPC — `ping`, `status`, `info`, `stats`,
`start`, `restart`, `stop`, `debug`, `logsTail`, `followStatus`, `followLogs`
— plus `call(method, params?, opts?)` for anything not covered.

Deliberately **not** exported: the socket server, `ProcessManager`, the config
loader, and the orchestrator. Those are internals and change between releases;
`./client` is API and does not.

### Two things to know

**One-shot calls have no timeout by default.** Pass `timeoutMs` where a script
must not wait:

```javascript
const { services } = await devup.status({ timeoutMs: 5_000 });
```

A client-wide `createClient(path, { timeoutMs })` works too, but it applies to
**every** call — `start`, `restart` and `debug` included, and those three
restart a service, which legitimately takes a minute. Under a client-wide
timeout, opt them back out per call:

```javascript
const devup = createClient(socketPath, { timeoutMs: 5_000 });
await devup.restart('app-api', { timeoutMs: undefined });   // per call wins
```

A daemon that dies mid-request rejects the call rather than hanging, timeout or
not.

**A stream tells you when the daemon goes away.** `devup down` destroys its
clients, and over a Unix socket that is a clean EOF — no error is raised, and
without `onClose` the stream just goes quiet:

```javascript
const stop = devup.followStatus(onFrame, {
  onError: err => report(err),
  onClose: () => scheduleReconnect(),   // daemon gone; not called if you stop()
});
```

**A throw from a stream's `onFrame` is not caught.** It escapes as an uncaught
exception, deliberately: swallowing it is how `ctl status --follow` once came
to print nothing at all. Wrap your own handler when streaming from a
long-lived process:

```javascript
const stop = devup.followStatus(frame => {
  try { render(frame); } catch (e) { report(e); }
});
```

**The types describe the daemon of the same version.** A globally installed
`devup` can be older than the copy your project depends on, and an older daemon
omits fields added since (`originalPort` from 0.12.0, `debugPort` from 0.14.0).
They are typed as always present on purpose — making them optional would push a
fallback onto every call site, which is the hand-written guessing this export
exists to end. Ask the daemon what it is instead of guarding field by field.

### Or by hand

The protocol is small enough to speak directly, and nothing here requires the
package:

```javascript
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

const socket = createConnection('/home/me/.devup/sock-MyProject.sock');
const rl = createInterface({ input: socket });
rl.on('line', l => console.log(JSON.parse(l)));
socket.write(JSON.stringify({ method: 'status' }) + '\n');
```

## Streaming

`status.follow` and `logs.follow` keep the connection open and push frames until the client closes it. Both answer first with an ack (`{ "result": { "ok": true } }`), then stream.

### `status.follow`

```json
{ "method": "status.follow" }
→ { "result": { "ok": true } }                                  // ack
→ { "event": "status",  "data": [ ...every service... ] }        // initial snapshot
→ { "event": "status",  "data": [ ...one service... ] }          // on each change
→ { "event": "removed", "data": ["legacy-api"] }                 // config reload dropped it
```

The initial snapshot arrives even when it is empty (`data: []`), so a client can distinguish "connected, nothing configured" from "still waiting".

Subsequent `status` frames carry **one** service — they are updates, not snapshots. Merge them by `name`.

`removed` frames name services that left the set after a `--watch-config` reload. **A client that ignores them will show services that no longer exist**, since nothing else signals a departure. Added in 0.13.0; earlier daemons never send this event.

### `logs.follow`

```json
{ "method": "logs.follow", "params": { "svc": "app-api", "tail": 200 } }
→ { "result": { "ok": true } }
→ { "event": "log", "data": "…line…", "svc": "app-api" }
```

Omit `svc` (or pass `null`) to receive every service's output. Replayed tail lines carry `svc` too, so a client can route every frame the same way.

`since` works here as it does for `logs.tail`: the replay is a window, so you
can ask for what a service did during a failing test *and* keep watching what
it does next. `tail` still caps the replay — at 1 000 here, not 10 000, since
this is a backlog rather than a query — and must be a non-negative integer,
`0` meaning "no replay, just the live stream".

The ack carries no `truncated` or `oldestRetained`: this is a stream, not a
result. `devup ctl logs --since … --follow` asks `logs.tail` separately for
those and reports them before the stream starts.

**The replay is per service.** `tail` only applies when you name one: the
all-services stream sends no history at all and starts from the next line
written. Ask for each service separately if you need its backlog.

### `stats`

Per-service CPU and memory, plus host totals.

```json
{ "method": "stats" }
→ { "result": {
      "services": { "app-api": { "cpu": 2.3, "memMB": 184.2 } },
      "system": { "totalMemMB": 31000, "freeMemMB": 18000, "cpuCores": 12,
                  "loadAvg1": 1.42, "cpuPercent": 11.8 }
   } }
```

`loadAvg1` and `cpuPercent` are **absent on Windows**, where `os.loadavg()` is hardcoded to zero and reporting it would look like an idle machine. Added in 0.13.0. `cpuPercent` is the load as a share of `cpuCores`, and can exceed 100.

## The contract fixture

The snapshot shape is written down twice: by `serializeState` here, and by hand
in [gachlab/devup-vscode](https://github.com/gachlab/devup-vscode), which
deliberately does not depend on this package at runtime. Nothing used to keep
the two honest — this document once described `port` as "from config", the
extension believed it, and shipped a release connecting to the wrong port.

`contract/status-snapshot.json` is **generated from `serializeState` itself**
and ships with the package. It covers an always-on service and a lazy one, so
the `port` / `originalPort` distinction is pinned rather than described.

- Renaming a field here fails a golden test in this repo.
- Clients can assert against the fixture instead of trusting prose:

  ```js
  import golden from '@gachlab/devup/contract/status-snapshot.json' with { type: 'json' };
  ```

Regenerate deliberately, and treat the diff as an API change:

```bash
npm run contract:update
```

Regeneration is a separate entry point on purpose: doing it from inside the
golden test lets the test compare the fixture against itself, which makes the
only cross-repo check in the suite unfailable.

## What's NOT there

By design:

- **No remote / TCP** exposure.
- **No long-poll**. A one-shot call returns a fresh snapshot; use the `*.follow` methods above for push.
- **No transaction support** (multi-method atomic ops).

Some of these may be added later if there's clear demand. Open an issue.

## Compatibility

The protocol is plain text JSON over a Unix socket — any language with a JSON
library and a Unix socket client can talk to it. From Node you can skip that
work: `@gachlab/devup/client` is the same client the CLI uses, types included
(see [From Node](#from-node)). Added in 0.16.0; earlier releases compiled the
client into the package without exporting it.
