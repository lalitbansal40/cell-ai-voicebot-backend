import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  createGraphMetaClient,
  mapTemplateError,
  MetaApiError,
  type GraphMetaClientOptions,
} from '../../src/core/meta';
import { createLogger } from '../../src/shared/logger';
import { json, useStubServer } from '../helpers/stub-server';

const stub = useStubServer();
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '../fixtures/meta', name), 'utf8'));

const TOKEN = 'BUSINESS_TOKEN_templates_123';
const WABA = '102290129340398';
const APP = '1000000000000001';

const logLines: string[] = [];
const logger = createLogger(
  { NODE_ENV: 'test', LOG_LEVEL: 'trace' },
  new Writable({
    write(chunk: Buffer, _enc, done) {
      logLines.push(chunk.toString());
      done();
    },
  }),
);

const client = (over: Partial<GraphMetaClientOptions> = {}) =>
  createGraphMetaClient({
    appId: APP,
    appSecret: 'app-secret-0123456789abcdef0123456789',
    graphVersion: 'v26.0',
    baseUrl: stub.url,
    logger,
    sleep: () => Promise.resolve(),
    random: () => 0,
    ...over,
  });

const req = (i = -1) => {
  const r = stub.requests.at(i);
  if (!r) throw new Error('no request');
  const url = new URL(r.url, 'http://x');
  return { ...r, path: url.pathname, query: Object.fromEntries(url.searchParams) };
};
const bodyOf = () => JSON.parse(req().body) as Record<string, unknown>;

beforeEach(() => {
  stub.reset();
  logLines.length = 0;
});

describe('Graph client — templates', () => {
  it('listTemplates asks for every field, pages with the cursor and maps the answer', async () => {
    stub.next(json(200, fixture('graph-templates-page1.json')));
    const first = await client().listTemplates(TOKEN, WABA);
    expect(req()).toMatchObject({ method: 'GET', path: `/v26.0/${WABA}/message_templates` });
    expect(req().headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req().query).toEqual({
      fields:
        'id,name,language,status,category,sub_category,parameter_format,components,quality_score,rejected_reason,message_send_ttl_seconds',
      limit: '100',
    });
    expect(first.after).toBe('QVFIUAFTER');
    expect(first.templates[0]).toMatchObject({
      id: '9000000000000001',
      name: 'test_order_update',
      language: 'en_US',
      status: 'APPROVED',
      category: 'UTILITY',
      subCategory: 'ORDER_DETAILS',
      parameterFormat: 'positional',
      qualityScore: 'GREEN',
      rejectedReason: null,
      ttlSeconds: 3600,
    });
    expect(first.templates[0]?.components).toHaveLength(4);

    stub.next(json(200, fixture('graph-templates-page2.json')));
    const second = await client().listTemplates(TOKEN, WABA, { after: first.after, limit: 50 });
    expect(req().query).toMatchObject({ after: 'QVFIUAFTER', limit: '50' });
    // cursors without a `next` link → last page
    expect(second.after).toBeNull();
    expect(second.templates[0]).toMatchObject({
      parameterFormat: 'named',
      rejectedReason: 'INVALID_FORMAT',
      qualityScore: null,
      subCategory: null,
    });
  });

  it('createTemplate posts the Meta body; editTemplate posts to the template id', async () => {
    stub.next(json(200, fixture('graph-template-created.json')));
    const components = [{ type: 'BODY', text: 'Hi {{1}}', example: { body_text: [['Test']] } }];
    const created = await client().createTemplate(TOKEN, WABA, {
      name: 'test_offer',
      language: 'en',
      category: 'MARKETING',
      parameterFormat: 'positional',
      components,
      ttlSeconds: 3600,
    });
    expect(created).toEqual({ id: '9000000000000003', status: 'PENDING', category: 'MARKETING' });
    expect(req()).toMatchObject({ method: 'POST', path: `/v26.0/${WABA}/message_templates` });
    expect(bodyOf()).toEqual({
      name: 'test_offer',
      language: 'en',
      category: 'MARKETING',
      parameter_format: 'POSITIONAL',
      components,
      message_send_ttl_seconds: 3600,
    });

    stub.next(json(200, { success: true }));
    await client().editTemplate(TOKEN, '9000000000000003', { components });
    expect(req()).toMatchObject({ method: 'POST', path: '/v26.0/9000000000000003' });
    expect(bodyOf()).toEqual({ components });

    stub.next(json(200, { success: true }));
    await client().editTemplate(TOKEN, '9000000000000003', { category: 'UTILITY', ttlSeconds: 60 });
    expect(bodyOf()).toEqual({ category: 'UTILITY', message_send_ttl_seconds: 60 });
  });

  it('deleteTemplate by name or by name + hsm id', async () => {
    stub.next(json(200, { success: true }));
    await client().deleteTemplate(TOKEN, WABA, { name: 'test_offer' });
    expect(req()).toMatchObject({ method: 'DELETE', path: `/v26.0/${WABA}/message_templates` });
    expect(req().query).toEqual({ name: 'test_offer' });
    stub.next(json(200, { success: true }));
    await client().deleteTemplate(TOKEN, WABA, { name: 'test_offer', hsmId: '9000000000000003' });
    expect(req().query).toEqual({ name: 'test_offer', hsm_id: '9000000000000003' });
  });

  it('uploadExample: resumable session (name, length, type) then OAuth bytes → handle', async () => {
    stub.next(json(200, fixture('graph-upload-session.json')));
    stub.next(json(200, fixture('graph-upload-handle.json')));
    const handle = await client().uploadExample(TOKEN, {
      bytes: Buffer.from('PNGDATA'),
      mimeType: 'image/png',
      fileName: 'header.png',
    });
    expect(handle).toBe('4::aW1hZ2UvanBlZw==:TESTHANDLE');
    const session = req(0);
    expect(session.path).toBe(`/v26.0/${APP}/uploads`);
    expect(session.query).toEqual({
      file_name: 'header.png',
      file_length: '7',
      file_type: 'image/png',
    });
    const upload = req(1);
    expect(upload.headers.authorization).toBe(`OAuth ${TOKEN}`);
    expect(upload.headers.file_offset).toBe('0');
    expect(upload.body).toBe('PNGDATA');
  });

  it('getPricingAnalytics builds the field expression and maps data points', async () => {
    stub.next(json(200, fixture('graph-pricing-analytics.json')));
    const points = await client().getPricingAnalytics(TOKEN, WABA, {
      start: new Date('2026-10-22T00:00:00Z'),
      end: new Date('2026-10-23T00:00:00Z'),
    });
    expect(req()).toMatchObject({ method: 'GET', path: `/v26.0/${WABA}` });
    expect(req().query.fields).toBe(
      `pricing_analytics.start(${String(Date.parse('2026-10-22T00:00:00Z') / 1000)}).end(${String(Date.parse('2026-10-23T00:00:00Z') / 1000)}).granularity(DAILY).dimensions(PRICING_CATEGORY,PRICING_TYPE,COUNTRY)`,
    );
    expect(points).toEqual([
      {
        start: new Date(1761091200 * 1000),
        end: new Date(1761177600 * 1000),
        country: 'IN',
        category: 'marketing',
        pricingType: 'regular',
        tier: '0:MAX',
        volume: 12,
        cost: 10.36,
      },
      expect.objectContaining({
        category: 'service',
        pricingType: 'free_customer_service',
        cost: 0,
      }),
    ]);
    stub.next(json(200, { id: WABA }));
    expect(
      await client().getPricingAnalytics(TOKEN, WABA, { start: new Date(0), end: new Date(1000) }),
    ).toEqual([]);
  });

  it('errors: name taken (100 / 2388023) not retried; 5xx retried; logs scrubbed', async () => {
    stub.next(json(400, fixture('graph-error-template-exists.json')));
    const err = (await client()
      .createTemplate(TOKEN, WABA, {
        name: 'test_offer',
        language: 'en',
        category: 'MARKETING',
        parameterFormat: 'named',
        components: [{ type: 'BODY', text: 'Secret template body' }],
      })
      .catch((e: unknown) => e)) as MetaApiError;
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err).toMatchObject({ code: 100, subcode: 2388023, retryable: false });
    expect(mapTemplateError(err).code).toBe('TEMPLATE_NAME_TAKEN');
    expect(stub.requests).toHaveLength(1);

    stub.reset();
    stub.next(json(500, { error: { code: 2, message: 'temporary' } }));
    stub.next(json(200, fixture('graph-templates-page2.json')));
    await client().listTemplates(TOKEN, WABA);
    expect(stub.requests).toHaveLength(2);
    const logs = logLines.join('\n');
    for (const leak of [TOKEN, 'Secret template body']) expect(logs).not.toContain(leak);
    expect(logs).toContain('waba.template_create');
  });

  it('a malformed answer is an invalid response', async () => {
    stub.next(json(200, { data: [{ name: 'x' }] }));
    await expect(client().listTemplates(TOKEN, WABA)).rejects.toMatchObject({
      type: 'invalid_response',
    });
  });
});
