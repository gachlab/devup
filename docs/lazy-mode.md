# Lazy mode

Lazy mode is devup's answer to "I have 30 services but I only work on 5 today". Instead of booting everything at startup, services in lazy mode stay idle until something tries to connect to them. They shut down on idle and re-spawn on the next connection.

## How it works

When you launch with lazy mode (the default if `lazy` is set in your config), for every service NOT in `lazy.alwaysOn`:

1. devup binds a TCP listener on the service's **public port** (`svc.port`).
2. The actual service is spawned later, on demand, on **`svc.port + 10000`** (the "real port").
3. On the first incoming connection to the public port:
   - devup runs `npm install` if needed.
   - Spawns the service on the real port.
   - Waits for it to listen.
   - Pipes the pending connection (and any others queued during boot) through to the real port.
4. The TCP proxy keeps tunnelling traffic between the public port and the real port.
5. After `timeout` minutes with no active connections AND no recent activity, the service shuts down and returns to idle — the proxy stays bound, ready for the next connection.

   **Exception: a service under the debugger never idle-stops.** A service paused on a breakpoint receives no traffic by definition, and stopping it would end the debugging session. Note that this pins the service up until the debug flag is turned off (`devup ctl debug <svc> --off`) or the process dies: Node keeps its inspector listening after a debugger detaches, so there is no signal for "nobody is debugging me any more".

```
              Client                          Devup proxy                     Real service
  --:3000 ─────────────────────────────────►  :3000  ────────────────────►   :13000
                                              (always listening)              (spawned on demand)
```

Services listed in `lazy.alwaysOn` skip the proxy entirely and start normally on `svc.port`.

## Config

```typescript
export default defineConfig({
  // ...
  lazy: {
    alwaysOn: ['config-api', 'app-web'],
    timeout: 10,  // minutes
  },
});
```

- **`alwaysOn`** is required. Put your gateway / entry-point services here so they're always reachable.
- **`timeout`** is optional, default 10 minutes. Set to a small number (`1` or `2`) for fast hardware; a higher number reduces respawn churn.

## Idle timeout details

The timeout is not "kill after N minutes since spawn". It's "kill after N minutes of no activity":

- Active connections **prevent** idle expiration. A long-lived WebSocket or SSE stream keeps the service alive even if no new connections come in.
- Idle check fires after the timeout expires; if there's been any traffic since the last check (data flowing through the proxy), it reschedules instead.

This is intentional: a service handling a long-running upload or stream shouldn't get killed mid-flight just because the timer popped.

## Disable lazy for a single boot

```bash
devup --no-lazy
```

Boots every service immediately, ignoring `lazy.alwaysOn`. Useful when you actually need everything running (full integration tests, profiling, etc.).

## Override the timeout

```bash
devup --timeout 30
```

Useful for long debugging sessions when you don't want the service you're poking at to die between requests.

## Combining with profiles

`--profile` and `--lazy` compose naturally: a profile selects which services exist for this run, `lazy` selects which start immediately vs on-demand among them.

```bash
devup --profile check-in   # picks check-in services from config; lazy still applies to non-alwaysOn ones
```

See [Profiles](./profiles.md).

## Troubleshooting

### "Connection refused" on a lazy service

devup writes a log line `⚡ on-demand start` when the first connection arrives. If you don't see it:

- The proxy may not have bound the port. Check the boot log for the lazy proxy registration.
- Confirm the service is actually in lazy mode (not listed in `alwaysOn`) by running `devup --dry-run` and looking at the `Lazy (on-demand):` section.

### Service takes very long to first-respond

The lazy proxy buffers the incoming connection until the service is ready. First requests can take seconds while the service compiles, runs migrations, etc. Look at the service's own log to see what's happening. Use [`readyPattern`](./health-checks.md) and [`healthCheck.startPeriod`](./health-checks.md) to give the boot enough breathing room.

### Service gets killed mid-stream

This was a real bug in early versions and is now fixed: the idle timer respects active connections. If you still see it, file an issue with the lazy proxy log lines.

### I want lazy but the service must NEVER restart

Set `lazy.timeout` to something high (`60 * 24` = one day). Or move the service to `alwaysOn`.

## Port collisions

If `svc.port + 10000` collides with another service's port, devup catches it at config-load time and refuses to boot. Example: you have `port: 3000` and another at `port: 13000` — the lazy real port of the first would conflict with the second. Renumber.

## Programmatic implications

When devup writes the reverse-proxy config (Traefik, Nginx, Caddy), lazy services use their **real port** (`port + 10000`) as the upstream so the proxy talks directly to the service, not through devup's TCP relay. devup's TCP proxy stays bound on the public port for local clients that don't go through the reverse proxy.
