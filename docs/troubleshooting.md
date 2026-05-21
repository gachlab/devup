# Troubleshooting

What to check when something doesn't behave. Grouped by symptom.

## Boot problems

### "❌ Config validation failed"

devup found something it considers blocking. The output lists each problem with the field path:

```
❌ Config validation failed:
  ✗ services[api].port: Invalid port: undefined
  ✗ services[web].cwd: Directory not found: packages/web
```

Fix each, save, rerun. Common ones:

- **Directory not found** — the `cwd` in your config doesn't exist relative to the project root.
- **Port already used by X** — two services share a `port`.
- **Lazy real port collides with X** — `port + 10000` of one service matches another's `port`. Renumber.
- **Unknown service in profiles / lazy.alwaysOn / proxy.routes** — referenced a service name that doesn't exist.
- **Invalid regex in readyPattern / errorPattern** — your `/pattern/flags` doesn't parse. Test with `new RegExp(...)` in a node REPL.

### "⚠ extraEnv.PORT="3001" does not match port=3000"

Not blocking, just a warning. You probably want to either remove `extraEnv.PORT` (and let your service read `PORT` from its own env or default) or change `port` to match. See [Configuration reference](./configuration.md#validation).

### Service stays in `starting` forever

Three usual suspects:

1. **The service never actually listens on `port`**. Check its log; maybe it crashed silently or printed an error to stdout.
2. **`healthCheck.startPeriod` is too large**. devup is honoring it. Reduce or remove.
3. **Wrong port in `healthCheck`** (if you customised host/port there). Default is `127.0.0.1:port`; check whether your service is bound to `localhost` only vs `0.0.0.0`.

If the service IS listening but devup says `wait`:

- Verify with `curl http://127.0.0.1:<port>/` directly. If curl works, devup's probe should too — file an issue.

### "⚠ missing watch paths: src, lib"

The service's args contain `--watch-path src` (or `lib`) and those directories don't exist relative to `cwd`. Usually means a rebase moved or deleted a directory. Fix the path in the args or update the config to point at the new location.

### Port conflict at boot

`⚠ port 3000 already in use — skipping` means something else (another devup? a stray process?) is already on that port. Try `lsof -i :3000` (Unix) or `netstat -ano | findstr :3000` (Windows) to find the culprit.

## Health-check problems

### Health flips between `up` and `down`

The service is probably crashing and restarting. Look at the `Rst` column on the stats panel — if it's rising fast, the service is in a crash loop. Press `r` and pick the service to see its log specifically, or `Tab` to logs and `f` to filter to it.

If it's a real flap (not a crash loop), check the probe target. HTTP probes that hit `/` might race with non-idempotent startup paths.

### Health-check works in `curl` but not in devup

- Verify `healthCheck.path` starts with `/`.
- Verify `healthCheck.expect` includes the status code your endpoint returns. The default is any 2xx (200-299); a `204 No Content` is fine but a `301` redirect isn't.
- Verify the service binds to `127.0.0.1` (or whatever `healthCheck.host` is). Some frameworks bind to `::1` (IPv6) by default; devup probes IPv4. Add `--host 0.0.0.0` or `127.0.0.1` to the service's args.

## Lazy mode problems

### "Connection refused" on a lazy service

Check the boot log for the lazy-proxy registration. If you don't see `⚡ on-demand start` when you connect, the proxy isn't bound. Most likely:

- The service is in `lazy.alwaysOn` and is starting normally — there's no proxy in that case; treat it as a regular service.
- The TCP listener failed to bind. Look for an error on the boot log.

### Service gets killed mid-stream

The idle timer respects active connections — long-lived streams (WebSocket, SSE) shouldn't trigger expiration. If you still see it, file an issue with a reproducer (idle timeout, the kind of connection, and the log around the expiration).

### Lazy doesn't make sense in this scenario

If a service starts so fast that lazy is more friction than help, move it to `lazy.alwaysOn`. Or `devup --no-lazy` for that session.

## Reverse-proxy problems

### Proxy file is empty / has placeholder

```
http:
  routers: {}
  services: {}
```

That's intentional when no service is `health === 'up'` yet. Wait for the boot to complete, then refresh.

If services ARE healthy but the file is still empty:

- Confirm `--proxy` is passed (without it, devup never writes the file).
- Confirm `proxy.routes` includes the services you expect.
- Confirm the project root has `DOMAIN` (or `GUESTHUB_DOMAIN`) in env or `.env`. devup falls back to `localhost` otherwise.

### Browser opens to `http://localhost:<port>` instead of `https://<sub>.<domain>`

Two requirements for TLS-aware open:

1. `--proxy` is active.
2. The service has a route in `proxy.routes`.
3. `proxy.tls !== false`.

Otherwise devup falls back to localhost.

### "Generated config wrong port for lazy service"

Expected behavior: lazy services use `port + 10000` (the real port) as the proxy upstream so the reverse proxy talks directly to the service. devup's own TCP relay sits on the public port for non-proxy traffic. See [Lazy mode](./lazy-mode.md).

## TUI problems

### Logs panel doesn't scroll up

You're probably in auto-pause (it triggers when you scroll up). Scroll all the way down with `Ctrl+E` to resume auto-follow, then scroll up again to enter manual mode.

### Search seems broken

If your search starts with `/` and looks like `/foo/`, devup treats it as a regex. Invalid regex falls back to substring AND surfaces `(invalid regex)` in the panel header — if you see that, your pattern is invalid. Test it in a Node REPL: `new RegExp('your', 'i')`.

### Filter modal types weirdly

Service-picker modals (`f`, `r`, `o`) accept typed characters for fuzzy filtering — that's intentional. First `Esc` clears the filter; second `Esc` closes the modal.

### Layout looks wrong after resize

devup listens for resize and recomputes. If a single resize doesn't take effect (rare), `Ctrl+L` or quit + reopen the terminal usually fixes it.

## Control plane problems

### "control plane disabled: EACCES"

The socket directory `~/.devup/` isn't writable. Check perms, or override the path (currently requires running on a writable home directory; no flag yet).

### "control plane disabled: EADDRINUSE"

A stale socket from a previous run is locked. devup tries to remove it but the kernel held the inode. Manual cleanup:

```bash
rm $HOME/.devup/sock-<project>.sock
```

Then restart devup.

## Subcommand problems

### `devup logs <svc>` says "No log file yet for X"

The persistent log hasn't been created yet. Either:

- The service never started in a previous run.
- You passed `--no-log-file` (logs are disabled).
- The `--log-dir` is different now than when devup wrote the file.

### `devup install` fails for one service

The exit-1 service's `cwd` probably has a broken `package.json`. devup runs `npm install` directly with the service's cwd as the working directory — try `cd <cwd> && npm install` to see the real error.

### `devup status` shows everything `down`

devup is not running, so nothing is bound. The status command does NOT spawn services — it just probes whatever is listening. If your dev stack isn't running, expect `down` across the board.

## Hot reload problems

### "config reload error: ..."

The new config threw during load (e.g. an import in `devup.config.ts` errored). The running set is untouched. Fix the source, save, devup will re-try automatically.

### Save doesn't seem to trigger a reload

Most likely your editor replaced the file with a different inode (some editors do "write to .tmp, rename over original"). devup watches the file, not the directory; replacements can confuse `fs.watch`.

Workaround: kill devup and restart with `--watch-config`. Or file an issue and we'll consider switching to a directory watcher.

## Publish / npm install problems (for devup itself)

These don't usually concern users of the library, but if you're contributing:

### `npm install -g npm@latest` fails on CI with MODULE_NOT_FOUND

Known flake during npm's self-upgrade. The workflow now pins `npm@11` instead of `@latest`. If you see this in your own fork, pin a version explicitly.

### `npm publish` fails with `EOTP`

The OIDC trusted publisher isn't picking up. Check:

1. The trusted publisher is configured at https://www.npmjs.com/package/@gachlab/devup/access (Publisher: GitHub Actions, Repo: gachlab/devup, Workflow: publish.yml, Environment: npm).
2. The workflow has `id-token: write` permission and `environment: npm`.
3. `setup-node` has `registry-url: https://registry.npmjs.org`.
4. npm version is ≥ 11.5.1 (auth via OIDC requires it; provenance signing works with older versions).
5. `NODE_AUTH_TOKEN` is NOT set in the publish step env — if present, npm uses it instead of OIDC and falls back to classic-token auth (which needs OTP).

## I can't tell what devup is doing

Two best places to look:

- The logs panel filtered to `devup`: `f`, pick `devup`. Every internal status message is tagged that way.
- `~/.devup/logs/<project>/<service>.log` — disk record of every line, even after `c` (clear) in the TUI.

If devup is hanging, `kill -USR1 <pid>` doesn't do anything (no debug dump implemented). Hit `Ctrl+C` twice to force-exit and file an issue with the last few log lines.

## Still stuck?

File an issue at https://github.com/gachlab/devup/issues with:

- The relevant config snippet (anonymise secrets).
- The exact command you ran.
- The last 50 log lines.
- OS + Node version.
- devup version (`devup --version`).
