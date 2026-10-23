import { Writable } from 'node:stream';

import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MetaApiError } from '../../src/core/meta';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import {
  WhatsAppTemplateModel,
  type WhatsAppTemplateDoc,
} from '../../src/db/models/whatsapp-template.model';
import { uploadHeaderExample } from '../../src/modules/templates/example-media.service';
import {
  processTemplateSync,
  queueDailyTemplateSyncs,
  syncLockKey,
} from '../../src/modules/templates/sync.job';
import {
  CALL_PERMISSION_BODY,
  createCallPermissionTemplate,
  createTemplate,
  deleteTemplate,
  editTemplate,
  getTemplate,
  listTemplates,
  recordTemplateUsage,
  setVariableSources,
  submitTemplate,
  syncTemplates,
  type CreateTemplateInput,
} from '../../src/modules/templates/template.service';
import { createLogger, setLogger } from '../../src/shared/logger';
import { useTestDb } from '../helpers/db';
import { mediaFixture } from '../helpers/inbox';
import { useTemplateWorld } from '../helpers/templates';
import { userActor } from '../helpers/whatsapp';

useTestDb();
const t = useTemplateWorld();

const logLines: string[] = [];
beforeEach(() => {
  logLines.length = 0;
  setLogger(
    createLogger(
      { NODE_ENV: 'test', LOG_LEVEL: 'trace' },
      new Writable({
        write(chunk: Buffer, _enc, done) {
          logLines.push(chunk.toString());
          done();
        },
      }),
    ),
  );
});
afterEach(() => {
  setLogger(createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
});

const SECRET_BODY = 'Hello {{1}}, your secret order XQZ-TPL-BODY is ready today.';
const input = (over: Partial<CreateTemplateInput> = {}): CreateTemplateInput => ({
  channelId: t.state.channel._id.toString(),
  name: 'order_ready',
  language: 'en',
  category: 'UTILITY',
  components: [{ type: 'BODY', text: SECRET_BODY, example: { body_text: [['Asha']] } }],
  ...over,
});

const row = async (id: string) => {
  const r = await WhatsAppTemplateModel.findById(id).lean<WhatsAppTemplateDoc>();
  if (!r) throw new Error('no row');
  return r;
};

describe('create / submit', () => {
  it('creates a draft, submits it to Meta and records the history + audit (no body)', async () => {
    const { accountId, users } = await t.setup();
    const actor = userActor(users.manager.user._id);
    const draft = await createTemplate(t.state.tx, accountId, actor, { ...input(), submit: false });
    expect(draft).toMatchObject({ status: 'DRAFT', submitted: false, variablesCount: 1 });
    expect(draft.variables).toEqual([
      {
        key: '1',
        component: 'body',
        index: 0,
        example: 'Asha',
        defaultSource: { kind: 'ask', value: null },
      },
    ]);
    const submitted = await submitTemplate(t.state.tx, accountId, actor, draft.id);
    expect(submitted).toMatchObject({ status: 'PENDING', submitted: true });
    const stored = await row(draft.id);
    expect(stored.metaTemplateId).toMatch(/^fake_tpl_/);
    expect(stored.statusHistory.map((h) => h.status)).toEqual(['DRAFT', 'PENDING']);
    expect((await t.w.fake.templates(t.state.channel.wabaId)).map((x) => x.name)).toEqual([
      'order_ready',
    ]);
    const audits = await AuditLogModel.find({ accountId, action: /^template\./ }).lean();
    expect(audits.map((a) => a.action).sort()).toEqual(['template.created', 'template.submitted']);
    expect(JSON.stringify(audits)).not.toContain('XQZ-TPL-BODY');
    expect(logLines.join('')).not.toContain('XQZ-TPL-BODY');
    // drafts only
    await expect(submitTemplate(t.state.tx, accountId, actor, draft.id)).rejects.toMatchObject({
      code: 'TEMPLATE_EDIT_NOT_ALLOWED',
    });
  });

  it('submits at once by default; `instant` names come back approved', async () => {
    const { accountId } = await t.setup();
    const r = await createTemplate(
      t.state.tx,
      accountId,
      userActor(),
      input({ name: 'promo_instant', category: 'MARKETING' }),
    );
    expect(r.status).toBe('APPROVED');
  });

  it('refuses invalid input, another account’s number and authentication', async () => {
    const { accountId } = await t.setup();
    await expect(
      createTemplate(t.state.tx, accountId, userActor(), input({ name: 'Bad-Name' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      createTemplate(t.state.tx, new Types.ObjectId(), userActor(), input()),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(
      createTemplate(t.state.tx, accountId, userActor(), input({ category: 'AUTHENTICATION' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('name + language must be free; another language is fine', async () => {
    const { accountId } = await t.setup();
    await createTemplate(t.state.tx, accountId, userActor(), input({ submit: false }));
    await expect(
      createTemplate(t.state.tx, accountId, userActor(), input({ submit: false })),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NAME_TAKEN' });
    await createTemplate(
      t.state.tx,
      accountId,
      userActor(),
      input({ language: 'hi', submit: false }),
    );
  });

  it('Meta errors: name exists → 409, token gone → number needs reconnect', async () => {
    const { accountId } = await t.setup();
    t.w.fake.failNext(
      'createTemplate',
      new MetaApiError({
        status: 400,
        code: 100,
        subcode: 2388023,
        type: 'OAuthException',
        message: 'Message template already exists',
        fbtraceId: null,
        retryable: false,
        tokenInvalid: false,
      }),
    );
    await expect(createTemplate(t.state.tx, accountId, userActor(), input())).rejects.toMatchObject(
      {
        code: 'TEMPLATE_NAME_TAKEN',
      },
    );
    t.w.fake.failNext(
      'createTemplate',
      new MetaApiError({
        status: 401,
        code: 190,
        subcode: null,
        type: 'OAuthException',
        message: 'token',
        fbtraceId: null,
        retryable: false,
        tokenInvalid: true,
      }),
    );
    await expect(
      createTemplate(t.state.tx, accountId, userActor(), input({ name: 'second_one' })),
    ).rejects.toMatchObject({ code: 'WHATSAPP_CHANNEL_NOT_READY' });
    expect((await WhatsAppChannelModel.findById(t.state.channel._id).lean())?.status).toBe(
      'needs_reconnect',
    );
  });

  it('limits: templates per WABA and 100 creations / hour', async () => {
    const { accountId } = await t.setup();
    const hour = Math.floor(Date.now() / 3_600_000);
    await t.w.redis.set(`tpl-create-${t.state.channel.wabaId}-${String(hour)}`, '100');
    await expect(createTemplate(t.state.tx, accountId, userActor(), input())).rejects.toMatchObject(
      {
        code: 'TEMPLATE_LIMIT_REACHED',
      },
    );
    await t.w.redis.del(`tpl-create-${t.state.channel.wabaId}-${String(hour)}`);
    await WhatsAppTemplateModel.insertMany(
      Array.from({ length: 250 }, (_, i) => ({
        accountId,
        wabaId: t.state.channel.wabaId,
        name: `bulk_${String(i)}`,
        language: 'en',
        category: 'UTILITY',
        status: 'APPROVED',
      })),
    );
    await expect(
      createTemplate(t.state.tx, accountId, userActor(), input({ name: 'one_more' })),
    ).rejects.toMatchObject({ code: 'TEMPLATE_LIMIT_REACHED' });
  });
});

describe('edit', () => {
  it('drafts change freely (name too); submitted ones keep name / language / format', async () => {
    const { accountId } = await t.setup();
    const d = await createTemplate(t.state.tx, accountId, userActor(), input({ submit: false }));
    const e = await editTemplate(t.state.tx, accountId, userActor(), d.id, {
      name: 'order_ready_v2',
      components: [{ type: 'BODY', text: 'Hey {{1}}, ready.', example: { body_text: [['A']] } }],
    });
    expect(e).toMatchObject({ name: 'order_ready_v2', status: 'DRAFT' });
    const s = await submitTemplate(t.state.tx, accountId, userActor(), d.id);
    await expect(
      editTemplate(t.state.tx, accountId, userActor(), s.id, { name: 'other' }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_EDIT_NOT_ALLOWED' });
    // PENDING can't be edited at Meta
    await expect(
      editTemplate(t.state.tx, accountId, userActor(), s.id, { ttlSeconds: 600 }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_EDIT_NOT_ALLOWED', details: [{ path: 'status' }] });
  });

  it('approved: 1 edit / 24 h, 10 / 30 days, category locked; back to PENDING', async () => {
    const { accountId } = await t.setup();
    const base = new Date('2026-11-01T10:00:00Z');
    t.clock.now = base;
    const a = await createTemplate(
      t.state.tx,
      accountId,
      userActor(),
      input({ name: 'edit_instant' }),
    );
    expect(a.status).toBe('APPROVED');
    const components = [
      { type: 'BODY', text: 'Hello {{1}}, new text.', example: { body_text: [['A']] } },
    ];
    await expect(
      editTemplate(t.state.tx, accountId, userActor(), a.id, { category: 'MARKETING' }),
    ).rejects.toMatchObject({ details: [{ path: 'category_locked' }] });
    const edited = await editTemplate(t.state.tx, accountId, userActor(), a.id, { components });
    expect(edited.status).toBe('PENDING');
    expect((await row(a.id)).editsLog).toHaveLength(1);
    // Meta approves again → second edit within 24 h refused
    await WhatsAppTemplateModel.updateOne({ _id: a.id }, { $set: { status: 'APPROVED' } });
    await t.w.fake.patchTemplate(t.state.channel.wabaId, (await row(a.id)).metaTemplateId ?? '', {
      status: 'APPROVED',
    });
    t.clock.now = new Date(base.getTime() + 23 * 3_600_000);
    await expect(
      editTemplate(t.state.tx, accountId, userActor(), a.id, { components }),
    ).rejects.toMatchObject({ details: [{ path: 'edit_limit' }] });
    expect((await getTemplate(accountId, a.id, t.clock.now)).nextEditAt).toBe(
      new Date(base.getTime() + 24 * 3_600_000).toISOString(),
    );
    // 10 in the last 30 days → refused even after 24 h
    await WhatsAppTemplateModel.updateOne(
      { _id: a.id },
      {
        $set: {
          editsLog: Array.from({ length: 10 }, (_, i) => ({
            at: new Date(base.getTime() - (i + 2) * 86_400_000),
          })),
        },
      },
    );
    t.clock.now = new Date(base.getTime());
    await expect(
      editTemplate(t.state.tx, accountId, userActor(), a.id, { components }),
    ).rejects.toMatchObject({ details: [{ path: 'edit_limit' }] });
  });

  it('not editable rows (synced carousel / authentication) are refused', async () => {
    const { accountId } = await t.setup();
    const r = await WhatsAppTemplateModel.create({
      accountId,
      wabaId: t.state.channel.wabaId,
      metaTemplateId: 'm-1',
      name: 'otp_code',
      language: 'en',
      category: 'AUTHENTICATION',
      status: 'APPROVED',
      editable: false,
    });
    await expect(
      editTemplate(t.state.tx, accountId, userActor(), r._id.toString(), { ttlSeconds: 60 }),
    ).rejects.toMatchObject({ details: [{ path: 'not_editable' }] });
  });
});

describe('delete', () => {
  it('one language or every language; rows stay DELETED; the name is locked 30 days', async () => {
    const { accountId } = await t.setup();
    const base = new Date('2026-11-02T10:00:00Z');
    t.clock.now = base;
    const en = await createTemplate(
      t.state.tx,
      accountId,
      userActor(),
      input({ name: 'gone_slow' }),
    );
    const hi = await createTemplate(
      t.state.tx,
      accountId,
      userActor(),
      input({ name: 'gone_slow', language: 'hi' }),
    );
    const other = await createTemplate(
      t.state.tx,
      accountId,
      userActor(),
      input({ name: 'keep_slow' }),
    );
    expect(await deleteTemplate(t.state.tx, accountId, userActor(), en.id, 'one')).toEqual({
      deleted: 1,
    });
    expect((await row(en.id)).status).toBe('DELETED');
    expect((await row(hi.id)).status).toBe('PENDING');
    expect(
      (await t.w.fake.templates(t.state.channel.wabaId)).map((x) => `${x.name}:${x.language}`),
    ).toEqual(['gone_slow:hi', 'keep_slow:en']);
    await expect(
      createTemplate(t.state.tx, accountId, userActor(), input({ name: 'gone_slow' })),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NAME_TAKEN' });
    expect(await deleteTemplate(t.state.tx, accountId, userActor(), hi.id, 'all')).toEqual({
      deleted: 1,
    });
    expect((await row(other.id)).status).toBe('PENDING');
    // 31 days later the name is free
    t.clock.now = new Date(base.getTime() + 31 * 86_400_000);
    await createTemplate(
      t.state.tx,
      accountId,
      userActor(),
      input({ name: 'gone_slow', submit: false }),
    );
    await expect(deleteTemplate(t.state.tx, accountId, userActor(), en.id)).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
    });
  });

  it('drafts are deleted locally; disabled ones can’t be deleted; other accounts → 404', async () => {
    const { accountId } = await t.setup();
    const d = await createTemplate(t.state.tx, accountId, userActor(), input({ submit: false }));
    const calls = t.w.fake.calls.length;
    await deleteTemplate(t.state.tx, accountId, userActor(), d.id);
    expect(t.w.fake.calls.slice(calls).some((c) => c.op === 'deleteTemplate')).toBe(false);
    const x = await WhatsAppTemplateModel.create({
      accountId,
      wabaId: t.state.channel.wabaId,
      metaTemplateId: 'm-dis',
      name: 'disabled_one',
      language: 'en',
      category: 'MARKETING',
      status: 'DISABLED',
    });
    await expect(
      deleteTemplate(t.state.tx, accountId, userActor(), x._id.toString()),
    ).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
    });
    await expect(
      deleteTemplate(t.state.tx, new Types.ObjectId(), userActor(), x._id.toString()),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });
});

describe('sync', () => {
  it('pages, upserts by Meta id, adopts same name + language, marks missing ones DELETED, keeps drafts', async () => {
    const { accountId } = await t.setup();
    const waba = t.state.channel.wabaId;
    for (let i = 0; i < 3; i += 1) {
      await t.w.fake.createTemplate(t.state.token, waba, {
        name: `meta_${String(i)}_instant`,
        language: 'en',
        category: 'UTILITY',
        parameterFormat: 'positional',
        components: [{ type: 'BODY', text: 'Hi {{1}} there', example: { body_text: [['A']] } }],
      });
    }
    const draft = await createTemplate(
      t.state.tx,
      accountId,
      userActor(),
      input({ submit: false }),
    );
    const orphan = await WhatsAppTemplateModel.create({
      accountId,
      wabaId: waba,
      metaTemplateId: 'gone-at-meta',
      name: 'old_one',
      language: 'en',
      category: 'UTILITY',
      status: 'APPROVED',
    });
    const first = await syncTemplates(t.state.tx, t.state.channel._id, 'manual');
    expect(first).toEqual({ created: 3, updated: 0, deleted: 1, unchanged: 0 });
    expect((await row(orphan._id.toString())).status).toBe('DELETED');
    expect((await row(draft.id)).status).toBe('DRAFT');
    const synced = await WhatsAppTemplateModel.findOne({
      accountId,
      name: 'meta_0_instant',
    }).lean();
    expect(synced).toMatchObject({ status: 'APPROVED', editable: true, createdBy: null });
    expect(synced?.variables.map((v) => v.key)).toEqual(['1']);
    // a carousel (unsupported) comes back read-only; a status change is applied
    const [m0] = await t.w.fake.templates(waba);
    await t.w.fake.patchTemplate(waba, m0?.id ?? '', {
      status: 'PAUSED',
      components: [{ type: 'CAROUSEL', cards: [] }],
    });
    const second = await syncTemplates(t.state.tx, t.state.channel._id, 'daily');
    expect(second).toMatchObject({ created: 0, updated: 1, deleted: 0, unchanged: 2 });
    const paused = await WhatsAppTemplateModel.findOne({
      accountId,
      name: 'meta_0_instant',
    }).lean();
    expect(paused).toMatchObject({ status: 'PAUSED', editable: false });
    expect(paused?.statusHistory.at(-1)).toMatchObject({ status: 'PAUSED', source: 'sync' });
    expect(await AuditLogModel.countDocuments({ accountId, action: 'template.synced' })).toBe(2);
  });

  it('a newer webhook wins over an older sync (lastEventAt)', async () => {
    const { accountId } = await t.setup();
    const r = await createTemplate(
      t.state.tx,
      accountId,
      userActor(),
      input({ name: 'race_instant' }),
    );
    const future = new Date(Date.now() + 60_000);
    await WhatsAppTemplateModel.updateOne(
      { _id: r.id },
      { $set: { status: 'PAUSED', lastEventAt: future } },
    );
    const res = await syncTemplates(t.state.tx, t.state.channel._id, 'manual');
    expect(res.unchanged).toBe(1);
    expect((await row(r.id)).status).toBe('PAUSED');
  });

  it('template.sync job: one per WABA per minute; disconnected numbers skipped; daily = one per WABA', async () => {
    const { accountId } = await t.setup();
    await t.w.redis.del(syncLockKey(t.state.channel.wabaId));
    const channelId = t.state.channel._id.toString();
    expect(await processTemplateSync(t.state.tx, { channelId, reason: 'connect' })).toMatchObject({
      created: 0,
    });
    expect(await processTemplateSync(t.state.tx, { channelId, reason: 'webhook' })).toEqual({
      skipped: 'rate',
    });
    expect(await processTemplateSync(t.state.tx, { channelId: 'nope', reason: 'daily' })).toEqual({
      skipped: 'channel',
    });
    // a second number on the same WABA → still one daily sync
    await WhatsAppChannelModel.create({
      accountId,
      label: 'Second',
      provider: 'fake',
      mode: 'cloud_api',
      wabaId: t.state.channel.wabaId,
      phoneNumberId: `fake_phone_second_${String(Date.now())}`,
      metaPayer: 'platform',
      status: 'connected',
    });
    t.jobs.syncs.length = 0;
    await queueDailyTemplateSyncs(t.state.tx);
    expect(t.jobs.syncs.filter((s) => s.channelId === channelId)).toEqual([
      { channelId, reason: 'daily' },
    ]);
    expect(t.jobs.syncs.filter((s) => s.reason === 'daily').length).toBe(
      new Set(t.jobs.syncs.map((s) => s.channelId)).size,
    );
  });
});

describe('variables, call permission, usage, reads', () => {
  it('remembers default sources; unknown keys / fields refused; audit has keys only', async () => {
    const { accountId } = await t.setup();
    const r = await createTemplate(t.state.tx, accountId, userActor(), input({ submit: false }));
    await CustomFieldModel.create({
      accountId,
      key: 'loan_amount',
      label: 'Loan amount',
      type: 'currency',
    });
    const d = await setVariableSources(accountId, userActor(), r.id, [
      { key: '1', kind: 'field', value: 'loan_amount' },
    ]);
    expect(d.variables[0]?.defaultSource).toEqual({ kind: 'field', value: 'loan_amount' });
    await setVariableSources(accountId, userActor(), r.id, [
      { key: '1', kind: 'contact.name', value: 'ignored' },
    ]);
    expect((await row(r.id)).variables[0]?.defaultSource).toEqual({
      kind: 'contact.name',
      value: null,
    });
    for (const bad of [
      [{ key: '9', kind: 'ask' as const }],
      [{ key: '1', kind: 'field' as const, value: 'nope' }],
      [{ key: '1', kind: 'static' as const, value: ' ' }],
    ]) {
      await expect(setVariableSources(accountId, userActor(), r.id, bad)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    // sources survive an edit for the same key
    await setVariableSources(accountId, userActor(), r.id, [
      { key: '1', kind: 'static', value: 'Sir' },
    ]);
    await editTemplate(t.state.tx, accountId, userActor(), r.id, {
      components: [
        {
          type: 'BODY',
          text: 'Dear {{1}}, all set {{2}} ok',
          example: { body_text: [['a', 'b']] },
        },
      ],
    });
    expect((await row(r.id)).variables.map((v) => v.defaultSource)).toEqual([
      { kind: 'static', value: 'Sir' },
      { kind: 'ask', value: null },
    ]);
    const audit = await AuditLogModel.findOne({ accountId, action: 'template.variables_updated' })
      .sort({ at: 1, _id: 1 })
      .lean();
    expect(audit?.meta).toMatchObject({ keys: ['1:field'] });
  });

  it('call permission template: utility, account language, one per WABA × language', async () => {
    const { accountId } = await t.setup();
    const r = await createCallPermissionTemplate(t.state.tx, accountId, userActor(), {
      channelId: t.state.channel._id.toString(),
    });
    expect(r).toMatchObject({
      name: 'call_permission_en',
      language: 'en',
      category: 'UTILITY',
      purpose: 'call_permission',
      status: 'PENDING',
    });
    expect(r.components).toEqual([
      { type: 'BODY', text: CALL_PERMISSION_BODY },
      { type: 'call_permission_request' },
    ]);
    await expect(
      createCallPermissionTemplate(t.state.tx, accountId, userActor(), {
        channelId: t.state.channel._id.toString(),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NAME_TAKEN', details: [{ existingId: r.id }] });
    const hi = await createCallPermissionTemplate(t.state.tx, accountId, userActor(), {
      channelId: t.state.channel._id.toString(),
      language: 'hi',
      submit: false,
    });
    expect(hi.name).toBe('call_permission_hi');
  });

  it('usage counters, list (no bodies) and detail (no storage key)', async () => {
    const { accountId } = await t.setup();
    const r = await createTemplate(t.state.tx, accountId, userActor(), input({ submit: false }));
    const at = new Date('2026-11-03T10:00:00Z');
    await recordTemplateUsage(new Types.ObjectId(r.id), 'sent', at);
    await recordTemplateUsage(new Types.ObjectId(r.id), 'delivered');
    const list = await listTemplates(accountId, { q: 'ORDER' });
    expect(list).toHaveLength(1);
    expect(list[0]?.usage).toMatchObject({ sent: 1, delivered: 1, lastSentAt: at.toISOString() });
    expect(JSON.stringify(list)).not.toContain('XQZ-TPL-BODY');
    expect(await listTemplates(accountId, { status: ['APPROVED'] })).toEqual([]);
    expect(await listTemplates(new Types.ObjectId())).toEqual([]);
    await expect(getTemplate(new Types.ObjectId(), r.id)).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
    });
    await expect(getTemplate(accountId, 'bad-id')).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
    });
  });
});

describe('header examples', () => {
  const mediaInput = () =>
    input({
      name: 'promo_image',
      category: 'MARKETING',
      submit: false,
      components: [
        { type: 'HEADER', format: 'IMAGE' },
        { type: 'BODY', text: 'New offer for you {{1}} today.', example: { body_text: [['A']] } },
      ],
    });

  it('a media header needs an uploaded example; sniffed type + size per kind; stored + Meta handle', async () => {
    const { accountId } = await t.setup();
    const d = await createTemplate(t.state.tx, accountId, userActor(), mediaInput());
    await expect(submitTemplate(t.state.tx, accountId, userActor(), d.id)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'headerMedia' }],
    });
    await expect(
      uploadHeaderExample(t.state.tx, accountId, userActor(), d.id, {
        bytes: mediaFixture('sample.pdf'),
        mimeType: 'application/pdf',
        fileName: 'x.pdf',
      }),
    ).rejects.toMatchObject({ code: 'WHATSAPP_MEDIA_INVALID' });
    await expect(
      uploadHeaderExample(t.state.tx, accountId, userActor(), d.id, {
        bytes: Buffer.concat([mediaFixture('sample.png'), Buffer.alloc(5 * 1024 * 1024)]),
        mimeType: 'image/png',
        fileName: 'big.png',
      }),
    ).rejects.toMatchObject({ code: 'WHATSAPP_MEDIA_TOO_LARGE' });
    const up = await uploadHeaderExample(t.state.tx, accountId, userActor(), d.id, {
      bytes: mediaFixture('sample.png'),
      mimeType: 'image/png',
      fileName: '../../evil name.png',
    });
    expect(up.headerMedia).toEqual({
      mimeType: 'image/png',
      size: mediaFixture('sample.png').length,
      fileName: '....evil name.png',
      uploaded: true,
    });
    const stored = await row(d.id);
    expect(stored.headerMedia?.storageKey).toMatch(
      new RegExp(`^accounts/${accountId.toString()}/template-media/`),
    );
    expect(await t.storage.exists(stored.headerMedia?.storageKey ?? '')).toBe(true);
    const s = await submitTemplate(t.state.tx, accountId, userActor(), d.id);
    expect(s.status).toBe('PENDING');
    const [meta] = await t.w.fake.templates(t.state.channel.wabaId);
    expect(meta?.components[0]).toMatchObject({
      type: 'HEADER',
      format: 'IMAGE',
      example: { header_handle: [expect.stringMatching(/^fake_handle_/)] },
    });
    // a template without a media header refuses an example
    const plain = await createTemplate(
      t.state.tx,
      accountId,
      userActor(),
      input({ submit: false }),
    );
    await expect(
      uploadHeaderExample(t.state.tx, accountId, userActor(), plain.id, {
        bytes: mediaFixture('sample.png'),
        mimeType: 'image/png',
        fileName: 'a.png',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
