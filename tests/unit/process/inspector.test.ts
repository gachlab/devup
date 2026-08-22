import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDebugPort } from '../../../src/process/inspector.js';

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
