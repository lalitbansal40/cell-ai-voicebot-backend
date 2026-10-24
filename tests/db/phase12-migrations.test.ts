import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import {
  CALLING_COLLECTIONS,
  CALLING_INDEXES,
} from '../../src/db/migrations/0013-whatsapp-calling';
import { DEFAULT_PERMISSION_REQUEST_BODY } from '../../src/db/models/whatsapp-channel.model';
import {
  PLACEHOLDER_CALLING_MARKETS,
  PLACEHOLDER_CALLING_RATE_CARD_NOTE,
} from '../../src/db/models/whatsapp-rate-card.model';
import { useTestDb } from '../helpers/db';

useTestDb();

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};
const migration = () => {
  const found = MIGRATIONS.find((m) => m.name === '0013-whatsapp-calling');
  if (!found) throw new Error('0013 missing');
  return found;
};
const collections = async () =>
  (await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
const indexNames = async (collection: string) =>
  (await db().collection(collection).indexes()).map((i) => i.name);

describe('0013-whatsapp-calling', () => {
  it('is registered right after 0012 and is the last one', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0013-whatsapp-calling')).toBe(
      names.indexOf('0012-templates-billing') + 1,
    );
    expect(names.at(-1)).toBe('0013-whatsapp-calling');
  });

  it('creates the collection and indexes, fills defaults, keeps existing values; idempotent', async () => {
    for (const name of CALLING_COLLECTIONS) {
      if ((await collections()).includes(name)) await db().collection(name).drop();
    }
    const accounts = db().collection('accounts');
    const custom = await accounts.insertOne({
      name: 'Custom notice',
      slug: 'p12-mig-custom',
      settings: { recordingNotice: 'Yeh call record ho rahi hai.' },
    });
    const bare = await accounts.insertOne({ name: 'Bare', slug: 'p12-mig-bare' });
    const kept = await accounts.insertOne({
      name: 'Kept',
      slug: 'p12-mig-kept',
      settings: {
        whatsappCalling: {
          recordCalls: false,
          recordingNotice: 'x',
          transcribeHumanCalls: true,
          maxCallMinutes: 10,
        },
      },
    });
    const channels = db().collection('whatsappChannels');
    const cloud = await channels.insertOne({ label: 'Cloud', mode: 'cloud_api' });
    const coex = await channels.insertOne({ label: 'App', mode: 'coexistence' });
    const card = await db()
      .collection('whatsappRateCards')
      .insertOne({ effectiveFrom: new Date(0), markets: [], note: 'messaging' });
    const user = await db().collection('users').insertOne({ email: 'p12-mig@example.com' });
    const busy = await db()
      .collection('users')
      .insertOne({ email: 'p12-mig-busy@example.com', callAvailability: 'offline' });
    const role = await db()
      .collection('roles')
      .insertOne({
        accountId: custom.insertedId,
        key: 'agent',
        name: 'Agent',
        isSystem: true,
        permissions: ['calls.read'],
      });
    const viewer = await db().collection('roles').insertOne({
      accountId: custom.insertedId,
      key: 'viewer',
      name: 'Viewer',
      isSystem: true,
      permissions: [],
    });
    const owner = await db().collection('roles').insertOne({
      accountId: custom.insertedId,
      key: 'owner',
      name: 'Owner',
      isSystem: true,
      permissions: [],
    });

    await migration().up(db());
    await migration().up(db());

    expect(await collections()).toEqual(expect.arrayContaining([...CALLING_COLLECTIONS]));
    expect(await db().collection('whatsappCallPermissions').indexes()).toContainEqual(
      expect.objectContaining({ key: { accountId: 1, channelId: 1, contactId: 1 }, unique: true }),
    );
    for (const [collection, names] of Object.entries(CALLING_INDEXES)) {
      expect(await indexNames(collection)).toEqual(expect.arrayContaining([...names]));
    }
    expect(await db().collection('calls').indexes()).toContainEqual(
      expect.objectContaining({ name: 'wa_call_id', unique: true }),
    );

    const calling = async (id: unknown): Promise<unknown> =>
      (await channels.findOne({ _id: id as never }))?.calling;
    expect(await calling(cloud.insertedId)).toMatchObject({
      status: 'disabled',
      unavailableReason: null,
      callIconVisibility: 'DEFAULT',
      iconCountries: [],
      inbound: { route: 'team', ringTimeoutSec: 30, ringUserIds: null, aiProgram: null },
      permissionRequestBody: DEFAULT_PERMISSION_REQUEST_BODY,
    });
    expect(await calling(coex.insertedId)).toMatchObject({
      status: 'unavailable',
      unavailableReason: 'coexistence',
    });

    const cards = db().collection('whatsappRateCards');
    expect(await cards.findOne({ _id: card.insertedId })).toMatchObject({
      kind: 'messaging',
      callingMarkets: [],
    });
    const callingCards = await cards.find({ kind: 'calling' }).toArray();
    expect(callingCards).toHaveLength(1);
    expect(callingCards[0]).toMatchObject({
      currency: 'INR',
      source: 'manual',
      note: PLACEHOLDER_CALLING_RATE_CARD_NOTE,
      markets: [],
      callingMarkets: PLACEHOLDER_CALLING_MARKETS,
    });
    expect(PLACEHOLDER_CALLING_MARKETS.map((m) => [m.market, m.perMinuteMicros])).toEqual([
      ['IN', 388_500],
      ['OTHER', 1_000_000],
    ]);

    expect(
      await db().collection('platformSettings').findOne({ key: 'whatsappCalling' }),
    ).toMatchObject({
      value: {
        markupBps: 1500,
        platformFeePerMinuteMicros: 0,
        holdMinutes: 5,
        holdExtendMinutes: 5,
      },
    });

    const settingsOf = async (id: unknown): Promise<Record<string, unknown> | undefined> =>
      (
        (await accounts.findOne({ _id: id as never }))?.settings as
          { whatsappCalling?: Record<string, unknown> } | undefined
      )?.whatsappCalling;
    expect(await settingsOf(custom.insertedId)).toEqual({
      recordCalls: true,
      recordingNotice: 'Yeh call record ho rahi hai.',
      transcribeHumanCalls: false,
      maxCallMinutes: 30,
    });
    expect((await settingsOf(bare.insertedId))?.recordingNotice).toMatch(/record/i);
    expect(await settingsOf(kept.insertedId)).toMatchObject({
      recordCalls: false,
      maxCallMinutes: 10,
    });

    expect(
      (await db().collection('users').findOne({ _id: user.insertedId }))?.callAvailability,
    ).toBe('available');
    expect(
      (await db().collection('users').findOne({ _id: busy.insertedId }))?.callAvailability,
    ).toBe('offline');
    const perms = async (id: unknown) =>
      ((
        await db()
          .collection('roles')
          .findOne({ _id: id as never })
      )?.permissions ?? []) as string[];
    expect(await perms(role.insertedId)).toContain('calls.answer');
    expect(await perms(role.insertedId)).not.toContain('whatsapp.calling.manage');
    expect(await perms(viewer.insertedId)).not.toContain('calls.answer');
    expect(await perms(owner.insertedId)).toEqual(
      expect.arrayContaining(['calls.answer', 'whatsapp.calling.manage']),
    );

    await accounts.deleteMany({
      _id: { $in: [custom.insertedId, bare.insertedId, kept.insertedId] },
    });
    await channels.deleteMany({ _id: { $in: [cloud.insertedId, coex.insertedId] } });
    await db()
      .collection('users')
      .deleteMany({ _id: { $in: [user.insertedId, busy.insertedId] } });
    await db()
      .collection('roles')
      .deleteMany({ _id: { $in: [role.insertedId, viewer.insertedId, owner.insertedId] } });
  });

  it('keeps an existing calling card and settings row', async () => {
    await migration().up(db());
    await db()
      .collection('platformSettings')
      .updateOne({ key: 'whatsappCalling' }, { $set: { 'value.markupBps': 2000 } });
    await migration().up(db());
    expect(
      (await db().collection('platformSettings').findOne({ key: 'whatsappCalling' }))?.value
        .markupBps,
    ).toBe(2000);
    expect(await db().collection('whatsappRateCards').countDocuments({ kind: 'calling' })).toBe(1);
  });

  it('refuses to roll back while WhatsApp calls or call charges exist, else removes everything', async () => {
    await migration().up(db());
    const charge = await db()
      .collection('ledgerEntries')
      .insertOne({ type: 'whatsapp_call_charge' });
    await expect(migration().down(db())).rejects.toThrow(
      '0013-whatsapp-calling: refusing to roll back',
    );
    await db().collection('ledgerEntries').deleteOne({ _id: charge.insertedId });
    const call = await db().collection('calls').insertOne({ provider: 'whatsapp' });
    await expect(migration().down(db())).rejects.toThrow(
      '0013-whatsapp-calling: refusing to roll back',
    );
    await db().collection('calls').deleteOne({ _id: call.insertedId });

    const account = await db()
      .collection('accounts')
      .insertOne({
        name: 'N',
        slug: 'p12-mig-n',
        settings: { recordingEnabled: true },
        whatsappCallingBilling: { markupBps: 1 },
      });
    const contact = await db()
      .collection('contacts')
      .insertOne({ phoneE164: '+919000099121', whatsapp: { waId: '919000099121', bsuid: 'IN.1' } });
    const user = await db().collection('users').insertOne({ email: 'p12-down@example.com' });
    const role = await db()
      .collection('roles')
      .insertOne({
        key: 'owner',
        isSystem: true,
        permissions: ['calls.answer', 'whatsapp.calling.manage', 'calls.read'],
      });
    await migration().up(db());
    await migration().down(db());

    const left = await collections();
    for (const name of CALLING_COLLECTIONS) expect(left).not.toContain(name);
    for (const [collection, names] of Object.entries(CALLING_INDEXES)) {
      const present = await indexNames(collection);
      for (const name of names) expect(present).not.toContain(name);
    }
    expect(
      await db()
        .collection('whatsappChannels')
        .countDocuments({ calling: { $exists: true } }),
    ).toBe(0);
    expect(await db().collection('whatsappRateCards').countDocuments({ kind: 'calling' })).toBe(0);
    expect(
      await db()
        .collection('whatsappRateCards')
        .countDocuments({ kind: { $exists: true } }),
    ).toBe(0);
    expect(
      await db().collection('platformSettings').findOne({ key: 'whatsappCalling' }),
    ).toBeNull();
    const acc = await db().collection('accounts').findOne({ _id: account.insertedId });
    expect(acc?.settings).toEqual({ recordingEnabled: true });
    expect(acc).not.toHaveProperty('whatsappCallingBilling');
    expect(
      (await db().collection('contacts').findOne({ _id: contact.insertedId }))?.whatsapp,
    ).toEqual({
      waId: '919000099121',
    });
    expect(await db().collection('users').findOne({ _id: user.insertedId })).not.toHaveProperty(
      'callAvailability',
    );
    expect((await db().collection('roles').findOne({ _id: role.insertedId }))?.permissions).toEqual(
      ['calls.read'],
    );
    await db().collection('accounts').deleteOne({ _id: account.insertedId });
    await db().collection('contacts').deleteOne({ _id: contact.insertedId });
    await db().collection('users').deleteOne({ _id: user.insertedId });
    await db().collection('roles').deleteOne({ _id: role.insertedId });
    await migration().up(db());
  });
});
