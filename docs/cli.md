# CLI reference

devup has one binary, several flags, and a handful of subcommands. The default (no subcommand, no special flag) launches the interactive TUI.

```bash
devup                          # interactive TUI (default)
devup --dry-run                # print boot plan and exit
devup --once                   # boot, wait for ready, exit (no TUI)
devup logs <service> [--follow]
devup install
devup status
devup help [<subcommand>]
devup --version
devup --help
```

## Flags

### Service selection

| Flag | Description |
|---|---|
| `--only apis` | Only start API services |
| `--only webs` | Only start web services |
| `--services a,b,c` | Start only the named services |
| `--profile <name>` | Start the services in a named profile (see [Profiles](./profiles.md)) |
| `--skip a,b,c` | Start everything except these |
| `--config <path>` | Use a custom config file |

### Lazy mode

| Flag | Description |
|---|---|
| `--lazy` | Enable lazy mode (default if `lazy` is in config) |
| `--no-lazy` | Disable lazy mode — start every service immediately |
| `--timeout <minutes>` | Idle timeout for lazy services. Default: `10` |

### Reverse proxy

| Flag | Description |
|---|---|
| `--proxy` | Enable proxy config generation (the file is only written when this is on) |
| `--proxy-host <host>` | Override the target host. Default: auto per platform |
| `--proxy-conf <path>` | Override the generated config file path |
| `--proxy-tls` | Enable TLS in the generated config (default) |
| `--no-proxy-tls` | Disable TLS |
| `--proxy-entrypoint <n>` | Traefik entrypoint name. Default: `'websecure'`. Ignored for Nginx/Caddy |

See [Reverse proxy](./proxy.md) for the generated formats.

### Scripting (`--dry-run`, `--once`)

| Flag | Description |
|---|---|
| `--dry-run` | Print the resolved boot plan (phases, commands, lazy proxies, proxy YAML) and exit `0` without starting anything |
| `--once` | Boot every service phase-by-phase without a TUI, wait for **every service** to become ready, exit `0` (all up) or `1` (timeout / install failure) |
| `--once-timeout <seconds>` | Max seconds to wait in `--once` mode. Default: `120` |
| `--json` | With `--once`, print a machine-readable summary instead of progress lines |

`--once` is built for CI smoke tests: prove the stack boots, then teardown.

With `--json` the summary goes to stdout and **nothing else does** — the
services' own output moves to stderr, because one `[app-api] listening` line in
the middle of the JSON and the caller cannot parse it at all, while losing that
output entirely is how a failing CI run becomes undiagnosable:

```json
{
  "ok": false,
  "elapsedMs": 12345,
  "timeoutMs": 120000,
  "services": [
    { "name": "app-api", "type": "api", "phase": 0, "port": 3000,
      "ready": true, "readyAfterMs": 3200 },
    { "name": "app-web", "type": "web", "phase": 4, "port": 4200,
      "ready": false, "readyAfterMs": null,
      "reason": "did not become ready within 120s" }
  ]
}
```

Every selected service appears, including ones that never got their turn
because an earlier phase failed — leaving them out would make the pipeline
guess.

**What "ready" means, per service.** Until 0.16.0 `--once` waited only for
`type: 'api'` services, so it returned while the front end was still
compiling — and the caller then had to wait again, which is the one thing
`--once` exists to spare them. It now waits for everything, and picks the
signal that is actually honest for each:

- a **web with a `readyPattern`** is ready when a line matches it. Its port is
  ignored: `ng serve` opens the port long before the bundle exists, so the port
  says "ready" while a browser still gets nothing;
- an **API** is ready when its port answers (or its `healthCheck` passes) — the
  same bar the daemon uses at boot. A `readyPattern`, when there is one, only
  ever lets it finish sooner;
- a **web with no `readyPattern`** has nothing better than its port. That is the
  reason to set one on every web in the config, and the failure message says so.

Because the wait now covers more, the default timeout went from 90 s to 120 s.
A cold `ng serve` is the slowest thing in a typical stack by a wide margin.

### Environment

| Flag | Description |
|---|---|
| `--env <path>` | Read this `.env` instead of `config.envFile` / `.env` |

For one run against a test database without editing a versioned config file:

```bash
devup exec --env .env.e2e -- npx playwright test
```

The file must exist. `parseEnvFile` returns the base environment for a file
that is not there, which is right for the implicit `.env` and wrong for one
someone typed: this is a per-run override usually pointing at a test database,
and a mistyped path that silently falls back means running the suite against
the development one instead.

**It is `--env`, not `--env-file`, and that is not a style choice.** Node claims
`--env-file` for itself and takes it from *anywhere* in argv, script arguments
included — so `devup --env-file .env.e2e` never reaches devup at all. With the
file present node quietly loads it and moves on; without it, node exits
`node: .env.e2e: not found` before a line of devup runs.

### Log files

| Flag | Description |
|---|---|
| `--no-log-file` | Disable the persistent log file |
| `--log-dir <path>` | Override log root. Default: `~/.devup/logs/<project>/<svc>.log` |

devup writes a per-service `.log` file as long as `--no-log-file` is not set. Lines are ISO-8601 timestamped. On each fresh launch the previous file is rotated to `<svc>.log.prev`, so you always have at most two runs of history per service.

### Hot reload

| Flag | Description |
|---|---|
| `--watch-config` | Watch `devup.config.*`; on save, diff against the running set and apply add/remove/restart per service. Validation runs first; failed configs leave the running set untouched. See [Hot reload](./hot-reload.md) |

### Meta

| Flag | Description |
|---|---|
| `-h`, `--help` | Print this flag summary and exit |
| `-v`, `--version` | Print version and exit |

## Subcommands

The subcommands work without launching the TUI. They need to be able to find the config (use `--config` if your file isn't in the cwd or a standard location).

### `devup logs <service> [--follow|-f]`

Print the persisted log file for a service to stdout:

```bash
devup logs app-api
devup logs app-api --follow      # tail -f semantics, exits on SIGINT
```

Reads from `~/.devup/logs/<project>/<service>.log` (or the location overridden by `--log-dir`). Works even when devup is not running — it's just reading the file. `--follow` uses `fs.watchFile`, so it'll pick up appends from a live devup elsewhere.

If the file doesn't exist yet, `--follow` waits for it to appear.

### `devup install`

Run `npm install` across every service's `cwd` in parallel (max 4 at a time):

```bash
$ devup install
✓ app-api
✓ web
✓ auth
...
12 services up to date
```

Skips services whose `.install-stamp` matches the current `package.json` hash (the same mechanism devup uses internally on boot). Useful after `git clone` or a branch switch.

Exit code 0 only if every install succeeded; 1 if any failed.

### `devup status`

For each service in the config, run the configured `healthCheck` and print a one-line summary:

```bash
$ devup status
📦 MyApp — 12 services

Service        Port  Type  Health
---------------------------------------
app-api        3000  api   ✓ up
auth           3002  api   ✓ up
files-api      3013  api   ✗ down
...
```

Probes happen in parallel (it's a snapshot, not a watcher). Useful in scripts: `devup status && deploy-tests-against-local`.

### `devup ctl start` / `devup ctl restart`

```bash
devup ctl start app-api                    # one
devup ctl start app-api app-web auth-api   # several
devup ctl start --profile e2e              # a profile
devup ctl restart --all                    # the whole stack
devup ctl restart --all --wait             # ...and block until they are healthy
```

Ascending config phase, concurrent within a phase. The phase order is the only
statement anyone has made about what needs what, so a batch that ignores it
starts a phase-4 web against a phase-0 API that is still going down; the
concurrency inside a phase is the point, since warming eight lazy services one
at a time is most of the reason people write their own loop instead.

`restart --all` is what you want *between* test suites: it resets in-memory
state without taking the stack down and paying a cold boot. A lazy service that
is **idle is left asleep** — there is nothing to restart, its state is already
fresh, and waking it is the opposite of what you asked for. One that *is*
running goes back up through its on-demand proxy rather than around it; see
[lazy mode](./lazy-mode.md).

Exits `1` naming the ones that did not come up. Neither takes an implicit
"everything" — say `--all` if you mean it, because restarting a whole stack
because a name was forgotten is not a mistake worth being quiet about. A name
the daemon does not have fails the whole batch before anything is started,
rather than half-doing it.

### `devup ctl logs <svc> [--since <when>] [--lines <n>] [--follow]`

```bash
devup ctl logs app-api --since 5m           # the last five minutes
devup ctl logs app-api --since 2026-08-23T10:00:00Z
devup ctl logs app-api --since 1755800000000 --lines 500
```

`--since` takes a duration (`30s`, `5m`, `2h`, `1d`), an ISO-8601 timestamp, or
epoch milliseconds. A bare integer is read as **epoch milliseconds, not a
duration** — `--since 500` cannot mean both "500 ms ago" and "epoch 500", and a
unit is cheap to type. Anything it cannot read is an error rather than a quiet
"from the beginning": a harness that mistypes its window and silently gets the
whole log attaches the wrong evidence to a failing test, which is worse than
attaching none.

This is the shape an `afterEach` wants — the log of the API *between the start
and the end of the test that just failed*, which is what makes a CI failure
diagnosable without reproducing it. With `--lines` alone you have to guess how
many, and a service that recompiles on every save pushes the window you care
about out of the tail before you ask for it.

`--since` works with `--follow` too: the replay is a window, so you get what
the service did during the failing test and then keep watching.

The log rotates on every launch and at 10 MB. A window that spans a rotation is
read out of both files. If the log starts after the window you asked for, devup
says so — and says both of the things that can mean, because it cannot tell
"rotated away" from "the service was not running yet".

### `devup exec [options] -- <cmd> [args...]`

Boot the stack if it is not already up, wait until it is ready, run the command
against it, and stop **only what this invocation started**.

```bash
devup exec -- npx playwright test --config playwright.app.config.ts
devup exec --profile e2e --start --fail-on-crash -- npm run test:e2e
```

| Flag | Description |
|---|---|
| `--start` | Start idle lazy services before waiting, in config phase order, so the first request does not pay the cold start |
| `--wait-timeout <s>` | Seconds to wait for readiness. Default: `120` |
| `--fail-on-crash` | Fail the run if a service crashed while the command was running, even when the command itself passed |

Service selection (`--profile`, `--services`, `--only`, `--skip`) and every
other boot flag work as they do for `devup up -d`, and are handed to the daemon
when this invocation is the one booting it.

**Everything after `--` is the command, untouched.** devup stops reading flags
there — otherwise `devup exec -- npx playwright test --timeout 30` would set
devup's own lazy idle timeout to 30 minutes.

Exit code is the command's, with three exceptions:

- `1` if the stack never became ready, or if `--fail-on-crash` fired on a
  command that otherwise passed;
- `127` if the command could not be run at all;
- `128+n` if a signal killed it.

#### Reuse, and what gets torn down

An already-running daemon is **reused and left up**; one this invocation
started is stopped when the command ends, whatever the command did. This is
the same distinction Playwright's `reuseExistingServer` exists to make, and it
is why `exec` is a devup subcommand rather than four lines of bash: a `trap` is
forgotten, or it kills the stack the developer already had open.

If the running daemon was started with a *different* set of services than your
config and flags select, `exec` refuses rather than narrowing to the
intersection — a green suite that never exercised half the stack is worse than
a clear failure. Stop it with `devup down` and let the run boot its own.

#### `--fail-on-crash`

The snapshot carries `restarts` and `errors`, but the *window* — did anything
die while the command was running? — has to be photographed at both ends, and
only the daemon has the counters. Without this, a suite goes green while an API
throws a stack trace on every request.

The signal is the snapshot's `crashes`, a counter that only goes up. It cannot
be `restarts`, which looks like it would do the job: that is a *budget*, and
both a manual `restart` and an explicit `start` reset it to 0 — so a suite
whose own setup calls `devup ctl restart` would hide every crash after it.
Deliberately **not** `errors` either: it counts stderr lines, and plenty of
healthy tools write to stderr constantly — the Angular CLI does — so using it
would make the flag fire on nothing at all.

### `devup ctl wait [svc...] [--profile <p>] [--start] [--timeout <s>] [--json]`

Block until the named services are ready — all of them by default. Exits `0`
when they are, `1` naming the ones that did not make it.

```bash
devup ctl wait                          # everything
devup ctl wait app-api app-web          # just these
devup ctl wait --profile e2e --start    # and warm the idle ones first
devup ctl wait --timeout 240 --json     # for a pipeline to read
```

Three things it knows that a hand-written polling loop usually does not:

- **A lazy service that is idle counts as ready.** It is not `down`: its
  on-demand proxy holds the configured port, so the stack serves — the first
  request just pays the start. Probing that port to decide is a false positive,
  because the answer comes from the proxy either way.
- **`--start` is how you ask for that start to have been paid already**, in
  config phase order. That is the difference between a suite whose first test
  fails on a 10-second action timeout and one that passes on the first run.
- **Readiness is `health`**, and the daemon computes that from the service's
  own `readyPattern` when it declares one — a bare port probe is not allowed to
  speak for a service that said how it announces itself. A web with a pattern
  therefore announces itself exactly like an API does.

Nothing fails the wait early except a service the daemon has stopped having at
all. In particular a **crash does not**: `Restarter` bumps the restart count to
its maximum and *then* schedules the last auto-restart, so "crashed with the
budget spent" is also what a service looks like for the eight seconds before
the restart that saves it, and the snapshot cannot tell the two apart. Nor does
`timeout`: that only means the service's own 45-second startup timer gave up,
and the health poller keeps probing it.

The same logic is importable — `waitForServices` from
[`@gachlab/devup/client`](./control-plane.md#from-node) — so a harness in Node
does not have to shell out to get it.

### `devup help [<subcommand>]`

General help or detailed help per subcommand:

```bash
devup help              # lists subcommands
devup help logs         # detail for logs
devup help install      # detail for install
devup help status       # detail for status
```

## Common workflows

### CI smoke test

```bash
devup --once --once-timeout 120 --no-log-file
# exits 0 if every service — webs included — is ready within 120 s
```

### End-to-end suite against the stack

```bash
devup exec --profile e2e --start --fail-on-crash -- npx playwright test
# boots if needed, waits, runs, tears down only what it started,
# and fails the run if a service crashed while the suite was green
```

### Dry run after big config refactor

```bash
devup --dry-run --proxy
# prints phases, commands, proxy YAML — verify before running
```

### Edit-and-apply workflow

```bash
devup --watch-config
# leave it running; edit devup.config.ts in another terminal; saves
# diff against running services and apply (add/remove/restart) without
# killing the TUI
```

### Running with an external proxy

```bash
devup --proxy --proxy-host 127.0.0.1 --proxy-tls
# writes Traefik YAML continuously; your Traefik watches the file and
# routes accordingly
```

### Booting only what you need

```bash
devup --profile check-in        # subset by name (see Profiles)
devup --services app-api,app-web --no-lazy   # explicit subset, all eager
devup --only webs --no-lazy     # all webs only, eager
```

## Exit codes

- `0`: clean exit. TUI was quit via `q`/`Ctrl+C`; `--once` saw every service ready; `ctl wait` saw them ready; subcommands completed successfully.
- `1`: something failed. Config validation errors, `--once` timeout, install failure, `ctl wait` timing out, `devup exec` failing to get the stack ready or tripping `--fail-on-crash`. The reason is printed to stderr.
- `devup exec` otherwise exits with **the command's** code, including `127` when the command could not be run and `128+n` when a signal killed it.
