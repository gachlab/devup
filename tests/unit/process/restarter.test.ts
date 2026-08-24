import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Restarter } from '../../../src/process/restarter.js';
import { MAX_RESTARTS, BACKOFF_BASE_MS } from '../../../src/process/internals.js';
import type { ProcessState, ProcessManagerEvents } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const svc: ServiceConfig = { name: 'api', cwd: '.', cmd: 'node', args: [], type: 'api', port: 3000, phase: 0 };

function mkState(over: Partial<ProcessState> = {}): ProcessState {
  return {
    svc, proc: null, pid: null, status: 'crashed', health: 'down',
    errors: 0, restarts: 0, startedAt: null, intentionalStop: false, colorIdx: 0, crashLog: null,
    ...over,
  };
}

function mkRestarter(state: Map<string, ProcessState>, startImpl?: (s: ServiceConfig) => Promise<void>) {
  const started: string[] = [];
  const changes: string[] = [];
  const events: ProcessManagerEvents = { onLog: () => {}, onStateChange: (n) => changes.push(n) };
  const restarter = new Restarter({
    state, events,
    spawner: {
      start: async (s: ServiceConfig) => { started.push(s.name); if (startImpl) await startImpl(s); },
    } as never,
    lifecycle: { stop: () => {} } as never,
  });
  return { restarter, started, changes };
}

describe('Restarter publishes when the next attempt is due', () => {
  it('sets restartPendingUntil when it schedules one', () => {
    // The field exists so a client can tell "out of restart budget" from
    // "eight seconds from coming back" — `restarts` reaches its maximum
    // *before* the last attempt is scheduled, so it cannot answer that alone.
    const st = mkState();
    const state = new Map([['api', st]]);
    const { restarter } = mkRestarter(state);
    const before = Date.now();

    restarter.scheduleAutoRestart(svc, st, 0);

    assert.equal(st.restarts, 1);
    assert.ok(st.restartPendingUntil != null, 'nothing published');
    // First attempt is one backoff period out.
    const due = st.restartPendingUntil! - before;
    assert.ok(due > 0 && due <= BACKOFF_BASE_MS + 50, `due in ${due}ms, expected ~${BACKOFF_BASE_MS}`);
    restarter.cancel('api');
  });

  it('clears it when the attempt is cancelled', () => {
    // Every manual path cancels before spawning; leaving the field set would
    // have a waiter hold on for a restart that is never coming.
    const st = mkState();
    const { restarter } = mkRestarter(new Map([['api', st]]));
    restarter.scheduleAutoRestart(svc, st, 0);
    assert.ok(st.restartPendingUntil != null);

    restarter.cancel('api');
    assert.equal(st.restartPendingUntil, null);
  });

  it('keeps advertising it until the spawn is actually done', async () => {
    // Cleared before the spawn, it left a window reading crashed + nothing
    // queued — which a waiter treats as terminal. `start` is async and slow:
    // an API awaits `isPortBindable`, and a `preBuild` runs before that.
    const st = mkState();
    let releaseSpawn!: () => void;
    const slowSpawn = new Promise<void>(r => { releaseSpawn = r; });
    const { restarter, started } = mkRestarter(new Map([['api', st]]), () => slowSpawn);
    restarter.scheduleAutoRestart(svc, st, 0);

    await new Promise(r => setTimeout(r, BACKOFF_BASE_MS + 120));
    assert.deepEqual(started, ['api'], 'the restart should have begun');
    assert.ok(st.restartPendingUntil != null, 'still spawning — a waiter must not call this dead');

    releaseSpawn();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(st.restartPendingUntil, null, 'and only then stops advertising it');
  });

  it('tells clients when it stops advertising one', async () => {
    // A `status.follow` consumer holds the last frame it was pushed, so
    // clearing without emitting leaves the TUI and the extension showing a
    // countdown that never resolves.
    const st = mkState();
    const { restarter, changes } = mkRestarter(new Map([['api', st]]));
    restarter.scheduleAutoRestart(svc, st, 0);
    changes.length = 0;
    restarter.cancel('api');
    assert.deepEqual(changes, ['api']);
  });

  it('says nothing when there was nothing to clear', async () => {
    const st = mkState();
    const { restarter, changes } = mkRestarter(new Map([['api', st]]));
    restarter.cancel('api');
    assert.deepEqual(changes, [], 'no spurious frame for a service with no restart queued');
  });

  it('publishes nothing once the budget is spent — which is the terminal state', () => {
    // Exactly the case a waiter may give up on: crashed, out of budget, and
    // with nothing queued. If this still advertised a pending restart, the
    // fail-fast could never fire.
    const st = mkState({ restarts: MAX_RESTARTS });
    const { restarter } = mkRestarter(new Map([['api', st]]));

    restarter.scheduleAutoRestart(svc, st, 0);

    assert.equal(st.restarts, MAX_RESTARTS, 'the budget is not spent twice');
    assert.ok(st.restartPendingUntil == null);
  });

  it('tells clients about it, or a follower never sees the change', () => {
    const st = mkState();
    const { restarter, changes } = mkRestarter(new Map([['api', st]]));
    restarter.scheduleAutoRestart(svc, st, 0);
    assert.deepEqual(changes, ['api']);
    restarter.cancel('api');
  });
});
