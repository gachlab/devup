import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync, symlinkSync, lstatSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routableStates, ProxySync } from '../../../src/proxy-config/sync.js';
import { TraefikProvider } from '../../../src/proxy-config/traefik.js';
import { resolveProxyDomain } from '../../../src/proxy-config/domain.js';
import { writeConfigFile } from '../../../src/proxy-config/write.js';
import { rewriteServicePort } from '../../../src/lazy/classifier.js';
import type { ProcessState } from '../../../src/process/types.js';
import type { ServiceConfig } from '../../../src/config/types.js';
import type { ProxyOpts } from '../../../src/proxy-config/types.js';

const svc = (name: string, port: number): ServiceConfig => ({ name, cwd: '.', cmd: 'node', args: [], type: 'api', port, phase: 0 });
function st(over: Partial<ProcessState> & { svc: ServiceConfig }): ProcessState {
  const base: ProcessState = {
    svc: over.svc, proc: null, pid: null, status: 'running', health: 'up',
    errors: 0, restarts: 0, startedAt: null, intentionalStop: false, colorIdx: 0, crashLog: null,
  };
  return Object.assign(base, over);
}

describe('routableStates', () => {
  it('routes a sleeping lazy service to its proxy, so a request by domain wakes it', () => {
    // It used to be left out (404, never woken) and, once up, routed to
    // port + 10000 — past the lazy proxy, so domain traffic never counted as
    // activity and the service was put to sleep while in use.
    const out = routableStates(new Map([['api', st({ svc: rewriteServicePort(svc('api', 3002)), status: 'idle', health: 'idle' })]]));
    assert.deepEqual(out.get('api'), { port: 3002, health: 'up' });
  });

  it('routes an awake lazy service to its proxy too, not to the real port', () => {
    const out = routableStates(new Map([['api', st({ svc: rewriteServicePort(svc('api', 3002)) })]]));
    assert.equal(out.get('api')!.port, 3002);
  });

  it('keeps health for an ordinary service, so a down one gets no route', () => {
    const out = routableStates(new Map([['api', st({ svc: svc('api', 3000), status: 'crashed', health: 'down' })]]));
    assert.deepEqual(out.get('api'), { port: 3000, health: 'down' });
  });

  it('a lazy service served from a remote follows the remote health', () => {
    const out = routableStates(new Map([['api', st({
      svc: rewriteServicePort(svc('api', 3002)), health: 'down',
      remote: { envName: 'qa', target: 'http://qa', readOnly: false },
    })]]));
    assert.deepEqual(out.get('api'), { port: 3002, health: 'down' });
  });
});

describe('routableStates and a lazy proxy that is not listening', () => {
  it('falls back to health when the lazy proxy failed to bind', () => {
    const out = routableStates(new Map([['api', st({ svc: rewriteServicePort(svc('api', 3002)), status: 'idle', health: 'idle' })]]), () => false);
    assert.deepEqual(out.get('api'), { port: 3002, health: 'idle' });
  });
});

describe('ProxySync', () => {
  const opts = (confPath: string): ProxyOpts => ({ host: '127.0.0.1', domain: 'dev.local', routes: { api: 'api' }, tls: false, entrypoint: 'web', confPath });
  const states = () => new Map([['api', st({ svc: svc('api', 3000) })]]);

  // chmod does not stop writes on Windows, and root ignores it: no failure to provoke.
  it('a failed write is logged once, never thrown, and retried once writing works', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    // In the TUI it was thrown inside setInterval: an uncaught exception that
    // took the whole stack down over a config file.
    const dir = mkdtempSync(join(tmpdir(), 'devup-sync-'));
    const ro = join(dir, 'ro');
    mkdirSync(ro); chmodSync(ro, 0o500);
    const logs: string[] = [];
    const sync = new ProxySync(new TraefikProvider(), opts(join(ro, 'nested', 'conf.yaml')), states, m => logs.push(m));
    assert.doesNotThrow(() => { sync.sync(); sync.sync(); sync.sync(); });
    assert.equal(logs.length, 1, logs.join('\n'));
    chmodSync(ro, 0o700);
    sync.sync();
    assert.match(readFileSync(join(ro, 'nested', 'conf.yaml'), 'utf8'), /api/, 'did not retry after recovering');
  });

  it('writes only when the content changed, and clear() empties it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devup-sync-'));
    const path = join(dir, 'conf.yaml');
    let writes = 0;
    const provider = new TraefikProvider();
    const orig = provider.write.bind(provider);
    provider.write = (c, o) => { writes++; orig(c, o); };
    const sync = new ProxySync(provider, opts(path), states);
    sync.sync(); sync.sync();
    assert.equal(writes, 1);
    assert.match(readFileSync(path, 'utf8'), /api/);
    sync.clear();
    assert.doesNotMatch(readFileSync(path, 'utf8'), /Host\(/);
  });

  it('puts its routes back when something else rewrote the file', () => {
    // Another --instance sharing the default path clears it on quit; content
    // equal to `last` used to mean "nothing to do" for good.
    const dir = mkdtempSync(join(tmpdir(), 'devup-sync-'));
    const path = join(dir, 'conf.yaml');
    const sync = new ProxySync(new TraefikProvider(), opts(path), states);
    sync.sync();
    writeFileSync(path, 'http:\n  routers: {}\n  services: {}\n');
    sync.sync();
    assert.match(readFileSync(path, 'utf8'), /Host\(/);
  });
});

describe('writeConfigFile', () => {
  // Symlinks need a privilege on Windows, and it has no POSIX mode to keep.
  it('writes through a symlink and keeps the file mode, as a rename would not', { skip: process.platform === 'win32' }, () => {
    // A rename replaced a symlinked confPath with a plain file and reset the
    // mode; it also changed the inode, which a single-file bind mount never sees.
    const dir = mkdtempSync(join(tmpdir(), 'devup-write-'));
    const target = join(dir, 'real.conf');
    writeFileSync(target, 'old');
    chmodSync(target, 0o640);
    const link = join(dir, 'link.conf');
    symlinkSync(target, link);
    const inode = statSync(target).ino;
    writeConfigFile(link, 'new');
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readFileSync(target, 'utf8'), 'new');
    assert.equal(statSync(target).mode & 0o777, 0o640);
    assert.equal(statSync(target).ino, inode);
  });
});

describe('resolveProxyDomain', () => {
  it('proxy.domain, then $DOMAIN, then localhost', () => {
    assert.equal(resolveProxyDomain({ domain: 'cfg.test' }, { DOMAIN: 'env.test' }), 'cfg.test');
    assert.equal(resolveProxyDomain({}, { DOMAIN: 'env.test' }), 'env.test');
    assert.equal(resolveProxyDomain({}, {}), 'localhost');
  });

  it('$GUESTHUB_DOMAIN keeps its place ahead of $DOMAIN, and warns', () => {
    // A stack with both may use DOMAIN for something else; re-pointing every
    // route of it silently is not a deprecation.
    const warned: string[] = [];
    assert.equal(resolveProxyDomain({}, { GUESTHUB_DOMAIN: 'gh.test', DOMAIN: 'other.test' }, m => warned.push(m)), 'gh.test');
    assert.equal(warned.length, 1);
  });
});
