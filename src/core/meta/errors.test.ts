import { describe, expect, it } from 'vitest';

import {
  graphError,
  invalidResponse,
  mapSendError,
  mediaRefused,
  metaErrorMeta,
  networkError,
  notConfigured,
  scrubSecrets,
} from './errors';
import { isAllowedMediaUrl, isMetaApiError, MetaApiError } from './types';

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

describe('Phase 10 — send error mapping', () => {
  it('maps every documented code (retry, wait, channel effect, our reason)', () => {
    const map = (code: number | null, extra = {}) => mapSendError({ code, ...extra });
    expect(map(131047)).toEqual({
      retryable: false,
      retryAfterSec: null,
      channelEffect: 'none',
      reason: 'More than 24 hours have passed since the customer last replied',
    });
    expect(map(131026).reason).toBe('Message undeliverable');
    expect(
      [131049, 131050, 131051, 131009, 131008, 100, 133010].map((c) => map(c).retryable),
    ).toEqual([false, false, false, false, false, false, false]);
    expect([131052, 131053, 130429, 131000, 131016, 1, 2].map((c) => map(c).retryable)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(map(131056)).toMatchObject({ retryable: true, retryAfterSec: 60 });
    expect(map(368)).toMatchObject({ retryable: false, channelEffect: 'restricted' });
    expect(map(131031).channelEffect).toBe('restricted');
    expect(map(190)).toEqual({
      retryable: false,
      retryAfterSec: null,
      channelEffect: 'needs_reconnect',
      reason: 'Connection to WhatsApp expired',
    });
    expect(map(null, { tokenInvalid: true }).channelEffect).toBe('needs_reconnect');
  });

  it('unknown codes and transport errors', () => {
    expect(mapSendError({ code: 999999 })).toEqual({
      retryable: false,
      retryAfterSec: null,
      channelEffect: 'none',
      reason: 'Message failed (code 999999)',
    });
    expect(mapSendError({ code: null, status: 503 })).toMatchObject({ retryable: true });
    expect(mapSendError({ code: null, status: 0, retryable: true }).retryable).toBe(true);
    expect(mapSendError({ code: null, status: 400 })).toMatchObject({
      retryable: false,
      reason: 'Message failed',
    });
    expect(mapSendError({ code: null })).toMatchObject({ retryable: false });
  });

  it('scrubs media URLs and OAuth headers; media refusals are not retryable', () => {
    const text = scrubSecrets(
      'download https://lookaside.fbsbx.com/whatsapp?mid=1&hash=SECRET failed, OAuth abc.def',
    );
    expect(text).toBe('download <media url> failed, OAuth ***');
    expect(scrubSecrets('see https://scontent.fbcdn.net/x.jpg?oh=1')).toBe('see <media url>');
    expect(mediaRefused('host')).toMatchObject({ type: 'media_host_refused', retryable: false });
    expect(mediaRefused('too_large')).toMatchObject({ type: 'media_too_large', retryable: false });
  });

  it('media host allowlist (https Meta hosts, exact extra hosts only)', () => {
    expect(isAllowedMediaUrl('https://lookaside.fbsbx.com/whatsapp/?mid=1')).toBe(true);
    expect(isAllowedMediaUrl('https://mmg.whatsapp.net/v/t62/x')).toBe(true);
    expect(isAllowedMediaUrl('https://scontent.xx.fbcdn.net/x')).toBe(true);
    expect(isAllowedMediaUrl('http://lookaside.fbsbx.com/x')).toBe(false);
    expect(isAllowedMediaUrl('https://fbsbx.com.evil.example/x')).toBe(false);
    expect(isAllowedMediaUrl('https://evil-fbsbx.com/x')).toBe(false);
    expect(isAllowedMediaUrl('https://169.254.169.254/latest')).toBe(false);
    expect(isAllowedMediaUrl('not a url')).toBe(false);
    expect(isAllowedMediaUrl('http://127.0.0.1:4000/m', ['127.0.0.1:4000'])).toBe(true);
    expect(isAllowedMediaUrl('http://127.0.0.1:4001/m', ['127.0.0.1:4000'])).toBe(false);
  });
});
