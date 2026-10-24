import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { useInboxWorld } from '../helpers/inbox';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const waJobs = { enqueueEvent: () => Promise.resolve() };

afterAll(async () => {
  await world.w.fake.stopCalls();
});

describe('GET /api/v1/dev/meta/calls', () => {
  let users: Awaited<ReturnType<typeof world.setup>>['users'];
  beforeEach(async () => {
    ({ users } = await world.setup());
  });
  const app = (env: NodeJS.ProcessEnv = {}) =>
    buildTestApp(env, {
      whatsapp: { ctx: world.w.ctx, jobs: waJobs, inboxJobs: world.jobs, storage: world.storage },
    });

  it('lists the fake customer side of calls (whatsapp.read; no SDP, last 4 digits)', async () => {
    const target = app();
    const url = `/api/v1/dev/meta/calls?channelId=${state.channel._id.toString()}`;
    const empty = await request(target).get(url).set(bearer(users.viewer.token));
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({ calls: [] });

    const phone = state.channel.phoneNumberId ?? '';
    const { waCallId } = await world.w.fake.userCall(phone, '919000008811');
    const got = await request(target).get(url).set(bearer(users.viewer.token));
    expect(got.body.data.calls).toEqual([
      expect.objectContaining({
        waCallId,
        toLast4: '8811',
        direction: 'USER_INITIATED',
        state: 'ringing',
        heardTone: false,
        dtmfSent: '',
      }),
    ]);
    expect(JSON.stringify(got.body)).not.toMatch(/v=0|a=candidate|919000008811/);
    await world.w.fake.userHangup(waCallId);

    expect(
      (
        await request(target)
          .get('/api/v1/dev/meta/calls?channelId=x')
          .set(bearer(users.viewer.token))
      ).status,
    ).toBe(422);
    expect((await request(target).get(url)).status).toBe(401);
    const other = await createTestAccount();
    const stranger = await other.addUser('owner');
    expect((await request(target).get(url).set(bearer(stranger.token))).status).toBe(404);
  });
});
