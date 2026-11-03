import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { blockedOrigin, violationsOf } from '../../src/modules/system/csp-report';
import { buildTestApp } from '../helpers/test-app';

describe('POST /api/v1/csp-report', () => {
  it('reads both report formats, keeping only the directive and the blocked origin', () => {
    expect(
      violationsOf({
        'csp-report': {
          'violated-directive': 'script-src-elem',
          'blocked-uri': 'https://evil.example.com/x.js?user=9876543210',
          'document-uri': 'https://wa.notifynow.in/contacts/c/123',
        },
      }),
    ).toEqual([{ directive: 'script-src-elem', blocked: 'https://evil.example.com' }]);
    expect(
      violationsOf([
        { type: 'csp-violation', body: { effectiveDirective: 'img-src', blockedURL: 'data' } },
        { type: 'deprecation', body: {} },
      ]),
    ).toEqual([{ directive: 'img-src', blocked: 'data' }]);
    expect(violationsOf({})).toEqual([]);
    expect(violationsOf(null)).toEqual([]);
    expect(blockedOrigin('inline')).toBe('inline');
    expect(blockedOrigin(undefined)).toBe('unknown');
  });

  it('answers 204 to a report, without signing in, and refuses a body over 16 KB', async () => {
    const app = buildTestApp();
    const ok = await request(app)
      .post('/api/v1/csp-report')
      .set('content-type', 'application/csp-report')
      .send(JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src' } }));
    expect(ok.status).toBe(204);
    const big = await request(app)
      .post('/api/v1/csp-report')
      .set('content-type', 'application/csp-report')
      .send(JSON.stringify({ 'csp-report': { x: 'y'.repeat(20_000) } }));
    expect(big.status).toBe(413);
  });
});
