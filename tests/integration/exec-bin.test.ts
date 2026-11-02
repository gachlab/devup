import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, '..', '..', 'src', 'index.ts');
const fixtures = join(__dirname, '..', 'fixtures');
const isUnix = process.platform === 'linux' || process.platform === 'darwin';

const findFreePort = () => new Promise<number>(resolve => {
  const s = net.createServer();
  s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

function devup(cwd: string, args: string[], timeout = 120_000) {
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), entry, ...args], {
    cwd, encoding: 'utf8', timeout, env: { ...process.env, HOME: cwd, NODE_NO_WARNINGS: '1' },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('devup exec through the real bin', { skip: !isUnix }, () => {
  it("boots a stack with exec's own flags, which the daemon child must not reject", { timeout: 150_000 }, async () => {
    // The child is handed its parent's argv, `--fail-on-crash` and
    // `--wait-timeout` included; rejecting them as unknown meant exec waited
    // 90 s for a daemon that had already exited, and never ran the command.
    const dir = mkdtempSync(join(tmpdir(), 'dvb-'));
    const port = await findFreePort();
    writeFileSync(join(dir, 'devup.config.json'), JSON.stringify({
      name: 'eb',
      services: [{
        name: 'api', cwd: '.', cmd: 'node', args: [join(fixtures, 'dummy-server.cjs'), String(port)],
        type: 'api', port, phase: 0, readyPattern: 'listening:',
      }],
    }));
    const r = devup(dir, ['exec', '--fail-on-crash', '--wait-timeout', '60', '--', process.execPath, '-e', 'console.log("RAN")']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /RAN/);
  });
});
