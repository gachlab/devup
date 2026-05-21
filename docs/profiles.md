# Profiles

A profile is a named subset of services. Instead of memorising and typing the service names every session, you save common workflows under a name in the config and select them with `--profile`.

## Why profiles

Big monorepos have a lot of services. Devs usually work on a small subset at a time. Without profiles you'd type:

```bash
devup --services configurations-api,authorization-api,app-api,check-in-api,app-web
```

…every time. Easy to forget one, easy to leave one out that's actually needed.

With profiles:

```bash
devup --profile check-in
```

## Config

```typescript
export default defineConfig({
  // ...
  profiles: {
    'check-in': [
      'configurations-api',
      'authorization-api',
      'app-api',
      'check-in-api',
      'app-web',
    ],
    'pickup': [
      'configurations-api',
      'pickup-api',
      'pickup-drivers-web',
    ],
    'frontends': ['app-web', 'admin-web', 'staff-web'],
  },
});
```

Each profile is a `name → string[]` entry. Profile names are free-form (anything that's a valid object key); the values must be existing service names.

The validator checks every entry at config-load time:

- Profile references to non-existent services → error (config refuses to load)
- Empty arrays → error
- Otherwise: ok

## Usage

```bash
devup --profile check-in
```

Equivalent to `--services configurations-api,authorization-api,...`. Composable with `--skip`:

```bash
devup --profile check-in --skip app-web
```

`--profile` takes precedence over `--services` and `--only` if both are specified.

## Unknown profile names

```bash
$ devup --profile mystery
❌ Unknown profile: "mystery". Available: check-in, pickup, frontends
```

The error message lists every profile defined in your config so typos are easy to spot.

If no profiles are defined in config:

```bash
$ devup --profile anything
❌ Unknown profile: "anything". No profiles defined in config.
```

## Composition with lazy mode

Profiles **select which services exist** for this run. Lazy mode selects **which start immediately vs on-demand** among those.

```typescript
export default defineConfig({
  services: [/* ... */],
  profiles: {
    'check-in': [
      'configurations-api', 'authorization-api', 'app-api',
      'check-in-api', 'app-web',
    ],
  },
  lazy: {
    alwaysOn: ['configurations-api', 'app-web'],  // gateway + UI
  },
});
```

`devup --profile check-in`: 5 services. `configurations-api` and `app-web` boot immediately. The rest (`authorization-api`, `app-api`, `check-in-api`) sit lazy until something hits them.

Services in `alwaysOn` that aren't part of the selected profile are simply excluded — `alwaysOn` is a hint, not a requirement.

## Profiles you may want to define

- `frontends-only` — every web, no APIs (works against a remote dev API)
- One per team / feature area (`payments`, `notifications`, `admin`)
- `minimal` — just the gateway + one or two services for benchmarks / profiling
- `full` — everything (just for the rare full-stack day; or use no `--profile` at all)

## Limitations

- Profiles are flat: you can't have one profile `extends` another. If profiles share a long common prefix, that's just config duplication for now. Open an issue if this gets painful.
- No "auto-detect from cwd" — devup doesn't try to guess which profile to use based on which directory you ran from.
- `external` services (DBs etc.) are not per-profile; they always start.
