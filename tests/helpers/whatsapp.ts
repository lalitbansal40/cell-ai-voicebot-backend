import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll } from 'vitest';

import type { Env } from '../../src/config/env';
import { secretBoxKey } from '../../src/core/ai/secret-box';
import {
  buildFakeCode,
  createFakeMetaClient,
  fakeIds,
  type FakeMetaClient,
  type FakeSignup,
} from '../../src/core/meta';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import type { WaActor } from '../../src/modules/whatsapp/channel-status';
import type { WhatsAppContext } from '../../src/modules/whatsapp/context';
import {
  createWhatsAppService,
  type WhatsAppService,
} from '../../src/modules/whatsapp/whatsapp.service';

import { flushPrefix, requireRedis, uniquePrefix } from './redis';
import { testEnv } from './test-app';

export interface WhatsAppWorld {
  redis: Redis;
  fake: FakeMetaClient;
  env: Env;
  ctx: WhatsAppContext;
  svc: WhatsAppService;
}

/** Redis + fake Meta (unique prefix) + the channel service for one test file. */
export const useWhatsAppWorld = (env: NodeJS.ProcessEnv = {}): WhatsAppWorld => {
  const world = {} as WhatsAppWorld;
  const prefix = uniquePrefix('wa');
  beforeAll(async () => {
    world.redis = (await requireRedis()).client;
    world.env = testEnv(env);
    world.fake = createFakeMetaClient({
      redis: world.redis,
      prefix,
      appSecret: world.env.FAKE_META_APP_SECRET ?? 'dev-fake-meta-app-secret',
    });
    world.ctx = {
      env: world.env,
      meta: world.fake,
      redis: world.redis,
      key: secretBoxKey(world.env),
    };
    world.svc = createWhatsAppService(world.ctx);
    await WhatsAppChannelModel.createIndexes();
  });
  afterAll(async () => {
    await flushPrefix(world.redis, prefix);
    await flushPrefix(world.redis, 'wa-rl-');
    world.redis.disconnect();
  });
  return world;
};

let n = 0;
/** A unique fake signup (business + phone) unless overridden. */
export const fakeSignup = (over: Partial<FakeSignup> = {}): FakeSignup => {
  n += 1;
  const tag = randomBytes(3).toString('hex');
  return {
    businessName: `Test Business ${tag}`,
    phone: `+91 9${String(Date.now() % 1000).padStart(3, '0')}${String(n % 10)} 1${String(n).padStart(4, '0')}`,
    displayName: 'Test Business',
    mode: 'cloud_api',
    outcome: 'finish',
    ...over,
  };
};

export const codeFor = (signup: FakeSignup): string => buildFakeCode(signup);
export const idsFor = (signup: FakeSignup) => fakeIds(signup.businessName, signup.phone);

export const userActor = (id: Types.ObjectId = new Types.ObjectId()): WaActor => ({
  type: 'user',
  id,
});

/** A channel row inserted directly (limits / WABA sharing tests). */
export const insertChannel = (over: Partial<WhatsAppChannelDoc> = {}) =>
  WhatsAppChannelModel.create({
    accountId: new Types.ObjectId(),
    label: 'Other',
    provider: 'fake',
    mode: 'cloud_api',
    wabaId: `fake_waba_${randomBytes(6).toString('hex')}`,
    phoneNumberId: `fake_phone_${randomBytes(6).toString('hex')}`,
    metaPayer: 'platform',
    status: 'connected',
    ...over,
  });

const FIXTURE_DIR = join(__dirname, '../fixtures/meta');

/**
 * A Meta webhook fixture pointed at a channel: the WABA id, phone number id and
 * display number of the fixture are replaced by the channel's.
 */
export const webhookFor = (
  fixture: string,
  channel: { wabaId: string; phoneNumberId: string | null; displayPhoneNumber: string | null },
): Record<string, unknown> => {
  const text = readFileSync(join(FIXTURE_DIR, fixture), 'utf8')
    .replaceAll('102290129340398', channel.wabaId)
    .replaceAll('106540352242922', channel.phoneNumberId ?? 'none')
    .replaceAll('919000000010', (channel.displayPhoneNumber ?? '').replace(/\D/g, ''));
  return JSON.parse(text) as Record<string, unknown>;
};
