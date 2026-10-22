import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it } from 'vitest';

import { graphError } from '../../src/core/meta';
import { processWhatsAppJob } from '../../src/core/queues/workers/whatsapp.worker';
import { NotificationModel, type NotificationType } from '../../src/db/models/notification.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import { runHealthPass } from '../../src/modules/whatsapp/health';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { codeFor, fakeSignup, idsFor, userActor, useWhatsAppWorld } from '../helpers/whatsapp';

useTestDb();
const emails = useCapturedEmail();
const w = useWhatsAppWorld();

let acc: TestAccount;
beforeEach(async () => {
  // only this test's channels are active
  await WhatsAppChannelModel.updateMany({}, { $set: { status: 'disconnected' } });
  acc = await createTestAccount();
  await acc.addUser('owner');
  await acc.addUser('admin');
});

const connect = async (over = {}) => {
  const signup = fakeSignup(over);
  const r = await w.svc.connect({
    accountId: acc.account._id,
    actor: userActor(),
    mode: signup.mode,
    code: codeFor(signup),
  });
  return { id: r.channel.id, ids: idsFor(signup) };
};
const channelOf = (id: string) => WhatsAppChannelModel.findById(id).lean<WhatsAppChannelDoc>();
const notes = (type: NotificationType) =>
  NotificationModel.countDocuments({ accountId: acc.account._id, type });

describe('health pass', () => {
  it('connected → needs reconnect (once) → reconnect → connected', async () => {
    const signup = fakeSignup();
    const r = await w.svc.connect({
      accountId: acc.account._id,
      actor: userActor(),
      mode: 'cloud_api',
      code: codeFor(signup),
    });
    await w.fake.revokeToken((await w.svc.getChannelToken(r.channel.id)).token);
    const first = await runHealthPass(w.svc);
    expect(first).toEqual({ checked: 1, failed: 0, byStatus: { needs_reconnect: 1 } });
    await runHealthPass(w.svc);
    expect(await notes('whatsapp.channel_needs_reconnect')).toBe(2); // owner + admin, once
    expect(emails.filter((e) => e.template === 'whatsapp.needs_reconnect')).toHaveLength(2);
    await w.svc.connect({
      accountId: acc.account._id,
      actor: userActor(),
      mode: 'cloud_api',
      code: codeFor({ ...signup }),
    });
    expect((await runHealthPass(w.svc)).byStatus).toEqual({ connected: 1 });
  });

  it('restricted → lifted; quality red notifies once across three runs; names', async () => {
    const { id, ids } = await connect({ displayName: 'Pending Name Co' });
    await w.fake.patchPhone(ids.phoneNumberId, { status: 'BANNED', quality_rating: 'RED' });
    await runHealthPass(w.svc);
    expect((await channelOf(id))?.status).toBe('restricted');
    await runHealthPass(w.svc);
    await runHealthPass(w.svc);
    expect(await notes('whatsapp.quality_low')).toBe(2);
    expect(await notes('whatsapp.channel_restricted')).toBe(2);
    await w.fake.patchPhone(ids.phoneNumberId, {
      status: 'CONNECTED',
      name_status: 'APPROVED',
      new_name_status: 'DECLINED',
    });
    await runHealthPass(w.svc);
    expect(await channelOf(id)).toMatchObject({ status: 'connected', nameStatus: 'APPROVED' });
    expect(await notes('whatsapp.name_approved')).toBe(2);
    expect(await notes('whatsapp.name_rejected')).toBe(2);
    await runHealthPass(w.svc);
    expect(await notes('whatsapp.name_approved')).toBe(2);
  });

  it('a failing channel is counted and does not stop the others; accounts run in parallel', async () => {
    await connect();
    await connect();
    const other = await createTestAccount();
    const signup = fakeSignup();
    await w.svc.connect({
      accountId: other.account._id,
      actor: userActor(),
      mode: 'cloud_api',
      code: codeFor(signup),
    });
    w.fake.failNext(
      'getWaba',
      graphError(400, { error: { code: 100, type: 'GraphMethodException' } }),
    );
    w.fake.failNext('debugToken', new Error('bug') as never);
    const result = await runHealthPass(w.svc, 2);
    expect(result).toMatchObject({ checked: 3, failed: 2, byStatus: { connected: 1 } });
    expect((await runHealthPass(w.svc, 0)).checked).toBe(3);
  });

  it('the worker runs the health job', async () => {
    await connect();
    const run = processWhatsAppJob({ ctx: w.ctx, service: w.svc });
    expect(await run({ name: 'whatsapp-health', data: {} } as Job)).toMatchObject({ checked: 1 });
  });
});
