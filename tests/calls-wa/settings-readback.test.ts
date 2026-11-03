import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { CallingSettingsPatch } from '../../src/modules/whatsapp-calling/calling.schema';
import { createCallingSettings } from '../../src/modules/whatsapp-calling/settings.service';
import { createCallingHooks } from '../../src/modules/whatsapp-calling/webhooks';
import { useTestDb } from '../helpers/db';
import { useInboxWorld } from '../helpers/inbox';
import { userActor } from '../helpers/whatsapp';

useTestDb();
const world = useInboxWorld();
const { state } = world;
let settings: ReturnType<typeof createCallingSettings>;

beforeAll(() => {
  settings = createCallingSettings({
    ctx: world.w.ctx,
    token: (id) => world.w.svc.getChannelToken(id),
  });
  state.h.calling = createCallingHooks({ settings });
});
beforeEach(async () => {
  await world.setup();
  world.w.fake.ignoreCallingSettingsWrites(false);
});
afterEach(() => world.w.fake.ignoreCallingSettingsWrites(false));

const accountId = () => state.acc.account._id;
const channelId = () => state.channel._id.toString();
const update = (patch: unknown) =>
  settings.updateCalling(userActor(), accountId(), channelId(), CallingSettingsPatch.parse(patch));

describe('calling settings read-back (T18B.1)', () => {
  it('stores what WhatsApp reports after the write', async () => {
    const view = await update({ status: 'enabled' });
    expect(view.status).toBe('enabled');
    const row = await WhatsAppChannelModel.findById(state.channel._id).lean();
    expect(row?.calling?.syncedAt).toBeInstanceOf(Date);
    expect(row?.calling?.lastError).toBeNull();
  });

  it('WhatsApp said success but did not apply it: an error, and the stored state is WhatsApp’s', async () => {
    world.w.fake.ignoreCallingSettingsWrites(true);
    await expect(update({ status: 'enabled' })).rejects.toMatchObject({
      code: 'CALLING_SETTINGS_NOT_APPLIED',
    });
    const view = await settings.getCalling(accountId(), channelId());
    expect(view.status).toBe('disabled');
    const row = await WhatsAppChannelModel.findById(state.channel._id).lean();
    expect(row?.calling?.lastError).toMatch(/did not apply/);
  });

  it('checks the call button visibility too', async () => {
    await update({ status: 'enabled' });
    world.w.fake.ignoreCallingSettingsWrites(true);
    await expect(update({ callIconVisibility: 'DISABLE_ALL' })).rejects.toMatchObject({
      code: 'CALLING_SETTINGS_NOT_APPLIED',
    });
    expect((await settings.getCalling(accountId(), channelId())).callIconVisibility).toBe(
      'DEFAULT',
    );
  });

  it('our own settings (routing) save without a WhatsApp write', async () => {
    world.w.fake.ignoreCallingSettingsWrites(true);
    const view = await update({ inbound: { ringTimeoutSec: 25 } });
    expect(view.inbound.ringTimeoutSec).toBe(25);
  });
});
