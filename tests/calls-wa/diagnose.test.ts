import { describe, expect, it } from 'vitest';

import { graphError } from '../../src/core/meta';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { MetaCallErrorModel } from '../../src/db/models/meta-call-error.model';
import { createCallingDiagnose } from '../../src/modules/whatsapp-calling/diagnose.service';
import { useTestDb } from '../helpers/db';
import { useInboxWorld } from '../helpers/inbox';
import { userActor } from '../helpers/whatsapp';

useTestDb();
const world = useInboxWorld();
const { state } = world;

describe('WhatsApp calling diagnose', () => {
  it('runs safe checks, audits the result, and records masked Meta failures', async () => {
    await world.setup();
    await world.w.fake.updateCallingSettings(state.token, state.channel.phoneNumberId ?? '', {
      status: 'ENABLED',
    });
    await world.w.fake.subscribeApp(state.token, state.channel.wabaId);
    const diagnose = createCallingDiagnose(world.w.ctx, () =>
      Promise.resolve({
        channel: state.channel,
        token: state.token,
      }),
    );
    const result = await diagnose.diagnose(
      state.acc.account._id,
      state.channel._id.toString(),
      userActor(),
      {},
    );
    expect(result.steps.map((step) => step.key)).toEqual([
      'token',
      'phone',
      'settings',
      'webhook',
      'send',
    ]);
    expect(result.steps.filter((step) => !step.ok)).toEqual([]);
    expect(
      await AuditLogModel.exists({
        action: 'whatsapp.calling_diagnosed',
        'target.id': state.channel._id.toString(),
      }),
    ).toBeTruthy();

    // WCF: Meta refuses our app's call actions on the WABA (code 10) → the send probe fails
    world.w.fake.failNext(
      'terminateCall',
      graphError(403, {
        error: {
          code: 10,
          error_subcode: 2593180,
          type: 'OAuthException',
          message:
            'You do not have the necessary permissions required to send messages on behalf of this WhatsApp Business Account.',
        },
      }),
    );
    const denied = await diagnose.diagnose(
      state.acc.account._id,
      state.channel._id.toString(),
      userActor(),
      {},
    );
    expect(denied.steps.find((step) => step.key === 'send')).toMatchObject({
      ok: false,
      metaCode: 10,
      detail: expect.stringContaining('Advanced access'),
    });
    expect(
      await MetaCallErrorModel.exists({
        channelId: state.channel._id,
        op: 'calls.terminate',
        metaCode: 10,
      }),
    ).toBeTruthy();

    await world.w.fake.revokeToken(state.token);
    const failed = await diagnose.diagnose(
      state.acc.account._id,
      state.channel._id.toString(),
      userActor(),
      {},
    );
    expect(failed.steps[0]).toMatchObject({ key: 'token', ok: false, metaCode: 190 });
    expect(
      await MetaCallErrorModel.exists({
        channelId: state.channel._id,
        op: 'settings.get',
        metaCode: 190,
      }),
    ).toBeTruthy();
  });
});
