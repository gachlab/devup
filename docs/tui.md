# TUI tour

The whole keyboard surface and what each panel shows.

## Layout

```
┌─ 📦 MyApp — devup — 12 services (lazy)  · tip: press / to search ─────┐
│ Logs [filter:api] /error [PAUSED] [SCROLL] 432 lines (10-29/432)      │
│ 10:24:13 [api      ] Listening on port 3000                           │
│ 10:24:13 [api      ] Connected to mongo                               │
│ 10:24:14 [web      ] vite v5 ready in 423 ms                          │
│ …                                                                     │
├────────────────────────────────────────────────────────────────────────┤
│ Stats (1-12/12)  ⚠ 2 need attention  System: 8c Load 1.42 RAM 6.2GB   │
│ APIs (5)                       │ Webs (7)                              │
│ ● api          3000 running  … │ ● app-web   4200 running  …          │
│ ✖ files-api    3013 looping  … │ ● admin-web 4204 running  …          │
│ …                              │ …                                    │
├────────────────────────────────────────────────────────────────────────┤
│ q Quit  Tab Switch  ↑↓ Scroll  …  L Level  v Verbose  T Proxy         │
└────────────────────────────────────────────────────────────────────────┘
```

Top: project header. Middle: split panes (Logs above, Stats below). Bottom: status bar with all keybindings.

## Keybindings

| Key | Action |
|---|---|
| `q` / `Ctrl+C` | Quit. Stops every spawned process (kill-tree). Hits the cleanup grace window (3 s) before SIGKILL |
| `Tab` | Switch focus between Logs and Stats |
| `↑` / `↓` | Scroll the focused panel by 1 line/row |
| `[` / `]` (or `Ctrl+B` / `Ctrl+F`) | Page up / page down |
| `Ctrl+A` / `Ctrl+E` | Jump to top / bottom of the focused panel |
| `f` | Open the service-filter modal (logs panel) |
| `L` | Cycle log level filter: `all → error → warn+error → all` |
| `a` | Show all logs (clears filter / search / level filter) |
| `/` | Open the search input (accepts `/pattern/flags` regex) |
| `p` | Pause/resume log output (auto-paused while scrolled up) |
| `t` | Toggle timestamps in the logs panel |
| `c` | Clear the logs buffer (does NOT delete the persistent log files) |
| `s` | Cycle stats sort mode: `name → memory → errors → name` |
| `r` | Open the restart modal |
| `o` | Open a web service in the browser (TLS-aware when `--proxy` is active) |
| `v` | Toggle verbose stats (show resolved `cmd`/args/env per service) |
| `T` | Toggle reverse-proxy config sync (writes / pauses the file) |

Service-picker modals (`f`, `r`, `o`) accept typed characters for fuzzy filtering.

## Logs panel

What you see:

- **Header label**: `Logs [filter] /searchTerm (invalid regex) [level: error] [PAUSED] [SCROLL] N lines (start-end/total)`.
- **Lines**: `[time] [service-name] message`. Time is shown when `t` is on. Service name is color-tagged.
- **Search highlight**: matched substrings get a yellow background.
- **Level filter**: when active, only lines whose detected level matches are shown (see [Health checks](./health-checks.md) for the level grammar).

Behaviors:

- **Auto-scroll**: at the bottom, the panel follows the latest line as new logs arrive.
- **Auto-pause**: scrolling up automatically pauses the log stream so the line you're reading doesn't jump under your cursor. Returning to the bottom (`Ctrl+E`) resumes.
- **Filter by service** (`f`): pick from a fuzzy-filterable modal. The panel border tints to that service's color so you remember context after `Tab`'ing away.
- **Filter by level** (`L`): cycle through all → error → warn+error → all. Error keywords include `error`, `fail(ed|ure)`, `fatal`, `exception`, `crash(ed)`, plus devup's own `❌`/`✗`/`⛔` markers.
- **Search** (`/`): substring by default, vim-style regex when you wrap the term in slashes (`/error: \w+/`). Invalid regex falls back to substring and surfaces `(invalid regex)` in the header.
- **Clear** (`c`): truncates the in-memory buffer (keeps the persistent log files on disk intact).

## Stats panel

Two columns: APIs left, Webs right. Each row:

```
H Service          Port  Status    CPU    Mem   Err Rst   Up
● auth-api          3002 running    1.2%  84MB  0   0    23m
● app-api           3000 running   12.5% 256MB  0   1     5m
✖ files-api         3013 looping    0%    -   23   3      -
○ files-svc         3025 idle        -    -    0   0      -
```

- **H (Health)**: `●` (filled) for running, `○` (hollow) for idle/lazy, `✖` (bold red) for crash-looped.
- **Status**: `starting`, `running`, `stopped`, `crashed`, `idle`, `timeout`, `looping` (when restarts exhausted).
- **Port**: the public port. Lazy services listen here but the real service runs on `port + 10000`.
- **CPU / Mem**: refreshed every 3 s via platform-native `ps` (Unix) or `wmic` (Windows).
- **Err / Rst**: cumulative errors / restarts since spawn.
- **Up**: uptime since the current spawn (resets on restart).

Sort with `s`: `name` → `mem` (highest first) → `errors` (highest first) → back to `name`.

Verbose mode (`v`) adds two indented dim lines per row:

```
● orders-api 3031 running …
   cmd: node --max-old-space-size=256 dist/index.js
   env: DATABASE_URL=postgres://... API_KEY=***
```

Secret-looking keys (token / password / secret / key / auth, case-insensitive) are redacted to `***`.

A `⚠ N need attention` counter appears in the panel header when at least one service is crash-looped. Press `r` and pick the looping service to give it a fresh restart budget.

A `⚠ RAM N%` banner appears when system RAM crosses 80 %, with the top three memory consumers listed. Hysteresis: it stays until usage drops below 75 %.

## Contextual tips

devup surfaces a one-liner in the project header in three teachable moments:

- More than 1000 log lines and no active search → "tip: press / to search in logs"
- More than 500 log lines and no active service filter → "tip: press f to filter logs by service"
- At least one service in crash-loop → "tip: press r to restart, or check the log of the failing service"

Each tip shows at most once per session and auto-clears after 12 s. They're meant as gentle nudges, not nagging — once you've seen one, it's gone.

## What devup does on quit

- `q` or `Ctrl+C` triggers cleanup.
- Every spawned process gets a `kill -<pid>` (process-group kill on Unix, `taskkill /T /F` on Windows).
- devup waits up to 3 s for the processes to exit.
- After that grace, sends SIGKILL to anything still alive.
- Lazy proxies are destroyed (TCP sockets closed, pending clients disconnected).
- External `stopCmd`s are run (best-effort, 10 s cap each).
- Unix socket control plane is closed (the socket file is removed).
- Log file streams are flushed and closed.
- Then `process.exit(0)`.

If something is misbehaving and devup itself hangs during cleanup, hit `Ctrl+C` again — Node's default handler will force-exit.

## Resizing the terminal

devup listens for the `resize` event and recomputes the panel heights. The split is fixed at ~65/35 (logs/stats). For a very short terminal (less than ~12 rows) the panels still render but most stats may not be visible at once — use `↑`/`↓` to scroll.

## Not-TTY mode

If devup is launched without a real TTY (piped output, CI) the TUI doesn't render. Use `--once` for a controlled boot+exit cycle or the standalone subcommands (`devup logs`, `devup status`) instead.
