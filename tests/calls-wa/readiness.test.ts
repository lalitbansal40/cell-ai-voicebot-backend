import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import {
  PLACEHOLDER_CALLING_RATE_CARD_NOTE,
  WhatsAppRateCardModel,
} from '../../src/db/models/whatsapp-rate-card.model';
import {
  blockingProblem,
  readinessItems,
  READINESS_KEYS,
  type ReadinessFacts,
} from '../../src/modules/whatsapp-calling/readiness';
import {
  createCallingRuntime,
  type CallingRuntime,
} from '../../src/modules/whatsapp-calling/runtime';
import { useTestDb } from '../helpers/db';
import { useInboxWorld } from '../helpers/inbox';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const world = useInboxWorld();
const { state } = world;
let runtime: CallingRuntime;
let users: Awaited<ReturnType<typeof world.setup>>['users'];
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const app = () =>
  buildTestApp(
    {},
    {
      whatsapp: {
        ctx: world.w.ctx,
        jobs: { enqueueEvent: () => Promise.resolve() },
        inboxJobs: world.jobs,
        storage: world.storage,
        calling: runtime,
      },
    },
  );
const path = () => `/api/v1/whatsapp/channels/${state.channel._id.toString()}/calling`;

beforeAll(() => {
  runtime = createCallingRuntime({ ctx: world.w.ctx, service: world.w.svc, inbox: state.ix });
  state.h.calling = runtime.hooks;
});
beforeEach(async () => {
  ({ users } = await world.setup());
  world.w.fake.setAppSubscriptionFields(['messages', 'calls']);
  await world.w.ctx.redis.del('wa:readiness:calls-webhook');
});

const facts = (over: Partial<ReadinessFacts> = {}): ReadinessFacts => ({
  channel: {
    mode: 'cloud',
    isOnBizApp: false,
    platformType: 'CLOUD_API',
    messagingLimitTier: 'TIER_10K',
    businessVerificationStatus: 'verified',
    calling: undefined,
  } as never,
  callsWebhook: true,
  appPermission: true,
  media: { enabled: true, publicIpNeeded: true, publicIpSet: true, portFree: true },
  pricesImported: true,
  now: new Date(),
  ...over,
});
const item = (f: ReadinessFacts, key: string) => readinessItems(f).find((i) => i.key === key)!;

describe('calling readiness (T18B.2)', () => {
  it('lists the ten items in a fixed order; a good number has nothing blocking', () => {
    const items = readinessItems(facts());
    expect(items.map((i) => i.key)).toEqual([...READINESS_KEYS]);
    expect(blockingProblem(items)).toBeNull();
    expect(item(facts(), 'meta_status')).toMatchObject({
      ok: false,
      fix: expect.stringContaining('Turn calling on'),
    });
    expect(item(facts(), 'last_calls_webhook')).toMatchObject({ ok: null, fix: null });
  });

  it('a low messaging tier blocks with how the limit grows', () => {
    const f = facts({ channel: { ...facts().channel, messagingLimitTier: 'TIER_250' } as never });
    expect(item(f, 'messaging_limit')).toMatchObject({
      ok: false,
      detail: 'Messaging limit: 250 a day',
    });
    expect(blockingProblem(readinessItems(f))?.key).toBe('messaging_limit');
    expect(blockingProblem(readinessItems(f))?.fix).toMatch(/2,000 a day/);
  });

  it('coexistence, other platforms and unknowns', () => {
    expect(item(facts({ channel: { ...facts().channel, isOnBizApp: true } }), 'cloud_api').ok).toBe(
      false,
    );
    expect(
      item(facts({ channel: { ...facts().channel, platformType: 'ON_PREMISE' } }), 'cloud_api'),
    ).toMatchObject({ ok: false, detail: 'Platform: ON_PREMISE' });
    const unknown = facts({
      channel: {
        ...facts().channel,
        platformType: null,
        messagingLimitTier: null,
        businessVerificationStatus: null,
      },
      callsWebhook: null,
      appPermission: null,
      pricesImported: null,
    });
    for (const key of [
      'cloud_api',
      'messaging_limit',
      'business_verified',
      'calls_webhook',
      'app_permission',
      'prices',
    ]) {
      expect(item(unknown, key).ok).toBeNull();
    }
    expect(blockingProblem(readinessItems(unknown))).toBeNull();
    expect(
      item(
        facts({ channel: { ...facts().channel, businessVerificationStatus: 'pending' } }),
        'business_verified',
      ).fix,
    ).toMatch(/Verify the business/);
  });

  it('webhook field, app permission, media and prices', () => {
    expect(blockingProblem(readinessItems(facts({ callsWebhook: false })))?.key).toBe(
      'calls_webhook',
    );
    expect(item(facts({ appPermission: false }), 'app_permission').fix).toMatch(
      /Connect the number again/,
    );
    expect(blockingProblem(readinessItems(facts({ appPermission: false })))).toBeNull();
    const noIp = facts({
      media: { enabled: true, publicIpNeeded: true, publicIpSet: false, portFree: true },
    });
    expect(item(noIp, 'media')).toMatchObject({
      ok: false,
      detail: 'No public IP set for call audio',
    });
    expect(
      item(
        facts({
          media: { enabled: false, publicIpNeeded: false, publicIpSet: false, portFree: null },
        }),
        'media',
      ).detail,
    ).toBe('Call audio is off on this server');
    expect(
      item(
        facts({
          media: { enabled: true, publicIpNeeded: false, publicIpSet: false, portFree: null },
        }),
        'media',
      ).ok,
    ).toBe(true);
    expect(item(facts({ pricesImported: false }), 'prices').fix).toMatch(/import Meta/);
    expect(item(facts({ pricesImported: null }), 'prices').detail).toBe('No calling price card');
  });

  it('restrictions and the last calls event', () => {
    const f = facts({
      channel: {
        ...facts().channel,
        calling: {
          status: 'enabled',
          restrictions: [
            { type: 'RESTRICTED_BUSINESS_INITIATED_CALLING', reason: null, expiresAt: null },
          ],
          lastCallsWebhookAt: new Date('2026-11-04T10:00:00Z'),
          syncedAt: new Date(),
        },
      } as never,
    });
    expect(item(f, 'restrictions')).toMatchObject({
      ok: false,
      detail: 'RESTRICTED_BUSINESS_INITIATED_CALLING',
    });
    expect(item(f, 'last_calls_webhook')).toMatchObject({
      ok: true,
      detail: 'Last call event 2026-11-04 10:00 UTC',
    });
    expect(item(f, 'meta_status').ok).toBe(true);
  });

  it('GET readiness over HTTP reads Meta once an hour and the price card', async () => {
    const res = await request(app()).get(`${path()}/readiness`).set(bearer(users.viewer.token));
    expect(res.status).toBe(200);
    const by = Object.fromEntries(
      (res.body.data.items as { key: string; ok: boolean | null }[]).map((i) => [i.key, i.ok]),
    );
    expect(by).toMatchObject({ calls_webhook: true, app_permission: true });
    world.w.fake.setAppSubscriptionFields(['messages']);
    const cached = await request(app()).get(`${path()}/readiness`).set(bearer(users.viewer.token));
    expect(cached.body.data.items.find((i: { key: string }) => i.key === 'calls_webhook').ok).toBe(
      true,
    );
    await world.w.ctx.redis.del('wa:readiness:calls-webhook');
    const fresh = await request(app()).get(`${path()}/readiness`).set(bearer(users.viewer.token));
    expect(fresh.body.data.items.find((i: { key: string }) => i.key === 'calls_webhook').ok).toBe(
      false,
    );
    expect(fresh.body.data.ready).toBe(false);
    const card = await WhatsAppRateCardModel.findOne({ kind: 'calling' })
      .sort({ effectiveFrom: -1 })
      .lean();
    const expected = card ? card.note !== PLACEHOLDER_CALLING_RATE_CARD_NOTE : null;
    expect(fresh.body.data.items.find((i: { key: string }) => i.key === 'prices').ok).toBe(
      expected,
    );
  });

  it('turning calling on is refused while a blocking item fails, with its fix', async () => {
    world.w.fake.setAppSubscriptionFields(['messages']);
    const res = await request(app())
      .patch(path())
      .set(bearer(users.owner.token))
      .send({ status: 'enabled' });
    expect(res.status).toBe(422);
    expect(res.body.error.details[0]).toMatchObject({
      path: 'readiness.calls_webhook',
      message: expect.stringContaining('calls'),
    });
    world.w.fake.setAppSubscriptionFields(['messages', 'calls']);
    await world.w.ctx.redis.del('wa:readiness:calls-webhook');
    const ok = await request(app())
      .patch(path())
      .set(bearer(users.owner.token))
      .send({ status: 'enabled' });
    expect(ok.status).toBe(200);
  });

  it('a calls webhook stamps the number (the path works end to end)', async () => {
    world.w.fake.setWebhookEmitter(async (payload) => {
      await world.deliver(payload);
    });
    expect(
      (await WhatsAppChannelModel.findById(state.channel._id).lean())?.calling
        ?.lastCallsWebhookAt ?? null,
    ).toBeNull();
    await world.w.fake.userCall(state.channel.phoneNumberId ?? '', '919000000077');
    await expect
      .poll(
        async () =>
          (await WhatsAppChannelModel.findById(state.channel._id).lean())?.calling
            ?.lastCallsWebhookAt,
      )
      .toBeInstanceOf(Date);
    await world.w.fake.stopCalls();
  });
});
