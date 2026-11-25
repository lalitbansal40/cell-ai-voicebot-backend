import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { inboundChannelFor } from '../../src/modules/whatsapp-calling/calls.service';
import { useTestDb } from '../helpers/db';
import { insertChannel } from '../helpers/whatsapp';

/**
 * WCF: the calls fast path picks the active row of a phone number id. A number that was
 * connected before (now disconnected) and added again as a managed number has two rows with the
 * same phone number id; the old one has no token and calling off, so taking it refused every
 * incoming call as "calling paused" and never rang the team.
 */
useTestDb();

describe('inboundChannelFor (WCF)', () => {
  it('takes the active row, never a disconnected one of the same number', async () => {
    const accountId = new Types.ObjectId();
    const phoneNumberId = `fake_phone_${new Types.ObjectId().toString().slice(-12)}`;
    const active = await insertChannel({
      accountId,
      label: 'Cell',
      provider: 'pinnacle',
      phoneNumberId,
      status: 'connected',
    });
    // the old row is the most recently touched one: order alone would pick it
    await insertChannel({ accountId, label: 'Cell24x7', phoneNumberId, status: 'disconnected' });
    const found = await inboundChannelFor(phoneNumberId);
    expect(found?._id.toString()).toBe(active._id.toString());

    await WhatsAppChannelModel.updateOne({ _id: active._id }, { $set: { status: 'disconnected' } });
    expect(await inboundChannelFor(phoneNumberId)).toBeNull();
  });
});
