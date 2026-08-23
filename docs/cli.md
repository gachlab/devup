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

`--once` is built for CI smoke tests: prove the stack boots, then teardown.

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

The signal is `restarts` going up, plus a service that ended `crashed` without
having started that way. Deliberately **not** `errors`: it counts stderr lines,
and plenty of healthy tools write to stderr constantly — the Angular CLI does —
so using it would make the flag fire on nothing at all.

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
- **Readiness is `health`, not `type`.** A web with a `readyPattern` announces
  itself exactly like an API does.

A service in `timeout` fails the wait immediately rather than burning the
clock: the health poller skips that status outright, so it is a state the
service cannot leave on its own.

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
