import { beforeEach, describe, expect, it } from 'vitest';

import type { FakeManagedNumber } from '../../src/core/meta';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import { SYSTEM_ACTOR } from '../../src/modules/whatsapp/channel-status';
import { sealSecret } from '../../src/modules/whatsapp/context';
import { runHealthPass } from '../../src/modules/whatsapp/health';
import { pinnacleWebhookUrl } from '../../src/modules/whatsapp/pinnacle-webhooks.service';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { codeFor, fakeSignup, userActor, useWhatsAppWorld } from '../helpers/whatsapp';

useTestDb();
const w = useWhatsAppWorld({ PINNACLE_ENABLED: 'true' });

let acc: TestAccount;
let n = 0;

beforeEach(async () => {
  acc = await createTestAccount();
  w.pinnacle.ignoreWebhookWrites(false);
});

const seed = (): Promise<FakeManagedNumber> => {
  n += 1;
  return w.pinnacle.seedManagedNumber({
    businessName: `Health ${String(Date.now())} ${String(n)}`,
    phone: `+91 96${String(Date.now()).slice(-3)} ${String(n).padStart(5, '0')}`,
  });
};

const addManaged = async (creditLine: 'partner_pending' | 'partner_active' = 'partner_active') => {
  const num = await seed();
  const r = await w.svc.connectManaged({
    accountId: acc.account._id,
    actor: userActor(),
    label: 'Managed',
    wabaId: num.wabaId,
    phoneNumberId: num.phoneNumberId,
    apiKey: num.apiKey,
    creditLine,
  });
  return { num, id: r.channel.id };
};

/** The channel as the health job reads it (secrets included). */
const full = (id: string) =>
  WhatsAppChannelModel.findById(id)
    .select('+tokenSealed +pinnacle.webhookSecretSealed')
    .lean<WhatsAppChannelDoc>();
const sync = async (id: string) => w.svc.syncChannel((await full(id))!, SYSTEM_ACTOR);

describe('health / sync of managed numbers (PN-T8, D17)', () => {
  it('healthy: connected, key checked, no Meta debug_token', async () => {
    const { id } = await addManaged();
    w.fake.calls.length = 0;
    const after = await sync(id);
    expect(after.status).toBe('connected');
    expect(after.pinnacle?.keyCheckedAt).toBeInstanceOf(Date);
    expect(w.fake.calls.map((c) => c.op)).not.toContain('debugToken');
  });

  it('the partner rejects the key → needs_reconnect provider_key_invalid', async () => {
    const { id } = await addManaged();
    await WhatsAppChannelModel.updateOne(
      { _id: id },
      { $set: { tokenSealed: sealSecret(w.ctx, 'pin_bad_0123456789') } },
    );
    const after = await sync(id);
    expect(after.status).toBe('needs_reconnect');
    expect(after.statusReason?.code).toBe('provider_key_invalid');
  });

  it('the key no longer lists the number → provider_number_missing', async () => {
    const { id } = await addManaged();
    const other = await seed();
    await WhatsAppChannelModel.updateOne(
      { _id: id },
      { $set: { tokenSealed: sealSecret(w.ctx, other.apiKey) } },
    );
    const after = await sync(id);
    expect(after.statusReason?.code).toBe('provider_number_missing');
  });

  it('the webhook was changed at the partner → set again once (system audit), still connected', async () => {
    const { num, id } = await addManaged();
    await w.pinnacle.overwriteWebhook(num.phoneNumberId, {
      url: 'https://elsewhere.example.test/hook',
      headers: {},
    });
    const after = await sync(id);
    expect(after.status).toBe('connected');
    expect((await w.pinnacle.getWebhook(num.apiKey, num.phoneNumberId))?.url).toBe(
      pinnacleWebhookUrl(w.env, id),
    );
    expect(
      await AuditLogModel.findOne({
        action: 'whatsapp.managed_webhook_reset',
        'target.id': id,
        'meta.automatic': true,
      }).lean(),
    ).toBeTruthy();
  });

  it('the partner keeps losing it → action_needed provider_webhook_mismatch; fixed → connected', async () => {
    const { num, id } = await addManaged();
    await w.pinnacle.overwriteWebhook(num.phoneNumberId, null);
    w.pinnacle.ignoreWebhookWrites(true);
    const broken = await sync(id);
    expect(broken.status).toBe('action_needed');
    expect(broken.statusReason?.code).toBe('provider_webhook_mismatch');
    w.pinnacle.ignoreWebhookWrites(false);
    expect((await sync(id)).status).toBe('connected');
  });

  it('restricted at Meta → restricted; credit line requested stays action_needed', async () => {
    const restricted = await addManaged();
    await w.fake.patchPhone(restricted.num.phoneNumberId, { status: 'RESTRICTED' });
    expect((await sync(restricted.id)).status).toBe('restricted');
    const pending = await addManaged('partner_pending');
    const after = await sync(pending.id);
    expect(after.status).toBe('action_needed');
    expect(after.statusReason?.code).toBe('partner_credit_line_pending');
  });

  it('a row read without its secrets still syncs correctly (secrets re-read)', async () => {
    const { id } = await addManaged();
    const bare = (await WhatsAppChannelModel.findById(id).lean<WhatsAppChannelDoc>())!;
    expect((await w.svc.syncChannel(bare, SYSTEM_ACTOR)).status).toBe('connected');
  });

  it('the daily pass handles Meta and managed numbers together; one failure never stops it', async () => {
    const managed = await addManaged();
    const broken = await addManaged();
    await WhatsAppChannelModel.updateOne(
      { _id: broken.id },
      { $set: { tokenSealed: sealSecret(w.ctx, 'pin_bad_0123456789') } },
    );
    const signup = fakeSignup();
    await w.svc.connect({
      accountId: acc.account._id,
      actor: userActor(),
      mode: 'cloud_api',
      code: codeFor(signup),
    });
    const result = await runHealthPass(w.svc);
    expect(result.checked).toBeGreaterThanOrEqual(3);
    expect((await full(managed.id))?.status).toBe('connected');
    expect((await full(broken.id))?.status).toBe('needs_reconnect');
  });
});
