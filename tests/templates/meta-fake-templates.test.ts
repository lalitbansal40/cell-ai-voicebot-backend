import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildFakeCode,
  buildMessagePayload,
  buildTemplatePayload,
  createFakeMetaClient,
  FAKE_TEMPLATE_KNOBS,
  fakeIds,
  inboxMessagesValueSchema,
  TEMPLATE_WEBHOOK_VALUE_SCHEMAS,
  type FakeMetaClient,
  type FakeSignup,
  type MetaTemplateCreate,
} from '../../src/core/meta';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

let redis: Redis;
let fake: FakeMetaClient;
const prefix = uniquePrefix('fake-templates');
const emitted: Record<string, unknown>[] = [];

beforeAll(async () => {
  redis = (await requireRedis()).client;
  fake = createFakeMetaClient({
    redis,
    prefix,
    appSecret: 'fake-secret',
    statusDelaysMs: [5, 10, 15],
    templateReviewMs: 5,
  });
  fake.setWebhookEmitter((body) => {
    emitted.push(body);
    return Promise.resolve();
  });
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  fake.stopStatusTimers();
  await flushPrefix(redis, prefix);
  redis.disconnect();
});

let n = 0;
const connect = async () => {
  n += 1;
  const s: FakeSignup = {
    businessName: `Template Business ${String(n)}`,
    phone: `+91 90000 3${String(n).padStart(4, '0')}`,
    displayName: 'Test Business',
    mode: 'cloud_api',
    outcome: 'finish',
  };
  const { accessToken } = await fake.exchangeCode(buildFakeCode(s));
  return { token: accessToken, ids: fakeIds(s.businessName, s.phone) };
};

const body = (name: string, over: Partial<MetaTemplateCreate> = {}): MetaTemplateCreate => ({
  name,
  language: 'en',
  category: 'UTILITY',
  parameterFormat: 'positional',
  components: [{ type: 'BODY', text: 'Hi {{1}}', example: { body_text: [['Test']] } }],
  ...over,
});

const changes = (field: string, templateId: string) =>
  emitted
    .flatMap(
      (b) => (b.entry as { changes: { field: string; value: unknown }[] }[])[0]?.changes ?? [],
    )
    .filter((c) => c.field === field)
    .map((c) => c.value as Record<string, unknown>)
    .filter((v) => v.message_template_id === templateId);

const statusEvents = (templateId: string) =>
  changes('message_template_status_update', templateId).map(
    (v) => TEMPLATE_WEBHOOK_VALUE_SCHEMAS.message_template_status_update.parse(v).event,
  );

describe('fake Meta — templates', () => {
  it('create → PENDING → review webhook APPROVED (Meta-shaped, schema-valid)', async () => {
    const { token, ids } = await connect();
    const created = await fake.createTemplate(token, ids.wabaId, body('order_update'));
    expect(created).toMatchObject({ status: 'PENDING', category: 'UTILITY' });
    expect(created.id).toMatch(/^fake_tpl_[0-9a-f]{16}$/);
    await vi.waitFor(() => expect(statusEvents(created.id)).toEqual(['APPROVED']));
    const [t] = await fake.templates(ids.wabaId);
    expect(t).toMatchObject({ status: 'APPROVED', parameter_format: 'POSITIONAL' });
    const value = changes('message_template_status_update', created.id)[0];
    expect(value).toMatchObject({
      message_template_name: 'order_update',
      message_template_language: 'en',
      message_template_category: 'UTILITY',
    });
  });

  it('name knobs: instant, _reject, _recategorize, _slow', async () => {
    const { token, ids } = await connect();
    const instant = await fake.createTemplate(token, ids.wabaId, body('promo_instant'));
    expect(instant.status).toBe('APPROVED');
    const rejected = await fake.createTemplate(token, ids.wabaId, body('promo_reject'));
    const recat = await fake.createTemplate(token, ids.wabaId, body('promo_recategorize'));
    const slow = await fake.createTemplate(token, ids.wabaId, body('promo_slow'));
    await vi.waitFor(() => {
      expect(statusEvents(rejected.id)).toEqual(['REJECTED']);
      expect(changes('template_category_update', recat.id)).toHaveLength(1);
    });
    const reject = TEMPLATE_WEBHOOK_VALUE_SCHEMAS.message_template_status_update.parse(
      changes('message_template_status_update', rejected.id)[0],
    );
    expect(reject).toMatchObject({ reason: 'INVALID_FORMAT' });
    expect(reject.rejection_info?.reason).toBeTruthy();
    expect(statusEvents(recat.id)).toEqual(['APPROVED']);
    expect(
      TEMPLATE_WEBHOOK_VALUE_SCHEMAS.template_category_update.parse(
        changes('template_category_update', recat.id)[0],
      ),
    ).toMatchObject({ previous_category: 'UTILITY', new_category: 'MARKETING' });
    expect(statusEvents(instant.id)).toEqual([]);
    expect(statusEvents(slow.id)).toEqual([]);
    const byName = Object.fromEntries((await fake.templates(ids.wabaId)).map((t) => [t.name, t]));
    expect(byName.promo_reject).toMatchObject({
      status: 'REJECTED',
      rejected_reason: 'INVALID_FORMAT',
    });
    expect(byName.promo_recategorize?.category).toBe('MARKETING');
    expect(byName.promo_slow?.status).toBe('PENDING');
    // Edit and resubmit: the edited `_reject` template is approved
    await fake.editTemplate(token, rejected.id, { components: body('promo_reject').components });
    await vi.waitFor(() => expect(statusEvents(rejected.id)).toEqual(['REJECTED', 'APPROVED']));
  });

  it('_pause: approved, then paused 1 s later (fake timers)', async () => {
    const { token, ids } = await connect();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Redis I/O is real: let it finish without real timers
    const settle = async (done: () => boolean) => {
      for (let i = 0; i < 5000 && !done(); i += 1) {
        await new Promise((r) => setImmediate(r));
      }
    };
    const t = await fake.createTemplate(token, ids.wabaId, body('sale_pause'));
    await vi.advanceTimersByTimeAsync(10);
    await settle(() => statusEvents(t.id).length === 1);
    expect(statusEvents(t.id)).toEqual(['APPROVED']);
    await vi.advanceTimersByTimeAsync(990);
    await new Promise((r) => setImmediate(r));
    expect(statusEvents(t.id)).toEqual(['APPROVED']);
    await vi.advanceTimersByTimeAsync(20);
    await settle(() => statusEvents(t.id).length === 2);
    expect(statusEvents(t.id)).toEqual(['APPROVED', 'PAUSED']);
    const paused = TEMPLATE_WEBHOOK_VALUE_SCHEMAS.message_template_status_update.parse(
      changes('message_template_status_update', t.id)[1],
    );
    expect(paused.other_info?.title).toBe('FIRST_PAUSE');
  });

  it('duplicate name + language → 2388023; another language is fine', async () => {
    const { token, ids } = await connect();
    await fake.createTemplate(token, ids.wabaId, body('dup_check_slow'));
    await expect(
      fake.createTemplate(token, ids.wabaId, body('dup_check_slow')),
    ).rejects.toMatchObject({ code: 100, subcode: 2388023 });
    await fake.createTemplate(token, ids.wabaId, body('dup_check_slow', { language: 'hi' }));
  });

  it('another account’s WABA / bad token are refused', async () => {
    const a = await connect();
    const b = await connect();
    await expect(fake.createTemplate(a.token, b.ids.wabaId, body('x_slow'))).rejects.toMatchObject({
      code: 100,
    });
    await expect(fake.listTemplates('nope', a.ids.wabaId)).rejects.toMatchObject({ code: 190 });
  });

  it('edit → PENDING and reviewed again; only approved / rejected / paused are editable', async () => {
    const { token, ids } = await connect();
    const slow = await fake.createTemplate(token, ids.wabaId, body('edit_me_slow'));
    await expect(
      fake.editTemplate(token, slow.id, { components: [{ type: 'BODY', text: 'Hello {{1}}' }] }),
    ).rejects.toMatchObject({ code: 100 });
    const t = await fake.createTemplate(token, ids.wabaId, body('edit_me'));
    await vi.waitFor(() => expect(statusEvents(t.id)).toEqual(['APPROVED']));
    await fake.editTemplate(token, t.id, {
      category: 'MARKETING',
      components: [{ type: 'BODY', text: 'Hello {{1}}' }],
      ttlSeconds: 600,
    });
    const after = (await fake.templates(ids.wabaId)).find((x) => x.id === t.id);
    expect(after).toMatchObject({
      status: 'PENDING',
      category: 'MARKETING',
      message_send_ttl_seconds: 600,
    });
    await vi.waitFor(() => expect(statusEvents(t.id)).toEqual(['APPROVED', 'APPROVED']));
    await expect(fake.editTemplate(token, 'fake_tpl_missing', {})).rejects.toMatchObject({
      code: 100,
    });
  });

  it('delete by name (all languages) or by hsm id; unknown → error', async () => {
    const { token, ids } = await connect();
    const en = await fake.createTemplate(token, ids.wabaId, body('gone_slow'));
    await fake.createTemplate(token, ids.wabaId, body('gone_slow', { language: 'hi' }));
    await fake.createTemplate(token, ids.wabaId, body('stay_slow'));
    await fake.deleteTemplate(token, ids.wabaId, { name: 'gone_slow', hsmId: en.id });
    expect((await fake.templates(ids.wabaId)).map((t) => `${t.name}:${t.language}`)).toEqual([
      'gone_slow:hi',
      'stay_slow:en',
    ]);
    await fake.deleteTemplate(token, ids.wabaId, { name: 'gone_slow' });
    expect((await fake.templates(ids.wabaId)).map((t) => t.name)).toEqual(['stay_slow']);
    await expect(
      fake.deleteTemplate(token, ids.wabaId, { name: 'gone_slow' }),
    ).rejects.toMatchObject({ code: 100 });
  });

  it('lists in creation order, 100 per page with a cursor', async () => {
    const { token, ids } = await connect();
    for (let i = 0; i < 3; i += 1) {
      await fake.createTemplate(token, ids.wabaId, body(`page_${String(i)}_slow`));
    }
    const first = await fake.listTemplates(token, ids.wabaId, { limit: 2 });
    expect(first.templates.map((t) => t.name)).toEqual(['page_0_slow', 'page_1_slow']);
    expect(first.after).not.toBeNull();
    const second = await fake.listTemplates(token, ids.wabaId, { limit: 2, after: first.after });
    expect(second.templates.map((t) => t.name)).toEqual(['page_2_slow']);
    expect(second.after).toBeNull();
    expect(second.templates[0]).toMatchObject({
      status: 'PENDING',
      category: 'UTILITY',
      parameterFormat: 'positional',
    });
  });

  it('uploadExample → handle; unsupported file refused', async () => {
    const { token } = await connect();
    expect(
      await fake.uploadExample(token, { bytes: Buffer.from('x'), mimeType: 'image/png' }),
    ).toMatch(/^fake_handle_[0-9a-f]{16}$/);
    await expect(
      fake.uploadExample(token, { bytes: Buffer.from('x'), mimeType: 'text/html' }),
    ).rejects.toMatchObject({ code: 100 });
  });

  it('patchTemplate changes a stored template (simulator)', async () => {
    const { token, ids } = await connect();
    const t = await fake.createTemplate(token, ids.wabaId, body('patch_slow'));
    expect(
      await fake.patchTemplate(ids.wabaId, t.id, { quality_score: { score: 'RED' } }),
    ).toMatchObject({
      quality_score: { score: 'RED' },
    });
    expect(await fake.patchTemplate(ids.wabaId, 'fake_tpl_none', {})).toBeNull();
  });

  it('failNext works for every new op', async () => {
    const { token, ids } = await connect();
    const ops = [
      () => fake.listTemplates(token, ids.wabaId),
      () => fake.createTemplate(token, ids.wabaId, body('fail_slow')),
      () => fake.editTemplate(token, 'x', {}),
      () => fake.deleteTemplate(token, ids.wabaId, { name: 'x' }),
      () => fake.uploadExample(token, { bytes: Buffer.from('x'), mimeType: 'image/png' }),
      () => fake.getPricingAnalytics(token, ids.wabaId, { start: new Date(0), end: new Date() }),
    ];
    const names = [
      'listTemplates',
      'createTemplate',
      'editTemplate',
      'deleteTemplate',
      'uploadExample',
      'getPricingAnalytics',
    ] as const;
    for (const [i, op] of ops.entries()) {
      fake.failNext(names[i]!);
      await expect(op()).rejects.toMatchObject({ status: 500 });
    }
  });
});

describe('fake Meta — pricing on statuses and template send knobs', () => {
  const pricingOf = (wamid: string) =>
    emitted
      .flatMap((b) => {
        const value = (b.entry as { changes: { value: unknown }[] }[])[0]?.changes[0]?.value;
        const parsed = inboxMessagesValueSchema.safeParse(value);
        return parsed.success ? (parsed.data.statuses ?? []) : [];
      })
      .filter((s) => s.id === wamid);

  const tpl = (to: string, name: string) =>
    buildTemplatePayload(to, {
      name,
      language: 'en',
      parameterFormat: 'positional',
      body: [{ key: '1', text: 'Test' }],
    });

  it('templates are billable in their category; service is free; failed has no pricing', async () => {
    const { token, ids } = await connect();
    await fake.createTemplate(token, ids.wabaId, body('ship_instant'));
    const { waMessageId: t } = await fake.sendMessage(
      token,
      ids.phoneNumberId,
      tpl('919000004001', 'ship_instant'),
    );
    const { waMessageId: s } = await fake.sendMessage(
      token,
      ids.phoneNumberId,
      buildMessagePayload('919000004002', { type: 'text', body: 'Test reply' }),
    );
    const { waMessageId: f } = await fake.sendMessage(
      token,
      ids.phoneNumberId,
      tpl('919000000009', 'ship_instant'),
    );
    await vi.waitFor(() => {
      expect(pricingOf(t)).toHaveLength(3);
      expect(pricingOf(s)).toHaveLength(3);
      expect(pricingOf(f)).toHaveLength(2);
    });
    for (const st of pricingOf(t)) {
      expect(st.pricing).toMatchObject({ billable: true, category: 'utility', type: 'regular' });
    }
    for (const st of pricingOf(s)) {
      expect(st.pricing).toMatchObject({
        billable: false,
        category: 'service',
        type: 'free_customer_service',
      });
    }
    const failed = pricingOf(f).find((x) => x.status === 'failed');
    expect(failed?.pricing ?? null).toBeNull();
    // unknown template name → marketing (Meta's most expensive guess)
    const { waMessageId: u } = await fake.sendMessage(
      token,
      ids.phoneNumberId,
      tpl('919000004003', 'not_created'),
    );
    await vi.waitFor(() => expect(pricingOf(u).length).toBeGreaterThan(0));
    expect(pricingOf(u)[0]?.pricing?.category).toBe('marketing');
  });

  it(`number knobs ${FAKE_TEMPLATE_KNOBS.serviceBillable}–${FAKE_TEMPLATE_KNOBS.marketingStopped}`, async () => {
    const { token, ids } = await connect();
    await fake.createTemplate(token, ids.wabaId, body('knob_instant'));
    const { waMessageId: paid } = await fake.sendMessage(
      token,
      ids.phoneNumberId,
      buildMessagePayload(`9190000${FAKE_TEMPLATE_KNOBS.serviceBillable}`, {
        type: 'text',
        body: 'Test reply',
      }),
    );
    const { waMessageId: free } = await fake.sendMessage(
      token,
      ids.phoneNumberId,
      tpl(`9190000${FAKE_TEMPLATE_KNOBS.freeEntryPoint}`, 'knob_instant'),
    );
    await vi.waitFor(() => {
      expect(pricingOf(paid).length).toBeGreaterThan(0);
      expect(pricingOf(free).length).toBeGreaterThan(0);
    });
    expect(pricingOf(paid)[0]?.pricing).toMatchObject({
      billable: true,
      category: 'service',
      type: 'regular',
    });
    expect(pricingOf(free)[0]?.pricing).toMatchObject({
      billable: false,
      category: 'utility',
      type: 'free_entry_point',
    });
    await expect(
      fake.sendMessage(
        token,
        ids.phoneNumberId,
        tpl(`9190000${FAKE_TEMPLATE_KNOBS.marketingLimited}`, 'knob_instant'),
      ),
    ).rejects.toMatchObject({ code: 131049 });
    await expect(
      fake.sendMessage(
        token,
        ids.phoneNumberId,
        tpl(`9190000${FAKE_TEMPLATE_KNOBS.marketingStopped}`, 'knob_instant'),
      ),
    ).rejects.toMatchObject({ code: 131050 });
    // the knobs only refuse templates
    await fake.sendMessage(
      token,
      ids.phoneNumberId,
      buildMessagePayload(`9190000${FAKE_TEMPLATE_KNOBS.marketingStopped}`, {
        type: 'text',
        body: 'Test reply',
      }),
    );
    const log = await fake.sentMessages(ids.phoneNumberId);
    expect(log.find((m) => m.waMessageId === free)).toMatchObject({
      templateName: 'knob_instant',
      pricingCategory: 'utility',
      billable: false,
    });
  });

  it('pricing analytics aggregate the billable sends per day and category', async () => {
    const { token, ids } = await connect();
    await fake.createTemplate(token, ids.wabaId, body('rep_instant', { category: 'MARKETING' }));
    for (const to of ['919000005001', '919000005002']) {
      await fake.sendMessage(token, ids.phoneNumberId, tpl(to, 'rep_instant'));
    }
    await fake.sendMessage(
      token,
      ids.phoneNumberId,
      buildMessagePayload('919000005003', { type: 'text', body: 'Test reply' }),
    );
    const points = await fake.getPricingAnalytics(token, ids.wabaId, {
      start: new Date(Date.now() - 86_400_000),
      end: new Date(Date.now() + 60_000),
    });
    expect(points).toEqual([
      expect.objectContaining({
        category: 'marketing',
        pricingType: 'regular',
        country: 'IN',
        volume: 2,
        cost: 1.7262,
      }),
    ]);
    expect(
      await fake.getPricingAnalytics(token, ids.wabaId, {
        start: new Date(0),
        end: new Date(1000),
      }),
    ).toEqual([]);
  });
});
