import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, '..', '..', 'src', 'index.ts');
const fixtures = join(__dirname, '..', 'fixtures');
const isUnix = process.platform === 'linux' || process.platform === 'darwin';

function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

function devup(cwd: string, home: string, args: string[], timeout = 120_000) {
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), entry, ...args], {
    cwd, encoding: 'utf8', timeout,
    env: { ...process.env, HOME: home, NODE_NO_WARNINGS: '1' },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Every file under `dir`, read and concatenated: the daemon's own log lives
 *  somewhere under ~/.devup/logs and its exact layout is not what is tested. */
function readTree(dir: string): string {
  let out = '';
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out += statSync(p).isDirectory() ? readTree(p) : readFileSync(p, 'utf8');
  }
  return out;
}

describe('a bare --remote', () => {
  it('is rejected, not treated as an ordinary local boot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-remote-bare-'));
    writeFileSync(join(dir, 'devup.config.json'), JSON.stringify({
      name: 'bare-remote',
      services: [{ name: 'api', cwd: '.', cmd: 'node', args: [], type: 'api', port: 41010, phase: 0 }],
    }));
    const r = devup(dir, dir, ['--dry-run', '--remote']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /--remote needs an environment name/);
  });
});

describe('--config in another directory, through the daemon', { skip: !isUnix }, () => {
  it('up -d boots, --watch-config finds the config, and exec runs in the shell cwd', { timeout: 180_000 }, async () => {
    // Before: the daemon child ran from the project dir and re-resolved the
    // relative `--config` from there (stack/stack/devup.config.json), the
    // watcher did the same, and `exec` ran its command in the project dir.
    const home = mkdtempSync(join(tmpdir(), 'dvx-'));
    const shellDir = realpathSync(home);
    const port = await findFreePort();
    mkdirSync(join(home, 'stack', 'apps', 'api'), { recursive: true });
    writeFileSync(join(home, 'stack', 'devup.config.json'), JSON.stringify({
      name: 'ew',
      services: [{
        name: 'api', cwd: 'apps/api', cmd: 'node',
        args: [join(fixtures, 'dummy-server.cjs'), String(port)],
        type: 'api', port, phase: 0, readyPattern: 'listening:',
      }],
    }));
    const cfg = ['--config', 'stack/devup.config.json'];
    try {
      const up = devup(home, home, ['up', '-d', '--watch-config', ...cfg]);
      assert.equal(up.code, 0, up.out);

      const ex = devup(home, home, ['exec', ...cfg, '--', process.execPath, '-e', 'console.log("CWD=" + process.cwd())']);
      assert.equal(ex.code, 0, ex.out);
      assert.match(ex.out, new RegExp(`CWD=${shellDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`));

      const logs = readTree(join(home, '.devup', 'logs'));
      assert.match(logs, /👀 watching .*stack\/devup\.config\.json/);
      assert.doesNotMatch(logs, /watch-config disabled/);
    } finally {
      devup(home, home, ['down', ...cfg], 30_000);
    }
  });
});
