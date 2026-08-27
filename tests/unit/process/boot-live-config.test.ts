import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { registerLazy } from '../../../src/process/boot.js';
import { ProcessManager } from '../../../src/process/manager.js';
import { detectPlatform } from '../../../src/platform/detect.js';
import type { LazyProxy } from '../../../src/lazy/proxy.js';
import type { ServiceConfig } from '../../../src/config/types.js';

const isWin = process.platform === 'win32';

function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
  });
}

describe('a lazy service starts from the live config', { skip: isWin }, () => {
  it('picks up an edit made after the proxy was registered', async () => {
    // The failure this replaces: `onDemandStart` closed over the config
    // captured at boot and read back only `debug`, so a `--watch-config`
    // reload of a lazy service changed the snapshot and **nothing else** —
    // the new args never reached the process. The comment explaining why it
    // could not read state was true before the reload started writing the
    // rewritten config there, and it was moved verbatim into the shared boot
    // without re-checking that.
    const port = await findFreePort();
    const started: string[][] = [];
    const mgr = new ProcessManager({
      baseCwd: process.cwd(), env: {}, platform: await detectPlatform(),
      events: { onLog: () => {}, onStateChange: () => {} },
    });
    // Intercept the spawn: what matters is the args it was handed. It has to
    // actually open the port, or `ensureStarted` waits out its full 45 s.
    const opened: net.Server[] = [];
    (mgr as unknown as { install: unknown }).install = async () => true;
    (mgr as unknown as { start: unknown }).start = async (svc: ServiceConfig) => {
      started.push(svc.args);
      const server = net.createServer(c => c.destroy());
      opened.push(server);
      await new Promise<void>(r => server.listen(svc.port, '127.0.0.1', r));
    };

    const svc: ServiceConfig = {
      name: 'app-api', cwd: '.', cmd: 'node', args: ['old.js'], type: 'api', port, phase: 0,
    };
    const proxies = new Map<string, LazyProxy>();
    registerLazy(mgr, svc, 0, 0, proxies);
    try {
      // What a config reload does now: the rewritten config into state.
      const st = mgr.state.get('app-api')!;
      st.svc = { ...st.svc, args: ['new.js'] };

      await proxies.get('app-api')!.ensureStarted();

      assert.deepEqual(started, [['new.js']], 'it started from the boot-time config');
    } finally {
      proxies.get('app-api')!.destroy();
      for (const server of opened) await new Promise<void>(r => server.close(() => r()));
      await mgr.cleanup().catch(() => {});
    }
  });
});
