import { defineConfig } from 'tsup';

const shared = {
  format: ['esm'] as const,
  dts: false,
  sourcemap: true,
  target: 'node22' as const,
};

// Two builds, not one multi-entry build, because the banner is per-build:
// `#!/usr/bin/env node` belongs on the CLI and not on a library entry point.
//
// Neither cleans. tsup runs the two configs concurrently, so a `clean: true`
// on either one races the other's output — `dist/control-plane/client.js`
// would vanish depending on which finished first. The `clean` npm script does
// it once, before both.
export default defineConfig([
  {
    ...shared,
    entry: ['src/index.ts'],
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    // Published as `@gachlab/devup/client`. Keep the output path in step with
    // the `exports` map in package.json and with `tsc --emitDeclarationOnly`,
    // which puts the .d.ts alongside it.
    ...shared,
    entry: { 'control-plane/client': 'src/control-plane/client.ts' },
  },
]);
