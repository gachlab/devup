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
- `restarts`: cumulative since spawn
- `pid`: OS pid, `null` if not currently running
- `startedAt`: epoch ms of the current spawn, `null` if not running. Nulled together with `pid`, so it is not a liveness signal of its own
- `crashLog`: `string[]` of the last stderr lines when the service crashed, otherwise `null`

### `restart`

```json
{ "method": "restart", "params": { "svc": "app-api" } }
→ { "result": { "ok": true } }
```

Calls `ProcessManager.restart(name)` — stops the current process (kill-tree), resets the auto-restart counter to 0, and spawns it again. The respawn is async; query `status` afterwards to confirm.

Errors:

- Missing `svc` param → `{ error: { code: -32603, message: "param \"svc\" must be a non-empty string" } }`
- Unknown service → silently no-op (devup ignores restarts of unknown services); the `result: { ok: true }` does NOT prove the service exists. Best practice: call `status` first to verify.

### `stop`

```json
{ "method": "stop", "params": { "svc": "app-api" } }
→ { "result": { "ok": true } }
```

Calls `ProcessManager.stop(name)`. Sends SIGTERM to the process tree. The service's intentionalStop flag is set so the auto-restart logic doesn't kick in.

### `logs.tail`

Read the last N lines of a service's persistent log file:

```json
{ "method": "logs.tail", "params": { "svc": "app-api", "lines": 50 } }
→ { "result": { "lines": [
    "2026-05-21T22:14:32.123Z [api] Listening on port 3000",
    "2026-05-21T22:14:33.041Z [api] Connected to mongo",
    ...
  ] } }
```

- `lines` defaults to 100, capped at 10 000.
- Returns `[]` when the LogSink is disabled (`--no-log-file`) or the file doesn't exist yet.
- Reads from disk — works the same as `devup logs <svc>` would, just over the socket.

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

The protocol is plain text JSON over a Unix socket — any language with a JSON library and a Unix socket client can talk to it. There's no client SDK in devup itself; the protocol is small enough that you don't need one.
