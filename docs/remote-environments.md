# Remote environments

Run part of the stack here and let the rest answer from QA — without touching
a line of any service's configuration.

## The problem

A service that is not started is simply absent. With `--profile check-in`, the
other twenty APIs hold no port at all, and the frontend that calls them gets
`ECONNREFUSED`. The choices today are to run all of them, with a local database
loaded with data, or to reconfigure the frontend to point somewhere else.

`--remote` adds the state in between: **a service that does not run here, but
answers here.** devup binds its configured port and forwards to a named
environment. Nothing else in the stack has to know — not the other services,
not the frontend, not the reverse proxy.

```
devup --profile check-in --remote qa
```

`check-in-api`, `guestapp-api` and `guestapp-web` run locally. Everything else
is served from QA, on the same ports it would have used locally.

## Why the port is the point of cut

Frontends resolve their backends at runtime, and in development they resolve
them to `localhost`:

```ts
// app/web/src/environments/environment.ts
BACKENDCHECKIN: {
  DOMAIN: window.location.hostname.includes("localhost")
    ? "localhost:3050"
    : "qa.norelian.com",
}
```

Bind `:3050` and that code keeps working unchanged. The alternative — an
`environment.qa.ts` — usually flips `production: true` along with the URL, so
pointing at QA costs sourcemaps and the development build.

## Configuration

```ts
export default defineConfig({
  // ...
  environments: {
    qa: {
      domain: 'qa.norelian.com',
      origin: 'https://qa.norelian.com',
      cookies: 'localize',
      location: 'localize',
    },
  },
});
```

| field | type | default | meaning |
|---|---|---|---|
| `domain` | `string` | | Host per service is `proxy.routes[name]` + this domain |
| `targets` | `Record<string,string>` | | Absolute URL per service. Wins over `domain` |
| `tls` | `boolean` | `true` | Scheme for hosts built from `domain` |
| `tlsVerify` | `boolean` | `true` | Verify the upstream certificate |
| `origin` | `string` | | What to send as `Origin`/`Referer`, and restore in CORS |
| `host` | `'target' \| 'passthrough'` | `'target'` | `Host` sent upstream |
| `forwarded` | `boolean` | `false` | Send `X-Forwarded-*` with the local values |
| `headers.set` | `Record<string,string>` | | Request headers. `${VAR}` from the environment |
| `headers.remove` | `string[]` | | Request headers to drop |
| `cookies` | `'localize' \| 'passthrough'` | `'localize'` | `Set-Cookie` handling |
| `location` | `'localize' \| 'passthrough'` | `'localize'` | Redirect handling |
| `readOnly` | `boolean` | `false` | Refuse writes with 405 |
| `timeoutMs` | `number` | `30000` | Upstream request timeout |
| `healthCheck` | object | | `path`, `expect`, `intervalMs`, `timeoutMs` |

### Targets come from `proxy.routes`

A stack that already generates a Traefik/Nginx/Caddy config has the map
written down: `proxy.routes` holds the subdomain per service, and those are the
same subdomains the deployed frontends call. One `domain` line covers the whole
stack. A service that is not in `proxy.routes` needs an entry in `targets`, or
devup reports it as unreachable rather than leaving it silently down.

## Headers, and why they are not cosmetic

### `origin` may select the database

An upstream can resolve a tenant from the request headers:

```js
// backend/server/src/util/resolveHostname.js
const sources = [headers.origin, headers.referer, headers['x-forwarded-host']];
```

From `localhost:4200` none of those match a registered domain, so the lookup
returns nothing and the request never reaches a database. Setting `origin` to a
real frontend host of that environment is what makes it work:

```ts
environments: {
  qa: {
    targets: { backend: 'https://api.qa.inprovider.cl' },
    origin: 'https://demoa.app.inprovider.cl',   // picks the tenant
  },
}
```

devup sends `Origin` on **every** request once it is configured, including
requests that arrived without one — upstreams that index on the origin often do
so without checking it is there at all.

### Rewriting `Origin` also rewrites the CORS reply

An upstream that echoes the origin it was given answers with the *rewritten*
one, and a browser on localhost rejects a reply that allows somebody else. Both
halves are driven from the single `origin` option so they cannot drift apart.
A response already allowing `*` is left alone.

### `X-Forwarded-*` is off by default

This looks like the wrong default until you see the fallback chain above:
filling `x-forwarded-host` with the local host either matches nothing or
selects the wrong tenant, without a word. devup also **drops** inbound
forwarded headers when the option is off, because a local reverse proxy sets
them to local hosts. An environment that needs one can set it explicitly
through `headers.set`, which is applied last.

### Cookies

A session cookie from a remote environment usually looks like this:

```
Set-Cookie: access_token=…; Domain=.qa.norelian.com; Path=/; HttpOnly; Secure; SameSite=Strict
```

A browser on `http://localhost:4201` drops it twice over: the domain is not the
one it is on, and `Secure` withholds it from a plain-http page. `localize`
removes both. `HttpOnly`, `Path`, `Max-Age` and `SameSite=Strict` survive —
same-site does not look at the port.

`SameSite=None` is dropped along with `Secure`, since the two are only valid
together; it becomes `Lax`.

### Redirects

`localize` rewrites a redirect pointing at **any** environment origin this run
serves, not only the service's own. A login answers with a 302 to the app, not
to itself, and a redirect left pointing at the environment walks the browser
out of the local stack exactly when it is carrying a fresh session. A host
devup does not serve — an identity provider, say — is left untouched.

## Writes reach the environment

`--remote` sends requests from your machine into a shared environment. A `POST`
changes data everyone else on that environment is looking at, and a flow that
sends mail — a password recovery, an invitation — sends real mail, to real
addresses, with links built from the origin devup was told to send.

devup does not make this quiet:

- a boot banner naming every remote service and the environment it points at,
- a second line listing the ones that accept writes,
- a permanent marker in the TUI.

`readOnly: true` refuses everything other than `GET`, `HEAD` and `OPTIONS` with
405. It is **off** by default on purpose: logging in is a `POST`, so a
restrictive default breaks the first thing anyone tries and teaches them to
turn it off without reading why.

## What a remote service looks like

It is an ordinary entry in the status snapshot, with `status: 'running'`,
`pid: null`, and a `remote` field naming the environment and target. Health
comes from a probe against the environment (every 30 s by default), not from
the port — devup's own proxy holds that port, so a check there would report a
healthy service no matter what the environment is doing.

An environment that answers `401` to an unauthenticated probe counts as
reachable. Only a response that never arrives is `down`.

`errors` counts requests that never reached the environment. A `500` that came
back is the service's own business and is not counted.

## Precedence

- `--remote qa` — the blanket form. Everything the local selection did not pick
  becomes remote; the profile wins.
- `--remote qa:app-api,rules-api` — the explicit form. Those are remote even if
  a profile names them.
- `--skip x` with `--remote` makes `x` remote rather than absent. "Not running
  it here" is what skipping has always meant; what changes is its port.
- A remote service is never also lazy. The remote proxy binds the configured
  port, which is the port a lazy proxy would want.

## Logs

A remote service writes no stdout, so devup logs one line per request:

```
GET /api/v1/requests?page=2 → 200 (312ms)
❌ POST /login → upstream timeout after 30000ms
```

Values of secret-looking query parameters (`*token*`, `*password*`, `*secret*`,
`*api_key*`, `*auth*`, `code`) are replaced with `***` before the line reaches
`~/.devup/logs`. Parameter names are kept: knowing a token was present is what
makes the line worth reading.

## Not covered

- **Response bodies are not rewritten.** APIs return absolute URLs of the
  environment, and those resolve fine from the browser. Rewriting them means
  recomputing `Content-Length` and breaking streaming for very little.
- **Non-HTTP upstreams.** A remote Mongo or Redis is raw TCP; that is the lazy
  relay's shape, not this one.
