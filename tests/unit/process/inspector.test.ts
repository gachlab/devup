import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isInspectorNotice, parseDebugPort } from '../../../src/process/inspector.js';

describe('parseDebugPort', () => {
  it('reads the port Node announces', () => {
    assert.equal(
      parseDebugPort('Debugger listening on ws://127.0.0.1:39481/8f2c1e00-1111-2222-3333-444455556666'),
      39481,
    );
  });

  it('handles a host name and surrounding whitespace', () => {
    assert.equal(parseDebugPort('  Debugger listening on ws://localhost:9229/abc  '), 9229);
  });

  it('ignores an application logging its own websocket', () => {
    // The narrow match is the point: a service printing a ws:// URL must not be
    // mistaken for the inspector, or clients attach a debugger to the app's own
    // socket and hang.
    assert.equal(parseDebugPort('Connected to ws://127.0.0.1:8080/socket'), null);
    assert.equal(parseDebugPort('listening on ws://127.0.0.1:9229/x'), null);
  });

  it('ignores the lines Node prints around it', () => {
    assert.equal(parseDebugPort('For help, see: https://nodejs.org/en/docs/inspector'), null);
    assert.equal(parseDebugPort('Debugger attached.'), null);
  });

  it('rejects an impossible port', () => {
    assert.equal(parseDebugPort('Debugger listening on ws://127.0.0.1:99999/x'), null);
  });
});

describe('isInspectorNotice', () => {
  it('recognises the lines Node writes when inspecting', () => {
    // Without an errorPattern every stderr line bumps state.errors, so a
    // service under --inspect showed two errors before doing anything, and the
    // TUI sorts services by error count.
    assert.equal(isInspectorNotice('Debugger listening on ws://127.0.0.1:39481/abc'), true);
    assert.equal(isInspectorNotice('For help, see: https://nodejs.org/en/docs/inspector'), true);
    assert.equal(isInspectorNotice('Debugger attached.'), true);
  });

  it('does not swallow a real error', () => {
    assert.equal(isInspectorNotice('Error: connect ECONNREFUSED 127.0.0.1:5432'), false);
    assert.equal(isInspectorNotice('Debugger listening is what I would say if I were one'), false);
  });
});
