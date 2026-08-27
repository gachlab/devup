import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactUrl } from '../../../src/utils/redact.js';

describe('redactUrl', () => {
  it('leaves a path with no query alone', () => {
    assert.equal(redactUrl('/api/v1/requests'), '/api/v1/requests');
  });

  it('keeps ordinary query parameters readable', () => {
    assert.equal(redactUrl('/api/v1/requests?page=2&status=open'), '/api/v1/requests?page=2&status=open');
  });

  it('scrubs a token but keeps the parameter name', () => {
    // Knowing a token was present is what makes the line worth reading; the
    // value is what must not reach ~/.devup/logs.
    assert.equal(redactUrl('/cb?access_token=eyJhbGciOi'), '/cb?access_token=***');
  });

  it('scrubs an OAuth code', () => {
    assert.equal(redactUrl('/callback?code=4%2F0Ad'), '/callback?code=***');
  });

  it('scrubs every secret-looking parameter and leaves the rest', () => {
    assert.equal(
      redactUrl('/x?api_key=abc&page=1&password=hunter2'),
      '/x?api_key=***&page=1&password=***',
    );
  });
});
