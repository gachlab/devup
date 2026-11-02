import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessManager } from '../../../src/process/manager.js';
import type { Platform } from '../../../src/platform/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';
import { isRunning, waitForExit } from '../../../src/process/liveness.js';

function testPlatform(): Platform {
  return {
    getProcessStats: async () => new Map(),
    killTree: (pid: number, signal: NodeJS.Signals = 'SIGTERM') => {
      try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* gone */ } }
    },
    openBrowser: () => {},
    defaultTraefikHost: '127.0.0.1',
  };
}

// `web` so the spawner skips the port guard: these tests are about spawning,
// not ports, and must not collide with each other.
function svc(name: string, script: string): ServiceConfig {
  return { name, cwd: '.', cmd: process.execPath, args: ['-e', script], type: 'web', port: 1, phase: 0 };
}

const managers: ProcessManager[] = [];
function mk() {
  const logs: string[] = [];
  const mgr = new ProcessManager({
    baseCwd: process.cwd(),
    env: { ...process.env as Record<string, string> },
    platform: testPlatform(),
    events: { onLog: (_n, t) => logs.push(t), onStateChange: () => {} },
  });
  managers.push(mgr);
  return { mgr, logs };
}
after(async () => { for (const m of managers) await m.cleanup({ gracePeriodMs: 200 }).catch(() => {}); });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
}

describe('un spawn que falla', () => {
  it('un cmd inexistente queda crashed con el error, sin tumbar el proceso ni reintentar', { timeout: 10000 }, async () => {
    // Sin listener de 'error', esto era una excepción no capturada: este test
    // no llegaría a la siguiente línea.
    const { mgr, logs } = mk();
    await mgr.start({ ...svc('ghost', ''), cmd: 'devup-definitely-not-a-command' }, 0);
    await until(() => mgr.state.get('ghost')?.status === 'crashed');
    const st = mgr.state.get('ghost')!;
    assert.match(st.crashLog?.[0] ?? '', /ENOENT/);
    assert.equal(st.restartPendingUntil ?? null, null, 'un binario ausente no aparece en 2 s');
    assert.ok(logs.some(l => l.includes('failed to start')), logs.join('\n'));
  });
});

describe('stop y apagado frente a un reinicio en cola', () => {
  it('stop() cancela el auto-restart de un servicio crasheado', { timeout: 10000 }, async () => {
    const { mgr } = mk();
    await mgr.start(svc('flaky', 'process.exit(1)'), 0);
    await until(() => mgr.state.get('flaky')?.restartPendingUntil != null);
    const crashed = mgr.state.get('flaky')!;

    mgr.stop('flaky');
    // El primer backoff es de 2 s.
    await sleep(2600);
    assert.equal(mgr.state.get('flaky'), crashed, 'volvió a arrancar después de `stop`');
    assert.equal(crashed.restartPendingUntil, null);
  });

  it('cleanup() cancela los reinicios en cola: nada arranca durante el grace', { timeout: 10000 }, async () => {
    const { mgr } = mk();
    await mgr.start(svc('flaky2', 'process.exit(1)'), 0);
    await until(() => mgr.state.get('flaky2')?.restartPendingUntil != null);
    const crashed = mgr.state.get('flaky2')!;

    await mgr.cleanup({ gracePeriodMs: 100 });
    // Cancelado, no sólo bloqueado al disparar: un cliente que muestra la
    // cuenta atrás tiene que enterarse ya.
    assert.equal(crashed.restartPendingUntil, null);
    await sleep(2600);
    assert.equal(mgr.state.get('flaky2'), crashed, 'un hijo nuevo habría sobrevivido a devup');
  });

  it('después de cleanup() no se lanza nada más, aunque un arranque llegue tarde', { timeout: 10000 }, async () => {
    const { mgr } = mk();
    await mgr.cleanup({ gracePeriodMs: 100 });
    await mgr.start(svc('late', 'setInterval(() => {}, 1000)'), 0);
    assert.equal(mgr.state.get('late'), undefined);
  });
});

describe('estado tras un stop intencional', () => {
  it('pasa a stopped/down cuando el proceso sale', { timeout: 10000 }, async () => {
    const { mgr } = mk();
    await mgr.start(svc('calm', 'setInterval(() => {}, 1000)'), 0);
    const st = mgr.state.get('calm')!;
    assert.ok(isRunning(st));
    mgr.stop('calm');
    assert.equal(await waitForExit(st, 5000), true);
    await until(() => st.status === 'stopped');
    assert.equal(st.health, 'down');
  });

  it('no pisa el estado nuevo de un reinicio', { timeout: 15000 }, async () => {
    const { mgr } = mk();
    await mgr.start(svc('again', 'setInterval(() => {}, 1000)'), 0);
    const old = mgr.state.get('again')!;
    await mgr.restart('again');
    const fresh = mgr.state.get('again')!;
    assert.notEqual(fresh, old);
    await waitForExit(old, 5000);
    await sleep(100);
    assert.notEqual(fresh.status, 'stopped');
  });
});
