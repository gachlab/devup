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
| `--once` | Boot every service phase-by-phase without a TUI, wait for every API to become healthy, exit `0` (all up) or `1` (timeout / install failure) |
| `--once-timeout <seconds>` | Max seconds to wait in `--once` mode. Default: `90` |

`--once` is built for CI smoke tests: prove the stack boots, then teardown.

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
# exits 0 if everything boots within 120 s, 1 otherwise
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

- `0`: clean exit. TUI was quit via `q`/`Ctrl+C`; `--once` saw every API healthy; subcommands completed successfully.
- `1`: something failed. Config validation errors, `--once` timeout, install failure, etc. The reason is printed to stderr.
