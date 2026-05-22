// Re-export façade. The actual implementations live in src/utils/* — split
// from one big junk-drawer into focused modules in #52.
//
// New code should prefer importing from the specific submodule
// (`../utils/format.js`, `../utils/search.js`, etc.) for clarity. This
// file exists so existing imports of `../utils.js` keep working.

export { parseEnvFile } from './utils/env.js';
export { fmtUptime } from './utils/format.js';
export { compileSearchPattern, detectLogLevel } from './utils/search.js';
export type { SearchMatcher, LogLevel } from './utils/search.js';
export { redactSecrets } from './utils/redact.js';
export { needsInstall, writeInstallStamp } from './utils/install-stamp.js';
export { buildProcessArgs, buildProcessEnv } from './utils/process-args.js';
export { sortServiceNames, calcCpuPercent, nextRamBannerVisibility } from './utils/stats.js';
export { groupByPhase } from './utils/phases.js';
export { tagColors } from './utils/colors.js';
