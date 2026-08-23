/** Regenerate contract/status-snapshot.json. Deliberately a separate entry
 *  point: doing it from inside the golden test means the test can compare the
 *  fixture against itself and never fail. */
import { writeFileSync } from 'node:fs';
import { CONTRACT_FIXTURE_PATH } from '../tests/contract-path.js';
import { buildContractSnapshot } from '../src/control-plane/contract-fixture.js';

writeFileSync(CONTRACT_FIXTURE_PATH, JSON.stringify(buildContractSnapshot(), null, 2) + '\n');
console.log(`wrote ${CONTRACT_FIXTURE_PATH}`);
console.log('This is an API change. Update, in the same commit:');
console.log('  - docs/control-plane.md');
console.log('  - gachlab/devup-vscode (src/types.ts, src/socket-client.ts)');
console.log('  - CONTRACT_VERSION in src/control-plane/types.ts, if the shape a client sees changed');
