/** The package's library entry — what `import … from '@gachlab/devup'` loads.
 *
 *  Side-effect free on purpose. It used to be the CLI bundle itself: a config
 *  file importing `defineConfig` pulled in React, Ink and the whole CLI just to
 *  get an identity function, and only a guard on `argv[1]` kept it from
 *  starting a second devup. The CLI is `index.ts`, built as the `devup` bin. */
export { defineConfig } from './config/types.js';
export type { DevStackConfig, ServiceConfig, LazyConfig, ProxyConfig } from './config/types.js';
export type { Platform, ProcessStats } from './platform/types.js';
export type { ProxyConfigProvider, ProxyOpts } from './proxy-config/types.js';
