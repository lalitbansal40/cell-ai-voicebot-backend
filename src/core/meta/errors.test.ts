import { describe, expect, it } from 'vitest';

import {
  graphError,
  invalidResponse,
  metaErrorMeta,
  networkError,
  notConfigured,
  scrubSecrets,
} from './errors';
import { isMetaApiError, MetaApiError } from './types';

describe('scrubSecrets', () => {
  it('removes tokens, secrets and codes', () => {
    const text =
      'GET /oauth/access_token?client_id=1&client_secret=SECRET1&code=CODE1 input_token=TOK1&access_token=1|SECRET2 Authorization: Bearer TOK2=x';
    const out = scrubSecrets(text);
    for (const secret of ['SECRET1', 'CODE1', 'TOK1', 'SECRET2', 'TOK2'])
      expect(out).not.toContain(secret);
    expect(out).toContain('client_secret=***');
    expect(out).toContain('Bearer ***');
    expect(scrubSecrets('x'.repeat(900))).toHaveLength(500);
  });
});

describe('graphError', () => {
  it.each([
    [500, { error: { code: 2, message: 'down' } }, true, false],
    [400, { error: { code: 80007, message: 'rate' } }, true, false],
    [400, { error: { code: 4 } }, true, false],
    [400, { error: { code: 100, message: 'bad' } }, false, false],
    [401, { error: { code: 190, message: 'expired' } }, false, true],
    [400, { error: { code: 102, type: 'OAuthException', error_subcode: 463 } }, false, true],
    [400, { error: { code: 102, type: 'OAuthException', error_subcode: 999 } }, false, false],
    [400, { error: { code: 102, type: 'GraphMethodException', error_subcode: 460 } }, false, false],
    [502, null, true, false],
    [400, 'text', false, false],
    [400, { error: 'x' }, false, false],
  ])('HTTP %i %j → retryable %s, tokenInvalid %s', (status, body, retryable, tokenInvalid) => {
    const err = graphError(status, body);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(isMetaApiError(err)).toBe(true);
    expect({ retryable: err.retryable, tokenInvalid: err.tokenInvalid }).toEqual({
      retryable,
      tokenInvalid,
    });
  });

  it('keeps code / subcode / type / trace id; scrubs the message; default message', () => {
    const err = graphError(400, {
      error: {
        message: 'bad token access_token=SECRETTOKEN',
        type: 'OAuthException',
        code: 190,
        error_subcode: 460,
        fbtrace_id: 'trace1',
      },
    });
    expect(err.message).toBe('bad token access_token=***');
    expect(metaErrorMeta(err)).toEqual({
      status: 400,
      code: 190,
      subcode: 460,
      type: 'OAuthException',
      fbtraceId: 'trace1',
    });
    expect(graphError(503, {}).message).toBe('Meta request failed (HTTP 503)');
    expect(isMetaApiError(new Error('x'))).toBe(false);
  });

  it('network / invalid / not configured errors', () => {
    expect(networkError(true)).toMatchObject({ status: 0, type: 'timeout', retryable: true });
    expect(networkError(false)).toMatchObject({
      type: 'network',
      message: 'Meta is not reachable',
    });
    expect(invalidResponse(200, 'waba.get')).toMatchObject({
      type: 'invalid_response',
      retryable: false,
    });
    expect(invalidResponse(502, 'x').retryable).toBe(true);
    expect(notConfigured('The credit line')).toMatchObject({
      type: 'not_configured',
      retryable: false,
      message: 'The credit line is not configured on this server',
    });
  });
});
