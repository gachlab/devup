import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONTRACT_FIXTURE_PATH } from '../../contract-path.js';
import { buildContractSnapshot } from '../../../src/control-plane/contract-fixture.js';
import { CONTRACT_VERSION } from '../../../src/control-plane/types.js';

/** What each contract number means, field by field.
 *
 *  The reminder printed by `npm run contract:update` is not enforcement: a
 *  shape change regenerates the fixture, the golden test passes against the
 *  file it just wrote, and the release ships with a stale `contract`. That is
 *  the one failure mode that makes the number **worse than not having it** —
 *  a client trusts it and reads a field that is not there.
 *
 *  So the shape is recorded here against the number that describes it. Adding
 *  or renaming a field fails this test until `CONTRACT_VERSION` moves and the
 *  new shape is written down, which is also how anyone later finds out what
 *  contract 1 actually was. */
const SHAPE_BY_CONTRACT: Record<number, string[]> = {
  1: [
    'name', 'status', 'health', 'port', 'originalPort', 'type', 'phase',
    'cmd', 'cwd', 'errors', 'restarts', 'crashes', 'pid', 'startedAt',
    'crashLog', 'debugPort',
  ],
  2: [
    'name', 'status', 'health', 'port', 'originalPort', 'type', 'phase',
    'cmd', 'cwd', 'errors', 'restarts', 'crashes', 'restartPendingIn',
    'pid', 'startedAt', 'crashLog', 'debugPort',
  ],
};

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
/** Every result shape a client can see, and therefore everything
 *  `CONTRACT_VERSION` speaks for. Adding one means deciding whether the number
 *  has to move. */
const RESULT_SHAPES = {
  ServiceSnapshot: true,
  ProjectInfo: true,
  StatsResult: true,
  LogsTailResult: true,
  LogsFollowAck: true,
} as const;

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

  it('carries the field list the contract number promises', () => {
    const expected = SHAPE_BY_CONTRACT[CONTRACT_VERSION];
    assert.ok(
      expected,
      `CONTRACT_VERSION is ${CONTRACT_VERSION} and nothing here says what that means. ` +
      'Add its field list to SHAPE_BY_CONTRACT.',
    );
    for (const svc of golden.services) {
      assert.deepEqual(
        Object.keys(svc).sort(), [...expected!].sort(),
        `the snapshot shape changed — bump CONTRACT_VERSION and record the new field list, ` +
        'or clients reading `contract` will trust a number that no longer describes them',
      );
    }
  });

  it('records what the contract number covers, not just the snapshot', () => {
    // The number describes the wire, and the wire is more than
    // `ServiceSnapshot`: `logs.tail`'s result changed in 0.16.0 and this test
    // said nothing, because it only knew about the snapshot. Listing the
    // shapes here is what makes "bump it in the same commit" checkable.
    const covered = Object.keys(RESULT_SHAPES).sort();
    assert.deepEqual(covered, ['LogsFollowAck', 'LogsTailResult', 'ProjectInfo', 'ServiceSnapshot', 'StatsResult'],
      'a wire shape was added or removed without saying which contract covers it');
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

  it('pins restartPendingIn as a number, not only as null', () => {
    // A fixture where it is always null teaches a client the wrong half of the
    // field. The pinned value is `0` — the overdue edge — and deliberately so:
    // `serializeState` clamps against `Date.now()`, so any *future* timestamp
    // in the fixture would make the golden file change by the second. `0` is
    // the only number this can reproducibly hold; that a live pending restart
    // serialises to its real remaining milliseconds is pinned by the
    // socket-server test instead.
    const numeric = golden.services.filter((s: { restartPendingIn: unknown }) => typeof s.restartPendingIn === 'number');
    assert.ok(numeric.length > 0, 'no entry pins it as a number at all');
  });

  it('pins crashes as a number that has actually moved', () => {
    // A fixture where every entry reads 0 teaches a client the field is
    // decorative, which is the opposite of what `--fail-on-crash` needs.
    const moved = golden.services.filter((s: { crashes: number }) => s.crashes > 0);
    assert.ok(moved.length > 0, 'no entry has ever crashed');
  });

  it('keeps crashes and restarts distinguishable', () => {
    // `restarts` is a budget that a manual restart resets; `crashes` only goes
    // up. A fixture where they always agree would let a client use either.
    const differing = golden.services.filter((s: { crashes: number; restarts: number }) => s.crashes !== s.restarts);
    assert.ok(differing.length > 0, 'nothing distinguishes the budget from the history');
  });

  it('pins debugPort as a number, not only as null', () => {
    const withPort = golden.services.filter((s: { debugPort: unknown }) => typeof s.debugPort === 'number');
    assert.ok(withPort.length > 0, 'no entry runs under the inspector');
    assert.ok(withPort.every((s: { debugPort: number }) => s.debugPort > 0 && s.debugPort <= 65535));
  });
});
