import { readFileSync } from 'node:fs';
import path from 'node:path';

import { MemoryStore } from 'express-rate-limit';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FLOW_LIMITS } from '../../src/config/limits';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { FlowAudioModel } from '../../src/db/models/flow-audio.model';
import { FlowModel } from '../../src/db/models/flow.model';
import { purgeDeletedAudio } from '../../src/modules/flow-audio/flow-audio.service';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { auth } from '../helpers/flows';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const app = buildTestApp({}, { storage });
const BASE = '/api/v1/flow-audio';
const fixture = (name: string) => readFileSync(path.resolve(__dirname, '../fixtures/audio', name));

let t: TestAccount;
let manager: TestUser;
let viewer: TestUser;

beforeAll(async () => {
  t = await createTestAccount({ name: 'Audio Co' });
  manager = await t.addUser('manager');
  viewer = await t.addUser('viewer');
});

afterEach(() => vi.useRealTimers());

const upload = (u: { token: string }, file: string, name?: string, buffer?: Buffer) => {
  const req = request(app).post(BASE).set(auth(u));
  if (name !== undefined) void req.field('name', name);
  return req.attach('file', buffer ?? fixture(file), file);
};

describe('flow audio', () => {
  it.each([
    ['tone-8k-mono.wav', { format: 'wav', durationMs: 1000, sampleRate: 8000, channels: 1 }],
    ['ulaw-16k.wav', { format: 'wav', durationMs: 500, sampleRate: 16_000 }],
    ['cbr-128k.mp3', { format: 'mp3', durationMs: 990 }],
    ['vbr-xing.mp3', { format: 'mp3', durationMs: 2612 }],
    ['id3-cbr.mp3', { format: 'mp3', durationMs: 261 }],
  ])('uploads %s with its probed facts', async (file, facts) => {
    const res = await upload(manager, file);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      name: file.replace(/\.[^.]+$/, ''),
      bytes: fixture(file).length,
      uploadedBy: { id: manager.user._id.toString(), name: manager.user.name },
      ...facts,
    });
    expect(res.body.data).not.toHaveProperty('fileKey');
    const doc = await FlowAudioModel.findById(res.body.data.id).lean();
    expect(doc?.fileKey).toBe(
      `accounts/${t.account._id.toString()}/flow-audio/${res.body.data.id as string}.${facts.format}`,
    );
  });

  it('refuses fake, oversized and too long files', async () => {
    const fake = await upload(manager, 'not-audio.mp3');
    expect(fake.status).toBe(415);
    const wrongExt = await upload(manager, 'tone.txt', undefined, fixture('tone-8k-mono.wav'));
    expect(wrongExt.status).toBe(415);
    expect(fake.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const big = await upload(
      manager,
      'big.wav',
      undefined,
      Buffer.alloc(FLOW_LIMITS.audioMaxBytes + 1),
    );
    expect(big.status).toBe(413);
    const long = await upload(manager, 'long-header.wav');
    expect(long.status).toBe(422);
    expect(long.body.error.details).toEqual([{ path: 'file', message: 'Longer than 120 seconds' }]);
    const none = await request(app).post(BASE).set(auth(manager)).field('name', 'x');
    expect(none.status).toBe(422);
    const twoFiles = await request(app)
      .post(BASE)
      .set(auth(manager))
      .attach('file', fixture('tone-8k-mono.wav'), 'a.wav')
      .attach('file', fixture('tone-8k-mono.wav'), 'b.wav');
    expect(twoFiles.status).toBe(422);
  });

  it('names: explicit name must be free; file names get (2), (3)', async () => {
    const a = await upload(manager, 'stereo-48k.wav', 'Welcome tone');
    expect(a.body.data.name).toBe('Welcome tone');
    const dup = await upload(manager, 'stereo-48k.wav', 'welcome TONE');
    expect(dup.status).toBe(409);
    const b = await upload(manager, 'stereo-48k.wav');
    const c = await upload(manager, 'stereo-48k.wav');
    expect([b.body.data.name, c.body.data.name]).toEqual(['stereo-48k', 'stereo-48k (2)']);
    const log = await AuditLogModel.findOne({
      action: 'flow_audio.changed',
      'target.id': a.body.data.id,
    }).lean();
    expect(log?.meta).toEqual({ change: 'uploaded', name: 'Welcome tone', durationMs: 250 });
  });

  it('lists, renames and gives a signed URL that expires', async () => {
    const a = await upload(manager, 'tone-8k-mono.wav', 'Listen me');
    const list = await request(app).get(`${BASE}?q=listen`).set(auth(viewer));
    expect(list.body.data.map((x: { name: string }) => x.name)).toEqual(['Listen me']);
    const renamed = await request(app)
      .patch(`${BASE}/${a.body.data.id}`)
      .set(auth(manager))
      .send({ name: 'Heard' });
    expect(renamed.body.data.name).toBe('Heard');
    await upload(manager, 'tone-8k-mono.wav', 'Other name');
    const clash = await request(app)
      .patch(`${BASE}/${a.body.data.id}`)
      .set(auth(manager))
      .send({ name: 'other NAME' });
    expect(clash.status).toBe(409);
    const signed = await request(app).get(`${BASE}/${a.body.data.id}/url`).set(auth(viewer));
    expect(signed.status).toBe(200);
    const fileUrl = new URL(signed.body.data.url as string);
    const got = await request(app).get(`${fileUrl.pathname}${fileUrl.search}`);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('audio/wav');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + (FLOW_LIMITS.audioUrlTtlSec + 5) * 1000);
    expect((await request(app).get(`${fileUrl.pathname}${fileUrl.search}`)).status).toBe(403);
  });

  it('refuses deleting audio used by a flow; deletes (soft) otherwise and purges later', async () => {
    const used = await upload(manager, 'tone-8k-mono.wav', 'Used audio');
    await FlowModel.create({
      accountId: t.account._id,
      name: 'Uses audio',
      draft: {},
      stats: { nodes: 1, agents: [], audios: [used.body.data.id], triggers: [] },
    });
    const blocked = await request(app).delete(`${BASE}/${used.body.data.id}`).set(auth(manager));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details).toEqual([
      { path: 'flows', message: 'Uses audio', id: expect.any(String) },
    ]);
    const free = await upload(manager, 'tone-8k-mono.wav', 'Free audio');
    expect(
      (await request(app).delete(`${BASE}/${free.body.data.id}`).set(auth(manager))).status,
    ).toBe(204);
    expect(
      (await request(app).get(`${BASE}/${free.body.data.id}/url`).set(auth(manager))).status,
    ).toBe(404);
    const doc = await FlowAudioModel.findById(free.body.data.id)
      .setOptions({ withDeleted: true })
      .lean();
    expect(await storage.exists(doc!.fileKey)).toBe(true);
    await FlowAudioModel.updateOne(
      { _id: free.body.data.id },
      { $set: { deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) } },
    ).setOptions({ withDeleted: true });
    expect(await purgeDeletedAudio(storage)).toEqual({ audio: 1 });
    expect(await storage.exists(doc!.fileKey)).toBe(false);
  });

  it('limits: 200 files per account, 20 uploads per hour', async () => {
    const s = await createTestAccount();
    const so = await s.addUser('owner');
    await FlowAudioModel.insertMany(
      Array.from({ length: FLOW_LIMITS.audiosPerAccount }, (_, i) => ({
        accountId: s.account._id,
        name: `a${String(i)}`,
        fileKey: `accounts/x/flow-audio/${String(i)}.wav`,
        format: 'wav',
        bytes: 1,
        durationMs: 1,
        sampleRate: 8000,
        channels: 1,
      })),
    );
    const full = await upload(so, 'tone-8k-mono.wav');
    expect(full.status).toBe(422);
    expect(full.body.error.details[0].message).toBe('Audio limit reached (200 files)');
    const limited = buildTestApp(
      {},
      { storage, flowRateLimitStores: { audio: new MemoryStore() } },
    );
    const r = await createTestAccount();
    const ro = await r.addUser('owner');
    let last = 0;
    for (let i = 0; i <= FLOW_LIMITS.audioUploadsPerHour; i += 1) {
      last = (
        await request(limited)
          .post(BASE)
          .set(auth(ro))
          .attach('file', fixture('not-audio.mp3'), 'x.mp3')
      ).status;
    }
    expect(last).toBe(429);
  });

  it('permissions, impersonation and isolation', async () => {
    const a = await upload(manager, 'tone-8k-mono.wav', 'Perm audio');
    expect((await upload(viewer, 'tone-8k-mono.wav')).status).toBe(403);
    expect((await request(app).delete(`${BASE}/${a.body.data.id}`).set(auth(viewer))).status).toBe(
      403,
    );
    expect((await request(app).get(BASE).set(auth(viewer))).status).toBe(200);
    const imp = { token: await tokenFor(manager.user, { imp: 'a'.repeat(24) }) };
    const impUpload = await upload(imp, 'tone-8k-mono.wav');
    expect(impUpload.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    const other = await createTestAccount();
    const o = await other.addUser('owner');
    expect((await request(app).get(`${BASE}/${a.body.data.id}/url`).set(auth(o))).status).toBe(404);
    expect(
      (await request(app).patch(`${BASE}/${a.body.data.id}`).set(auth(o)).send({ name: 'x' }))
        .status,
    ).toBe(404);
    expect((await request(app).delete(`${BASE}/${a.body.data.id}`).set(auth(o))).status).toBe(404);
    expect((await request(app).get(BASE).set(auth(o))).body.data).toEqual([]);
  });

  it('without storage, uploads are an internal error', async () => {
    const bare = buildTestApp();
    const res = await request(bare)
      .post(BASE)
      .set(auth(manager))
      .attach('file', fixture('tone-8k-mono.wav'), 't.wav');
    expect(res.status).toBe(500);
  });
});
