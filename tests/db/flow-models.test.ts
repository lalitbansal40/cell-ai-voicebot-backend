import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { FLOW_LIMITS } from '../../src/config/limits';
import { FlowAudioModel } from '../../src/db/models/flow-audio.model';
import { FlowNodeStatsModel } from '../../src/db/models/flow-node-stats.model';
import { FlowRunModel, SIMULATOR_TTL_MS } from '../../src/db/models/flow-run.model';
import {
  FlowVersionImmutableError,
  FlowVersionModel,
} from '../../src/db/models/flow-version.model';
import { FlowModel, NODE_TYPES } from '../../src/db/models/flow.model';
import { LEDGER_USAGE_KINDS } from '../../src/db/models/ledger-entry.model';
import { AUDIT_ACTIONS } from '../../src/modules/audit/audit-actions';
import { SYSTEM_ROLES } from '../../src/modules/rbac/system-roles';
import { ConflictError } from '../../src/shared/errors/app-error';
import { ERROR_CODES } from '../../src/shared/errors/error-codes';
import { useTestDb } from '../helpers/db';

useTestDb();

const graph = () => ({ schemaVersion: 1, nodes: [], edges: [], variables: [], settings: {} });
const flow = (accountId: Types.ObjectId, overrides: Record<string, unknown> = {}) =>
  FlowModel.create({ accountId, name: 'Loan recovery', draft: graph(), ...overrides });

const indexes = async (model: {
  collection: {
    indexes: () => Promise<{ key: object; unique?: boolean; expireAfterSeconds?: number }[]>;
  };
}) =>
  (await model.collection.indexes()).map((i) => ({
    key: JSON.stringify(i.key),
    unique: i.unique ?? false,
    ttl: i.expireAfterSeconds,
  }));

describe('Flow model', () => {
  it('fills defaults and keeps empty objects in the draft', async () => {
    const accountId = new Types.ObjectId();
    const f = await flow(accountId, { draft: { ...graph(), settings: {}, extra: {} } });
    const plain = (await FlowModel.findById(f._id).lean())!;
    expect(plain).toMatchObject({
      status: 'draft',
      revision: 1,
      draftChecksum: null,
      publishedVersionId: null,
      publishedVersion: null,
      hasUnpublishedChanges: true,
      templateKey: null,
      description: null,
      stats: { nodes: 0, agents: [], audios: [], triggers: [] },
      deletedAt: null,
    });
    expect(plain.draft).toEqual({ ...graph(), settings: {}, extra: {} });
    expect(f.toJSON()).not.toHaveProperty('deletedAt');
  });

  it('validates status, name length, triggers and revision', async () => {
    const accountId = new Types.ObjectId();
    for (const bad of [
      { status: 'live' },
      { name: 'x'.repeat(FLOW_LIMITS.nameMaxChars + 1) },
      { description: 'x'.repeat(FLOW_LIMITS.descriptionMaxChars + 1) },
      { revision: 0 },
      { stats: { triggers: ['sms'] } },
      { draft: undefined },
    ]) {
      await expect(flow(accountId, { name: `n-${Math.random()}`, ...bad })).rejects.toThrow();
    }
  });

  it('keeps names unique per account (case-insensitive); a deleted flow frees its name', async () => {
    await FlowModel.syncIndexes();
    const accountId = new Types.ObjectId();
    const first = await flow(accountId);
    await expect(flow(accountId, { name: 'LOAN RECOVERY' })).rejects.toMatchObject({ code: 11000 });
    await flow(new Types.ObjectId()); // other account: fine
    first.deletedAt = new Date();
    await first.save();
    await expect(flow(accountId)).resolves.toBeTruthy();
    expect(await FlowModel.countDocuments({ accountId })).toBe(1); // soft-deleted one hidden
  });

  it('has the list / usage indexes', async () => {
    await FlowModel.syncIndexes();
    const keys = (await indexes(FlowModel)).map((i) => i.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        '{"accountId":1,"name":1}',
        '{"accountId":1,"deletedAt":1,"updatedAt":-1}',
        '{"accountId":1,"status":1}',
        '{"accountId":1,"stats.agents":1}',
        '{"accountId":1,"stats.audios":1}',
      ]),
    );
  });

  it('declares the 15 node types', () => {
    expect(NODE_TYPES).toHaveLength(15);
  });
});

describe('FlowVersion model', () => {
  const version = (flowId: Types.ObjectId, n = 1) =>
    FlowVersionModel.create({
      accountId: new Types.ObjectId(),
      flowId,
      version: n,
      graph: { ...graph(), settings: {} },
      checksum: 'abc',
      publishedAt: new Date(),
    });

  it('stores a version with defaults and unique numbers per flow', async () => {
    await FlowVersionModel.syncIndexes();
    const flowId = new Types.ObjectId();
    const v = await version(flowId);
    expect(v.toObject({ transform: false })).toMatchObject({
      notes: null,
      agentIds: [],
      audioIds: [],
      publishedBy: null,
      graph: { settings: {} },
    });
    await expect(version(flowId)).rejects.toMatchObject({ code: 11000 });
    await expect(version(flowId, 2)).resolves.toBeTruthy();
    await expect(version(flowId, 0)).rejects.toThrow();
    await expect(
      FlowVersionModel.create({
        accountId: new Types.ObjectId(),
        flowId,
        version: 3,
        graph: graph(),
        checksum: 'x',
        notes: 'n'.repeat(FLOW_LIMITS.versionNotesMaxChars + 1),
        publishedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('is immutable: every update path throws, deletes are allowed', async () => {
    const v = await version(new Types.ObjectId());
    const filter = { _id: v._id };
    await expect(FlowVersionModel.updateOne(filter, { notes: 'x' })).rejects.toBeInstanceOf(
      FlowVersionImmutableError,
    );
    await expect(FlowVersionModel.updateMany(filter, { notes: 'x' })).rejects.toThrow(
      'cannot be changed',
    );
    await expect(FlowVersionModel.findOneAndUpdate(filter, { notes: 'x' })).rejects.toThrow(
      'cannot be changed',
    );
    await expect(FlowVersionModel.findOneAndReplace(filter, { notes: 'x' })).rejects.toThrow(
      'cannot be changed',
    );
    await expect(FlowVersionModel.replaceOne(filter, { notes: 'x' })).rejects.toThrow(
      'cannot be changed',
    );
    v.notes = 'changed';
    await expect(v.save()).rejects.toThrow('cannot be changed');
    expect((await FlowVersionModel.findById(v._id).lean())?.notes).toBeNull();
    await FlowVersionModel.deleteOne(filter);
    expect(await FlowVersionModel.countDocuments(filter)).toBe(0);
  });
});

describe('FlowRun model', () => {
  const run = (overrides: Record<string, unknown> = {}) =>
    FlowRunModel.create({
      accountId: new Types.ObjectId(),
      flowId: new Types.ObjectId(),
      mode: 'simulator',
      versionRef: 'draft',
      graphChecksum: 'abc',
      ...overrides,
    });

  it('fills defaults, hides the test phone and graph, keeps empty state objects', async () => {
    const r = await run({ testPhone: '+919000000001', graph: graph(), state: { variables: {} } });
    expect(r.toJSON()).not.toHaveProperty('testPhone');
    expect(r.toJSON()).not.toHaveProperty('graph');
    const plain = (await FlowRunModel.findById(r._id).lean())!;
    expect(plain).not.toHaveProperty('testPhone'); // select: false
    expect(plain).toMatchObject({
      status: 'running',
      state: { variables: {} },
      transcript: [],
      trace: [],
      inputs: [],
      costMicros: 0,
      endReason: null,
      contactId: null,
      expiresAt: null,
    });
    const withPhone = await FlowRunModel.findById(r._id).select('+testPhone').lean();
    expect(withPhone?.testPhone).toBe('+919000000001');
  });

  it('accepts "draft" or a version number only, and known end reasons', async () => {
    await expect(run({ versionRef: 3 })).resolves.toBeTruthy();
    for (const bad of [
      { versionRef: 'v1' },
      { versionRef: 0 },
      { versionRef: 1.5 },
      { mode: 'live' },
      { endReason: 'bored' },
      { status: 'paused' },
    ]) {
      await expect(run(bad)).rejects.toThrow();
    }
  });

  it('expires simulator runs through a TTL index (30 days)', async () => {
    await FlowRunModel.syncIndexes();
    expect(await indexes(FlowRunModel)).toEqual(
      expect.arrayContaining([
        { key: '{"expiresAt":1}', unique: false, ttl: 0 },
        { key: '{"accountId":1,"flowId":1,"createdAt":-1}', unique: false, ttl: undefined },
        { key: '{"accountId":1,"createdBy":1,"createdAt":-1}', unique: false, ttl: undefined },
      ]),
    );
    expect(SIMULATOR_TTL_MS).toBe(30 * 24 * 60 * 60_000);
  });
});

describe('FlowNodeStats model', () => {
  it('counts per flow / version / node / day / mode (unique) with an exits map', async () => {
    await FlowNodeStatsModel.syncIndexes();
    const key = {
      accountId: new Types.ObjectId(),
      flowId: new Types.ObjectId(),
      version: 0,
      nodeId: 'n_menu',
      day: '2026-10-10',
      mode: 'simulator' as const,
    };
    await FlowNodeStatsModel.updateOne(
      key,
      { $inc: { entered: 1, 'exits.key_1': 1, totalMs: 12 } },
      { upsert: true },
    );
    await FlowNodeStatsModel.updateOne(
      key,
      { $inc: { entered: 1, 'exits.key_1': 1, errorCount: 1 } },
      { upsert: true },
    );
    const row = (await FlowNodeStatsModel.findOne(key))!;
    expect(row.entered).toBe(2);
    expect(row.errorCount).toBe(1);
    expect(row.exits.get('key_1')).toBe(2);
    await expect(FlowNodeStatsModel.create(key)).rejects.toMatchObject({ code: 11000 });
    await expect(FlowNodeStatsModel.create({ ...key, day: '10-10-2026' })).rejects.toThrow();
    await expect(
      FlowNodeStatsModel.create({ ...key, mode: 'x' as never, day: '2026-10-11' }),
    ).rejects.toThrow();
  });
});

describe('FlowAudio model', () => {
  const audio = (accountId: Types.ObjectId, overrides: Record<string, unknown> = {}) =>
    FlowAudioModel.create({
      accountId,
      name: 'Welcome tone',
      fileKey: `accounts/${accountId.toString()}/flow-audio/a.wav`,
      format: 'wav',
      bytes: 1000,
      durationMs: 2000,
      sampleRate: 8000,
      channels: 1,
      ...overrides,
    });

  it('validates format and limits, hides the file key, unique names with soft delete', async () => {
    await FlowAudioModel.syncIndexes();
    const accountId = new Types.ObjectId();
    const a = await audio(accountId);
    expect(a.toJSON()).not.toHaveProperty('fileKey');
    expect(a.toJSON()).not.toHaveProperty('deletedAt');
    await expect(audio(accountId, { name: 'WELCOME TONE' })).rejects.toMatchObject({
      code: 11000,
    });
    for (const bad of [
      { format: 'ogg' },
      { bytes: FLOW_LIMITS.audioMaxBytes + 1 },
      { durationMs: FLOW_LIMITS.audioMaxMs + 1 },
      { sampleRate: 4000 },
      { channels: 3 },
    ]) {
      await expect(audio(accountId, { name: `n-${Math.random()}`, ...bad })).rejects.toThrow();
    }
    a.deletedAt = new Date();
    await a.save();
    await expect(audio(accountId)).resolves.toBeTruthy();
  });
});

describe('Phase 6 catalogue', () => {
  it('has the two flow error codes, usable through ConflictError', () => {
    expect(ERROR_CODES.FLOW_REVISION_CONFLICT.status).toBe(409);
    expect(ERROR_CODES.RESOURCE_IN_USE.status).toBe(409);
    const err = new ConflictError('RESOURCE_IN_USE', undefined, [
      { path: 'flows', message: 'Loan recovery', id: 'f1' },
    ]);
    expect(err).toMatchObject({
      status: 409,
      code: 'RESOURCE_IN_USE',
      message: 'This item is in use.',
    });
  });

  it('has the 11 flow audit actions', () => {
    expect(AUDIT_ACTIONS.filter((a) => a.startsWith('flow'))).toHaveLength(11);
  });

  it('bills simulator AI turns and AI intents with their own ledger kinds', () => {
    expect(LEDGER_USAGE_KINDS).toEqual(expect.arrayContaining(['flow_simulator', 'flow_intent']));
  });

  it('grants flows.read to every role and write / publish to owner, admin and manager only', () => {
    const flowsOf = (key: keyof typeof SYSTEM_ROLES) =>
      SYSTEM_ROLES[key].permissions.filter((p) => p.startsWith('flows.')).sort();
    for (const key of ['owner', 'admin', 'manager'] as const) {
      expect(flowsOf(key)).toEqual(['flows.publish', 'flows.read', 'flows.write']);
    }
    for (const key of ['agent', 'viewer'] as const) expect(flowsOf(key)).toEqual(['flows.read']);
  });
});
