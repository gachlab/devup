# Hot reload (`--watch-config`)

Restart-free workflow for editing `devup.config.ts`. Opt-in via the `--watch-config` flag.

```bash
devup --watch-config
```

devup watches the resolved config file. On save:

1. Re-load and validate.
2. Diff the new service list against the running set.
3. Apply: stop removed, stop+respawn changed, spawn added.
4. Log a one-liner summary in the logs panel.

The TUI doesn't restart. Logs you were reading are still there. Filters and search persist.

## What counts as a "change"

A service is considered **changed** if any of its spawn-relevant fields differ between the old and the new config:

```
cwd, cmd, args, port, phase, maxMem,
preBuild, watchBuild, nodeArgs, extraEnv,
healthCheck, readyPattern, errorPattern, type
```

If only metadata changes (something not in that list), the service is **unchanged** and devup leaves it alone. This avoids unnecessary respawns when you're editing comments or unrelated parts of the config.

The comparison is by JSON-string equality. Reordering keys in an object is a no-op; reordering array elements (`args`, `nodeArgs`) is a change.

## What happens to each category

| Category | Action |
|---|---|
| **Added** (new service in the config) | `install` if needed, then `start`. Color index is assigned next free slot |
| **Removed** (service deleted from config) | `stop` (kill-tree, SIGTERM with 3 s grace), then dropped from state |
| **Changed** | `stop`, wait 800 ms for the OS to release the port, `install`, `start`. The `colorIdx` is preserved so the log tag color stays the same |
| **Unchanged** | Nothing — even if you edited a comment in that service's block |

Phase ordering is **not** re-applied on hot reload. New services come up in whatever order devup processes them (currently: as written in the new config). For complex re-orderings, a fresh restart is safer.

## What devup will refuse to apply

If the new config is invalid (port collision, missing required field, invalid regex, etc.), devup:

1. Prints the validation errors block in the logs panel.
2. **Does not touch the running set.**
3. Goes back to watching for the next save.

So a broken save mid-edit doesn't take down your stack. You correct the config, save again, devup re-tries.

## Save debouncing

Editors typically emit several `change` events per save (atomic-write + rename + chmod is common). devup debounces saves with a **250 ms window**: rapid back-to-back events coalesce into a single reload. And an in-flight guard prevents two reloads from running concurrently — if you save again while a reload is mid-application, the second save is queued and runs immediately after the first finishes.

## The reload summary

```
🔁 config reloaded: +2 added, -1 removed, ~3 changed
```

The summary is logged once per reload (tagged `[devup]` in the panel). `0 added / 0 removed / 0 changed` reloads are silent — they happen if the config file's mtime changed but the parsed result is identical.

## Limitations

- **`external` services are NOT diffed.** Changing the `external` block requires a manual restart of devup. This is current scope — externals have their own lifecycle (docker daemon, stopCmd) that's harder to apply mid-flight.
- **`lazy.alwaysOn` changes are NOT applied.** Moving a service between always-on and lazy requires a manual restart. (The lazy proxy lifecycle is complicated enough that we err on the side of explicit.)
- **Editing a lazy service's own fields restarts it through its proxy**, so an
  asleep one stays asleep and picks up the change on its next request. This
  used to spawn the process on the *public* port its proxy was holding — the
  service died with EADDRINUSE and ended `crashed`. Fixed in 0.19.2.
- **A service served from a remote environment is not restarted.** There is no
  process here; devup says so and points at `devup ctl remote <svc> --local`.
- **`proxy.routes` changes ARE applied automatically.** The proxy file is regenerated every 3 s from the live config, so route changes take effect on the next sync without any special handling.
- **`profiles` changes ARE seen** at next reload, but they only matter at boot (selecting which services exist). If the running set was filtered by `--profile`, that filter still applies to the new config — a profile that no longer exists triggers an error.

## When you should NOT use --watch-config

- **Production-like setups** where you want every config change to go through review. Hot reload is a dev convenience.
- **Configs that share files with another tool** that also rewrites them (lockfiles, generated configs). The 250 ms debounce isn't infinite — concurrent rewrites can race.
- **Editors that save in two phases** (write temp file, rename over). Most modern editors do this and it works fine with debouncing. If yours doesn't (vim with `set nowritebackup` does it cleanly; some IDEs don't), reloads might fail intermittently. File an issue with the exact editor.

## Debugging

To see what's happening when a save doesn't seem to apply:

1. Logs panel filter to `devup`: `f`, then pick "devup". You'll see every reload event there.
2. `devup` lines starting with `🔁` are successful reloads with their summary.
3. `⚠ config reload failed:` followed by the validation errors block tells you why a save was rejected.
4. `⚠ config reload error:` followed by an exception message means something blew up in JS (e.g. an import in your config threw). The running set is untouched.

If the save itself doesn't seem to trigger any of the above, your editor might be replacing the file with a different inode and `fs.watch` lost the handle. devup currently watches the file (not the directory). If this hits you in practice, file an issue and we'll switch the implementation.
