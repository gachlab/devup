/** The sample used to generate `contract/status-snapshot.json`.
 *
 *  Lives in `src/` rather than in the test so the generator script and the
 *  golden test build it from one definition. Every entry must be a state the
 *  daemon can actually produce: a fixture that encodes an impossible
 *  combination teaches clients a wrong type, which is the failure it exists to
 *  prevent. */
import { serializeState } from './socket-server.js';
import type { ProcessState } from '../process/types.js';
import type { ServiceConfig } from '../config/types.js';

const alwaysOn: ServiceConfig = {
  name: 'configurations-api', cwd: 'configurations/api', cmd: 'node',
  args: ['--watch-path', 'src', 'src/index.js'], type: 'api', port: 2999, phase: 0,
};

/** As the orchestrator holds a lazy service: `rewriteServicePort` has already
 *  moved `port` to `port + LAZY_PORT_OFFSET` and kept the configured one. */
const lazy = {
  name: 'authorization-api', cwd: 'authorization/api', cmd: 'node',
  args: ['app.js'], type: 'api', port: 13002, phase: 1, originalPort: 3002,
} as ServiceConfig;

const web: ServiceConfig = {
  name: 'app-web', cwd: 'app/web', cmd: 'npx',
  args: ['ng', 'serve'], type: 'web', port: 4201, phase: 4,
};

function mkState(svc: ServiceConfig, over: Partial<ProcessState>): ProcessState {
  return {
    svc, proc: null, pid: null, status: 'running', health: 'up',
    errors: 0, restarts: 0, startedAt: null,
    intentionalStop: false, colorIdx: 3, crashLog: null,
    ...over,
  };
}

/** Exactly what the `status` method returns: `{ services, proxy }`. */
export function buildContractSnapshot(): Record<string, unknown> {
  return {
    services: [
      // Running and healthy. port === originalPort, which is what lets a client
      // read originalPort with no version check.
      serializeState('configurations-api', mkState(alwaysOn, {
        pid: 4242, status: 'running', health: 'up', restarts: 1, startedAt: 1755800000000,
      })),
      // Under the inspector, so debugPort is pinned as a number rather than
      // only ever null — a client generating a type from nulls learns nothing.
      serializeState('app-api', mkState(
        { ...alwaysOn, name: 'app-api', cwd: 'app/api', port: 3000, debug: true },
        { pid: 4243, status: 'running', health: 'up', startedAt: 1755800000000, debugPort: 39481 },
      )),
      // Lazy and asleep. The daemon nulls pid *and* startedAt when idling, so a
      // client must not treat startedAt as a liveness signal.
      serializeState('authorization-api', mkState(lazy, {
        status: 'idle', health: 'idle',
      })),
      // Crashed, so `crashLog` is pinned as string[] rather than only ever null,
      // and `crashes` as a number that has actually moved. Note it is higher
      // than `restarts`: the budget was reset by a manual restart somewhere
      // along the way, which is precisely why the two are separate fields.
      serializeState('app-web', mkState(web, {
        status: 'crashed', health: 'down', errors: 2, restarts: 3, crashes: 5,
        // A timestamp in the past, on purpose: `serializeState` clamps against
        // `Date.now()`, so this pins `restartPendingIn: 0` — the overdue edge —
        // reproducibly. A future timestamp would serialise to a different
        // number every second and the golden file could never settle. What it
        // buys is the field pinned as a *number* rather than only ever null;
        // the live countdown is pinned by the socket-server test.
        restartPendingUntil: 1755800008000,
        crashLog: ['Error: listen EADDRINUSE: address already in use :::4201', '    at Server.setupListenHandle'],
      })),
    ],
    proxy: {
      active: true,
      provider: 'traefik',
      domain: 'guesthub.test',
      tls: true,
      routes: { 'app-web': '', 'administration-web': 'administration' },
    },
  };
}
