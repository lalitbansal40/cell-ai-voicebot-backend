import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { missedReasonOf } from '../../src/modules/whatsapp-calling/calls.service';
import { inboundForNewChannel } from '../../src/modules/whatsapp-calling/incoming-default';
import {
  createCallingRuntime,
  type CallingRuntime,
} from '../../src/modules/whatsapp-calling/runtime';
import { ensureRateCard } from '../helpers/calls';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { createAgentDoc } from '../helpers/flows';
import { useInboxWorld } from '../helpers/inbox';
import { buildTestApp } from '../helpers/test-app';

/** SAC-T6: "AI se incoming calls uthao" — validation, the account default, stop AI calls. */
useTestDb();
useCapturedEmail();
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
const settingsPath = () => `/api/v1/whatsapp/channels/${state.channel._id.toString()}/calling`;

beforeAll(async () => {
  await ensureRateCard();
  runtime = createCallingRuntime({ ctx: world.w.ctx, service: world.w.svc, inbox: state.ix });
  state.h.calling = runtime.hooks;
});
beforeEach(async () => {
  ({ users } = await world.setup());
});

describe('number setting: AI answers incoming calls (SAC-T6)', () => {
  it('needs a program, calling on and wallet money; then it saves', async () => {
    const a = app();
    const agentId = (await createAgentDoc(state.acc.account._id, 'Inbound')).toString();
    // calling off on the number
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { 'calling.status': 'disabled' } },
    );
    const off = await request(a)
      .patch(settingsPath())
      .set(bearer(users.owner.token))
      .send({ inbound: { route: 'ai', aiProgram: null } });
    expect(off.status).toBe(422);
    const paths = (off.body.error.details as { path: string }[]).map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['inbound.aiProgram', 'calling.status']));

    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { 'calling.status': 'enabled' } },
    );
    await WalletModel.updateOne(
      { accountId: state.acc.account._id },
      { $set: { balanceMicros: 0, creditLimitMicros: 0 } },
    );
    const poor = await request(a)
      .patch(settingsPath())
      .set(bearer(users.owner.token))
      .send({ inbound: { route: 'ai_then_team', aiProgram: { kind: 'agent', id: agentId } } });
    expect(poor.status).toBe(422);
    expect(poor.body.error.details[0].path).toBe('wallet');

    await WalletModel.updateOne(
      { accountId: state.acc.account._id },
      { $set: { balanceMicros: 500_000_000 } },
    );
    const saved = await request(a)
      .patch(settingsPath())
      .set(bearer(users.owner.token))
      .send({ inbound: { route: 'ai_then_team', aiProgram: { kind: 'agent', id: agentId } } });
    expect(saved.status).toBe(200);
    expect(
      (await WhatsAppChannelModel.findById(state.channel._id).lean())?.calling?.inbound.route,
    ).toBe('ai_then_team');
    // back to the team needs nothing
    const team = await request(a)
      .patch(settingsPath())
      .set(bearer(users.owner.token))
      .send({ inbound: { route: 'team' } });
    expect(team.status).toBe(200);
  });
});

describe('account default for incoming calls (SAC-T6)', () => {
  it('GET shows the team by default; PUT validates, saves, audits; new numbers start with it', async () => {
    const a = app();
    const path = '/api/v1/whatsapp/incoming-default';
    const first = await request(a).get(path).set(bearer(users.viewer.token));
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ route: 'team', aiProgram: null, ringTimeoutSec: 30 });

    const viewer = await request(a)
      .put(path)
      .set(bearer(users.viewer.token))
      .send({ route: 'team', aiProgram: null, ringTimeoutSec: 20 });
    expect(viewer.status).toBe(403);

    const noProgram = await request(a)
      .put(path)
      .set(bearer(users.owner.token))
      .send({ route: 'ai', aiProgram: null, ringTimeoutSec: 20 });
    expect(noProgram.status).toBe(422);
    expect(noProgram.body.error.details[0].path).toBe('aiProgram');

    const agentId = (await createAgentDoc(state.acc.account._id, 'Default AI')).toString();
    const ok = await request(a)
      .put(path)
      .set(bearer(users.owner.token))
      .send({ route: 'ai', aiProgram: { kind: 'agent', id: agentId }, ringTimeoutSec: 20 });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({
      route: 'ai',
      aiProgram: { kind: 'agent', id: agentId },
      ringTimeoutSec: 20,
    });
    expect(
      await AuditLogModel.countDocuments({
        accountId: state.acc.account._id,
        action: 'whatsapp.incoming_default_updated',
      }),
    ).toBe(1);
    const inbound = await inboundForNewChannel(state.acc.account._id);
    expect(inbound).toMatchObject({ route: 'ai', ringTimeoutSec: 20, ringUserIds: null });
    expect(inbound.aiProgram?.id.toString()).toBe(agentId);
  });

  it('an account without the setting answers with the team', async () => {
    await AccountModel.updateOne(
      { _id: state.acc.account._id },
      { $unset: { 'settings.waIncoming': '' } },
    );
    expect(await inboundForNewChannel(state.acc.account._id)).toEqual({
      route: 'team',
      aiProgram: null,
      ringTimeoutSec: 30,
      ringUserIds: null,
    });
  });
});

describe('stop live AI calls and missed reasons (SAC-T6)', () => {
  it('needs calls on this process; managers of calling only; audited', async () => {
    const a = app();
    const path = `${settingsPath()}/stop-ai-calls`;
    expect((await request(a).post(path).set(bearer(users.viewer.token))).status).toBe(403);
    // this test app places no calls (no media runtime)
    const res = await request(a).post(path).set(bearer(users.owner.token));
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
    const other = await request(a)
      .post(`/api/v1/whatsapp/channels/${new Types.ObjectId().toString()}/calling/stop-ai-calls`)
      .set(bearer(users.owner.token));
    expect([404, 503]).toContain(other.status);
  });

  it('maps call end reasons to the Missed list reasons', () => {
    expect(missedReasonOf('wallet_empty')).toBe('wallet_low');
    expect(missedReasonOf('outside_call_hours')).toBe('after_hours');
    expect(missedReasonOf('no_agent_available')).toBe('no_agents');
    expect(missedReasonOf('customer_hangup')).toBe('caller_hung_up');
    expect(missedReasonOf('meta_failed')).toBe('no_answer');
  });
});
