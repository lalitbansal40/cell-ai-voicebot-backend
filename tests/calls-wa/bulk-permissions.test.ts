import mongoose, { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CallPermissionRunModel } from '../../src/db/models/call-permission-run.model';
import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { WhatsAppCallPermissionModel } from '../../src/db/models/whatsapp-call-permission.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import {
  BULK_PERMISSION_LIMITS,
  bulkClientId,
  createBulkPermissions,
} from '../../src/modules/whatsapp-calling/bulk-permissions';
import { BulkPermissionBody } from '../../src/modules/whatsapp-calling/calling-api.schema';
import { AppError } from '../../src/shared/errors/app-error';
import { useTestDb } from '../helpers/db';

useTestDb();

const accountId = new Types.ObjectId();
const userId = new Types.ObjectId();
const channelId = new Types.ObjectId();
const now = new Date('2026-11-04T10:00:00Z');
const actor = {
  type: 'user' as const,
  id: userId,
  userId,
  accountId,
  impersonatorId: null,
  ip: null,
};

let templateId: Types.ObjectId;
let block: string | null;
const request = vi.fn();

const permissions = () =>
  ({
    loadChannel: vi.fn(() => Promise.resolve({ _id: channelId, accountId, wabaId: 'waba-1' })),
    channelBlock: vi.fn(() => block),
    valid: (r: { status: string } | null) =>
      Boolean(r && (r.status === 'permanent' || r.status === 'temporary')),
    request,
  }) as never;

const jobs = {
  enqueueSettingsSync: vi.fn(),
  enqueuePermissionBulk: vi.fn(() => Promise.resolve()),
};
const service = () =>
  createBulkPermissions({ permissions: permissions(), jobs: jobs, now: () => now });

let n = 0;
const contact = (over: Record<string, unknown> = {}) =>
  ContactModel.create({
    accountId,
    phoneE164: `+9190000${String(++n).padStart(5, '0')}`,
    source: { type: 'manual' },
    ...over,
  });

const template = async (over: Record<string, unknown> = {}) => {
  const _id = new Types.ObjectId();
  await WhatsAppTemplateModel.collection.insertOne({
    _id,
    accountId,
    wabaId: 'waba-1',
    name: `perm_${_id.toString()}`,
    purpose: 'call_permission',
    status: 'APPROVED',
    ...over,
  });
  return _id;
};

beforeEach(async () => {
  block = null;
  request.mockReset();
  request.mockResolvedValue({ kind: 'template' });
  jobs.enqueuePermissionBulk.mockClear();
  templateId = await template();
});

describe('bulk call permission (T18B.4)', () => {
  it('body: exactly one target, ≤ 5,000 ids', () => {
    const id = new Types.ObjectId().toString();
    const base = { channelId: id, templateId: id };
    expect(BulkPermissionBody.safeParse({ ...base, target: { listId: id } }).success).toBe(true);
    expect(BulkPermissionBody.safeParse({ ...base, target: {} }).success).toBe(false);
    expect(
      BulkPermissionBody.safeParse({ ...base, target: { listId: id, segmentId: id } }).success,
    ).toBe(false);
    expect(
      BulkPermissionBody.safeParse({
        ...base,
        target: { contactIds: Array.from({ length: 5_001 }, () => id) },
      }).success,
    ).toBe(false);
  });

  it('replays a campaign-owned permission run with the same ID and rejects a foreign run collision', async () => {
    const c = await contact();
    const runId = new Types.ObjectId().toString();
    const s = service();
    const input = {
      runId,
      channelId: channelId.toString(),
      target: { contactIds: [c._id.toString()] },
      templateId: templateId.toString(),
    };
    await s.start(actor, input);
    await s.start(actor, input);
    expect(await CallPermissionRunModel.countDocuments({ _id: runId })).toBe(1);
    expect(jobs.enqueuePermissionBulk).toHaveBeenCalledTimes(2);
    await CallPermissionRunModel.updateOne(
      { _id: runId },
      { $set: { accountId: new Types.ObjectId() } },
    );
    await expect(s.start(actor, input)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('start validates the template and number, stores the run, audits, queues one job', async () => {
    const c = await contact();
    const s = service();
    const target = { contactIds: [c._id.toString()] };
    const pending = await template({ status: 'PENDING' });
    const marketing = await template({ purpose: null });
    for (const id of [pending, marketing, new Types.ObjectId()]) {
      await expect(
        s.start(actor, { channelId: channelId.toString(), target, templateId: id.toString() }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    block = 'calling_unavailable';
    await expect(
      s.start(actor, {
        channelId: channelId.toString(),
        target,
        templateId: templateId.toString(),
      }),
    ).rejects.toMatchObject({ code: 'WHATSAPP_CALLING_UNAVAILABLE' });
    block = null;
    const { runId } = await s.start(actor, {
      channelId: channelId.toString(),
      target,
      templateId: templateId.toString(),
    });
    expect(jobs.enqueuePermissionBulk).toHaveBeenCalledWith(runId);
    expect(await s.get(accountId, runId)).toMatchObject({ status: 'queued', total: 1, sent: 0 });
    const audit = await AuditLogModel.findOne({
      action: 'whatsapp.call_permission_bulk_requested',
      'meta.runId': runId,
    }).lean();
    expect(audit?.meta).toMatchObject({ runId, total: 1, channelId: channelId.toString() });
    await expect(s.get(new Types.ObjectId(), runId)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('applies every skip reason, records Meta answers, sends the rest with the template', async () => {
    const ok = await contact();
    const dnd = await contact({ dnd: true });
    const opted = await contact({ optedOutAt: now });
    const blocked = await contact({ whatsapp: { blocked: true } });
    const allowed = await contact();
    const declined = await contact();
    const oldDecline = await contact();
    const limited = await contact();
    const exists = await contact();
    const broken = await contact();
    const row = (c: { _id: Types.ObjectId }, status: 'permanent' | 'declined', at = now) =>
      WhatsAppCallPermissionModel.create({
        accountId,
        channelId,
        contactId: c._id,
        status,
        history: [{ status, at, source: 'meta' }],
      });
    await row(allowed, 'permanent');
    await row(declined, 'declined', new Date(now.getTime() - 2 * 86_400_000));
    await row(oldDecline, 'declined', new Date(now.getTime() - 9 * 86_400_000));
    request.mockImplementation((_a: unknown, input: { contactId: string }) => {
      if (input.contactId === limited._id.toString()) {
        return Promise.reject(new AppError('WHATSAPP_CALL_PERMISSION_LIMIT'));
      }
      if (input.contactId === exists._id.toString()) {
        return Promise.reject(new AppError('WHATSAPP_CALL_PERMISSION_EXISTS'));
      }
      if (input.contactId === broken._id.toString()) return Promise.reject(new Error('boom'));
      return Promise.resolve({ kind: 'template' });
    });
    const s = service();
    const all = [ok, dnd, opted, blocked, allowed, declined, oldDecline, limited, exists, broken];
    const { runId } = await s.start(actor, {
      channelId: channelId.toString(),
      target: { contactIds: all.map((c) => c._id.toString()) },
      templateId: templateId.toString(),
      variables: { '1': 'Cell' },
    });
    expect(await s.process(runId)).toEqual({ status: 'done' });
    expect(await s.get(accountId, runId)).toMatchObject({
      status: 'done',
      total: 10,
      sent: 2,
      failed: 1,
      skipped: {
        dnd: 1,
        opted_out: 1,
        no_whatsapp: 1,
        already_allowed: 2,
        declined_recently: 1,
        meta_limit: 1,
      },
    });
    expect(request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        contactId: ok._id.toString(),
        forceTemplate: true,
        templateId: templateId.toString(),
        variables: { '1': 'Cell' },
        clientId: bulkClientId(runId, ok._id.toString()),
      }),
    );
    expect(bulkClientId(runId, ok._id.toString())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const bell = await NotificationModel.findOne({
      type: 'whatsapp.call_permission_bulk_done',
    }).lean();
    expect(bell?.body).toBe('2 sent, 7 skipped, 1 failed.');
    // a second run of the same job does nothing more
    request.mockClear();
    expect(await s.process(runId)).toEqual({ status: 'done' });
    expect(request).not.toHaveBeenCalled();
  });

  it('an empty wallet stops the run; the rest count as wallet_empty', async () => {
    const cs = await Promise.all([1, 2, 3, 4].map(() => contact()));
    request
      .mockResolvedValueOnce({ kind: 'template' })
      .mockRejectedValueOnce(new AppError('WALLET_INSUFFICIENT_BALANCE'));
    const s = service();
    const { runId } = await s.start(actor, {
      channelId: channelId.toString(),
      target: { contactIds: cs.map((c) => c._id.toString()) },
      templateId: templateId.toString(),
    });
    expect(await s.process(runId)).toEqual({ status: 'stopped' });
    expect(await s.get(accountId, runId)).toMatchObject({
      status: 'stopped',
      sent: 1,
      skipped: { wallet_empty: 3 },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('resumes at the cursor and never re-asks a contact this run already asked', async () => {
    const cs = await Promise.all([1, 2, 3].map(() => contact()));
    const s = service();
    const { runId } = await s.start(actor, {
      channelId: channelId.toString(),
      target: { contactIds: cs.map((c) => c._id.toString()) },
      templateId: templateId.toString(),
    });
    const run = await CallPermissionRunModel.findById(runId).lean();
    const ids = run?.contactIds ?? [];
    // crashed mid-batch: the first contact was asked by this run, nothing saved yet
    await CallPermissionRunModel.updateOne({ _id: runId }, { status: 'running', startedAt: now });
    await WhatsAppCallPermissionModel.create({
      accountId,
      channelId,
      contactId: ids[0],
      status: 'requested',
      lastRequest: { messageId: new Types.ObjectId(), kind: 'template', at: now, by: userId },
    });
    await s.process(runId);
    expect(request).toHaveBeenCalledTimes(2);
    expect(await s.get(accountId, runId)).toMatchObject({ status: 'done', sent: 3 });
  });

  it('list and segment targets resolve to live contacts, capped at 5,000', async () => {
    const list = await ContactListModel.create({
      accountId,
      name: 'L',
      source: { type: 'manual' },
    });
    await contact({ listIds: [list._id] });
    await contact({ listIds: [list._id], deletedAt: now });
    await contact();
    const s = service();
    expect((await s.resolveTarget(accountId, { listId: list._id.toString() })).ids).toHaveLength(1);
    await expect(
      s.resolveTarget(accountId, { listId: new Types.ObjectId().toString() }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      s.resolveTarget(accountId, { segmentId: new Types.ObjectId().toString() }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(BULK_PERMISSION_LIMITS.maxContacts).toBe(5_000);
    await contact({ listIds: [list._id] });
    const limits = BULK_PERMISSION_LIMITS as { maxContacts: number };
    limits.maxContacts = 1;
    try {
      expect((await s.resolveTarget(accountId, { listId: list._id.toString() })).ids).toHaveLength(
        1,
      );
    } finally {
      limits.maxContacts = 5_000;
    }
    expect((await s.resolveTarget(accountId, { listId: list._id.toString() })).ids).toHaveLength(2);
  });
});

describe('0020-call-permission-runs', () => {
  const db = () => {
    const handle = mongoose.connection.db;
    if (!handle) throw new Error('no db');
    return handle;
  };
  const migration = () => {
    const found = MIGRATIONS.find((m) => m.name === '0020-call-permission-runs');
    if (!found) throw new Error('0020 missing');
    return found;
  };

  it('is right after 0019', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0020-call-permission-runs')).toBe(names.indexOf('0019-sip-lines') + 1);
  });

  it('backfills waCallPermission from permission rows, else none (idempotent, additive)', async () => {
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    const c = new Types.ObjectId();
    await db()
      .collection('contacts')
      .insertMany([
        { _id: a, accountId, phoneE164: '+919000099001' },
        { _id: b, accountId, phoneE164: '+919000099002' },
        { _id: c, accountId, phoneE164: '+919000099003' },
      ]);
    await db()
      .collection('whatsappCallPermissions')
      .insertMany([
        { accountId, contactId: a, channelId, status: 'permanent', expiresAt: null },
        { accountId, contactId: b, channelId, status: 'requested', expiresAt: null },
        { accountId, contactId: b, channelId: new Types.ObjectId(), status: 'declined' },
      ]);
    await migration().up(db());
    await migration().up(db());
    const got = await db()
      .collection('contacts')
      .find({ _id: { $in: [a, b, c] } })
      .toArray();
    expect(Object.fromEntries(got.map((d) => [String(d._id), d.waCallPermission]))).toEqual({
      [String(a)]: 'allowed',
      [String(b)]: 'asked',
      [String(c)]: 'none',
    });
    expect(got.find((d) => String(d._id) === String(c))).toMatchObject({
      phoneE164: '+919000099003',
    });
    const indexes = await db().collection('callPermissionRuns').indexes();
    expect(indexes.some((i) => i.key.accountId === 1 && i.key.createdAt === -1)).toBe(true);
  });
});
