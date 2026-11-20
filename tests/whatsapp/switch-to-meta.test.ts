import type { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';

import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { clientFor, sealSecret } from '../../src/modules/whatsapp/context';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import {
  codeFor,
  fakeSignup,
  idsFor,
  insertChannel,
  userActor,
  useWhatsAppWorld,
} from '../helpers/whatsapp';

/** SAC-T11: a managed (Pinnacle) number moves to Meta direct on the same channel row. */
useTestDb();
useCapturedEmail();
const w = useWhatsAppWorld();

let acc: TestAccount;
let ownerId: Types.ObjectId;
beforeEach(async () => {
  acc = await createTestAccount();
  ownerId = (await acc.addUser('owner')).user._id;
});

const managed = async (signup = fakeSignup(), creditLine = 'partner_active') => {
  const ids = idsFor(signup);
  const ch = await insertChannel({
    accountId: acc.account._id,
    provider: 'pinnacle',
    wabaId: ids.wabaId,
    phoneNumberId: ids.phoneNumberId,
    displayPhoneNumber: signup.phone,
    tokenSealed: sealSecret(w.ctx, 'pin_test_switch_key_1234'),
    metaPayer: 'platform',
    creditLine: { status: creditLine, allocationConfigId: null, error: null, at: new Date() },
    pinnacle: {
      webhookUrl: 'https://example.test/hook',
      webhookSetAt: new Date(),
      keyLast4: '1234',
      keyCheckedAt: new Date(),
      lastBalanceErrorAt: null,
      addedBy: null,
    },
  } as never);
  return { signup, ids, id: ch._id.toString() };
};

describe('switch a managed number to Meta direct (SAC-T11)', () => {
  it('same channel id: provider meta, our token, webhook checked, partner line kept as payer', async () => {
    const m = await managed();
    const r = await w.svc.switchToMeta(
      acc.account._id,
      m.id,
      { code: codeFor(m.signup), wabaId: m.ids.wabaId, phoneNumberId: m.ids.phoneNumberId },
      userActor(ownerId),
    );
    expect(r.channel.id).toBe(m.id);
    const stored = await WhatsAppChannelModel.findById(m.id).lean();
    expect(stored).toMatchObject({
      provider: 'fake',
      pinnacle: null,
      creditLine: { status: 'attached' },
      pinnacleArchived: { keyLast4: '1234' },
    });
    expect(stored?.webhookCheck.status).toBe('ok');
    // sends and calls now use the Graph client of our app
    expect(clientFor(w.ctx, stored!).provider).toBe('fake');
    expect(
      await AuditLogModel.countDocuments({
        action: 'whatsapp.channel_switched_to_meta',
        'target.id': m.id,
      }),
    ).toBe(1);
    expect(await WhatsAppChannelModel.countDocuments({ accountId: acc.account._id })).toBe(1);
  });

  it('refuses another number, a Meta number, and a partner line not active yet', async () => {
    const m = await managed();
    const other = fakeSignup();
    await expect(
      w.svc.switchToMeta(
        acc.account._id,
        m.id,
        {
          code: codeFor(other),
          wabaId: idsFor(other).wabaId,
          phoneNumberId: idsFor(other).phoneNumberId,
        },
        userActor(ownerId),
      ),
    ).rejects.toMatchObject({ code: 'WHATSAPP_SWITCH_MISMATCH' });
    const meta = await insertChannel({ accountId: acc.account._id });
    await expect(
      w.svc.switchToMeta(
        acc.account._id,
        meta._id.toString(),
        { code: 'x', wabaId: meta.wabaId, phoneNumberId: meta.phoneNumberId ?? '' },
        userActor(ownerId),
      ),
    ).rejects.toMatchObject({ code: 'WHATSAPP_SWITCH_NOT_MANAGED' });
    const pending = await managed(fakeSignup(), 'partner_pending');
    await expect(
      w.svc.switchToMeta(
        acc.account._id,
        pending.id,
        {
          code: codeFor(pending.signup),
          wabaId: pending.ids.wabaId,
          phoneNumberId: pending.ids.phoneNumberId,
        },
        userActor(ownerId),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT_INVALID_STATE' });
  });

  it('a failed signup leaves the managed number as it was', async () => {
    const m = await managed();
    await expect(
      w.svc.switchToMeta(
        acc.account._id,
        m.id,
        { code: 'not-a-code', wabaId: m.ids.wabaId, phoneNumberId: m.ids.phoneNumberId },
        userActor(ownerId),
      ),
    ).rejects.toBeTruthy();
    const stored = await WhatsAppChannelModel.findById(m.id).lean();
    expect(stored).toMatchObject({
      provider: 'pinnacle',
      creditLine: { status: 'partner_active' },
    });
    expect(stored?.pinnacle?.keyLast4).toBe('1234');
  });
});
