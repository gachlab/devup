import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONTRACT_FIXTURE_PATH } from '../../contract-path.js';
import { buildContractSnapshot } from '../../../src/control-plane/contract-fixture.js';

/** Golden test for the `status` wire shape.
 *
 *  The snapshot is defined twice — here, and again by hand in
 *  gachlab/devup-vscode, which deliberately does not depend on this package at
 *  runtime. Nothing else keeps the two honest: `docs/control-plane.md` once
 *  described `port` as "from config", the extension believed it, and shipped a
 *  release connecting to the wrong port.
 *
 *  Regenerate with `npm run contract:update` — a separate entry point on
 *  purpose, so this test can never write the file it is checking.
 */
describe('control-plane contract', () => {
  const golden = JSON.parse(readFileSync(CONTRACT_FIXTURE_PATH, 'utf8'));
  // Through JSON: `undefined` values vanish in the file but survive in the
  // object, and strict deepEqual treats `{ a: undefined }` and `{}` as
  // different — which would make a regenerated fixture fail the test that
  // wrote it, with no way out of the loop.
  const current = JSON.parse(JSON.stringify(buildContractSnapshot()));

  it('matches contract/status-snapshot.json', () => {
    assert.deepEqual(
      current, golden,
      'the status wire shape changed — run `npm run contract:update`, then update ' +
      'docs/control-plane.md and gachlab/devup-vscode to match',
    );
  });

  it('keeps the two ports distinguishable', () => {
    // The whole reason the fixture exists: `port` is where the process listens,
    // `originalPort` is where the proxy does and what a client must connect to.
    const auth = golden.services.find((s: { name: string }) => s.name === 'authorization-api');
    assert.equal(auth.port, 13002);
    assert.equal(auth.originalPort, 3002);
  });

  it('reports both ports identically for an always-on service', () => {
    const cfg = golden.services.find((s: { name: string }) => s.name === 'configurations-api');
    assert.equal(cfg.port, cfg.originalPort, 'clients rely on this to avoid a version check');
  });

  it('only pins states the daemon can actually produce', () => {
    for (const s of golden.services) {
      // Both idle transitions null `pid` and `startedAt` together. A fixture
      // showing a timestamp on a stopped service would teach clients that
      // `startedAt != null` means running.
      if (s.pid === null) {
        assert.equal(s.startedAt, null, `${s.name}: startedAt must be null when pid is`);
      }
    }
  });

  it('pins crashLog as an array, not only as null', () => {
    // Otherwise a client generating a type from the fixture infers `null` and
    // never learns the field carries lines.
    const withLog = golden.services.filter((s: { crashLog: unknown }) => Array.isArray(s.crashLog));
    assert.ok(withLog.length > 0, 'no entry exercises a populated crashLog');
    assert.ok(withLog.every((s: { crashLog: string[] }) => s.crashLog.every(l => typeof l === 'string')));
  });

  it('includes proxy — status returns { services, proxy }, not just services', () => {
    assert.ok(golden.proxy, 'a client validating a real status result would see an unexpected key');
    for (const k of ['active', 'provider', 'domain', 'tls', 'routes']) {
      assert.ok(k in golden.proxy, `proxy.${k} missing — ProxyInfo drift would go unnoticed`);
    }
  });

  it('pins debugPort as a number, not only as null', () => {
    const withPort = golden.services.filter((s: { debugPort: unknown }) => typeof s.debugPort === 'number');
    assert.ok(withPort.length > 0, 'no entry runs under the inspector');
    assert.ok(withPort.every((s: { debugPort: number }) => s.debugPort > 0 && s.debugPort <= 65535));
  });
});
