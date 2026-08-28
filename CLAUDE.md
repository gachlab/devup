# Working on devup

Recurring hazards in this codebase, each one found the hard way. Check them
before opening a PR, and check them again when reviewing one.

## 1. Removing a service: what else is keyed by its name?

`state` is not the only place a service lives. Every one of these outlived a
`remove()` at some point and brought the service back **after** clients were
told it was gone:

| owner | why it matters |
|---|---|
| `lazyProxies` | listens on the **public** port — one connection re-runs `onDemandStart` |
| `Restarter.pending` | a 2/4/8 s timer whose `spawner.start` re-inserts into `state` |
| `HealthPoller.failureCounts` | inherited by a service re-added under the same name |
| `prevCpuMap` / `prevCpu` | stale baseline makes the next `stats` sample report a large negative CPU |
| an **in-flight health probe** | `checkAll` awaits mid-iteration; writing the result afterwards emits `status` *after* `removed` |

When adding any per-name map or timer, add its release to `ProcessManager.remove()`
or to `onServiceRemoved`. Tear down anything holding a **port** *before*
announcing the removal, never after.

## 2. `pid` is never cleared

`Spawner`'s close handler returns early on an intentional stop and otherwise
only touches `status`/`health`. **A stopped or crashed service keeps a dead
`pid`.** Never use `st.pid` as a liveness test — it silently makes the branch
a permanent no-op. Check the child process (`exitCode`/`signalCode`) instead.

## 3. A lazy service's `port` is not its configured port

`rewriteServicePort` sets `port = port + LAZY_PORT_OFFSET` and runs the service
there, keeping the proxy on the configured port, which survives as
`originalPort`. Anything that **connects** wants `originalPort`; anything that
attaches a debugger or reads the service's own logs wants `port`.

Do not derive one from the other by subtracting the offset: **lazy mode is
opt-in**, so with it off every port is already real and a service configured on
`18080` would be mangled into `8080`.

## 4. The control-plane contract lives in three places

`src/control-plane/types.ts`, `docs/control-plane.md`, and a **hand-written
copy** in gachlab/devup-vscode (`src/types.ts`, `src/socket-client.ts`).
Nothing keeps the last one honest — see issue #87.

It used to be six: `RestartOutcome`, `DebugResult`, `SwitchResult` and two row
types in `subcommands.ts` were each declared a second time inside this repo,
and `RpcContext.restart` declared its own shape by hand — without
`skippedRemote`, the field a contract bump had just been made for. Those are
now aliases of the wire type, so the compiler carries one declaration to the
socket. **Do not reintroduce one.** A copy compiles fine and fails at the far
end, which is the whole failure mode.

Changing the snapshot shape means changing all three. The doc has been wrong
before (`port: from config`, and a "No notifications" section written years
after `status.follow` shipped), and the extension shipped a broken release
because it trusted it.

The types are now public as `@gachlab/devup/client`, so the extension's copy
*could* go away — until it does, it is still a copy, and still drifts.

A new subpath export needs **two** edits, not one: the `exports` map in
`package.json` *and* an entry in `tsup.config.ts`. `tsc --emitDeclarationOnly`
writes a `.d.ts` for every file under `src/`, but tsup only bundles the entries
it is given — so a missing entry type-checks fine in the consumer and fails at
runtime with a missing file. That is how `dist/control-plane/client.d.ts`
shipped for releases with no `client.js` beside it.

## 5. `tests/` is typechecked now — keep it that way

It was excluded, and 36 stale fakes had accumulated by the time it was turned
on: an `RpcContext` missing two methods, `ProcessState` fakes without
`crashLog`, a `ProxyOpts` with a key the type does not have. `npm run
typecheck` runs both projects; CI runs it.

The trap that let them rot, because it looks harmless: a helper written as

```ts
function mkState(over: Partial<ProcessState>): ProcessState {
  return { ...base, ...over };   // ← every member becomes optional
}
```

type-checks with an **incomplete** base. `Object.assign(base, over)` with
`base` annotated does not.

The helpers that fake the shapes most likely to gain a field — `RpcContext`,
`ServiceSnapshot`, `ProcessState` in the poller and lifecycle tests — use the
second form. Plenty of others still use the spread, and each one is a fixture
that will not notice its type growing. **Convert the one you touch.**

## 6. Verify every new test by mutation

Break the fix, run the test, confirm it **fails**, restore. Three tests written
in a single session looked fine and could not fail:

- ports in the fixture were all four digits, so a broken numeric sort still passed;
- `health` was asserted against `'down'`, which `deriveHealth` never returns while status is `'starting'`;
- the default `failureThreshold` of 2 meant one failed probe changed nothing to assert on.

The sharpest case so far did not look like a broken test at all: the golden
contract fixture wrote `port: 13002, originalPort: 3002` as **literals**, so
changing `LAZY_PORT_OFFSET` did not fail the one test that exists to catch wire
drift. It is built from `rewriteServicePort` now. A fixture assembled by hand
is a test that cannot notice the code changing under it.

## 7. Docs drift here

`ROADMAP.md` calls itself "the source of truth" and has listed shipped features
as `proposed` for several releases. `docs/` is otherwise good, so it gets
trusted — which is what makes a wrong line expensive.

An architecture review in 0.19.2 found **eleven** such lines at once, and the
pattern is worth knowing: they were all places where the code moved *forward*
and the sentence stayed. `architecture.md` claimed strict mode that was off,
described a `ProcessManager` god-class that had already been split, listed five
control-plane methods out of twelve, and omitted `remote/` entirely. None was
wrong when written.

So: when a change makes a documented sentence false, the sentence is part of
the change. Grepping `docs/` for the thing you just renamed is cheaper than
being believed.
