import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { FlowVersionModel } from '../../src/db/models/flow-version.model';
import { FlowModel } from '../../src/db/models/flow.model';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import { UserModel } from '../../src/db/models/user.model';
import { WebhookEndpointModel } from '../../src/db/models/webhook-endpoint.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { auditRun, parseResealArgs, resealAll } from '../../src/ops/keys-reseal';
import { readSealedValues, SEALED_FIELDS } from '../../src/shared/crypto/sealed-registry';
import { open, seal, secretKeys } from '../../src/shared/crypto/secret-box';
import { useTestDb } from '../helpers/db';

useTestDb();

const material = (n: number) => Buffer.alloc(32, n).toString('base64');
const OLD = secretKeys({ ENCRYPTION_KEY: material(1), NODE_ENV: 'test' });
const NEW = secretKeys({
  ENCRYPTION_KEY: material(2),
  ENCRYPTION_KEYS_OLD: material(1),
  NODE_ENV: 'test',
});
const NEW_ONLY = secretKeys({ ENCRYPTION_KEY: material(2), NODE_ENV: 'test' });
const STRANGER = secretKeys({ ENCRYPTION_KEY: material(3), NODE_ENV: 'test' });
const ARGS = { dryRun: false, batch: 2 };
const MARKER = 'top-secret-marker';

const graph = (value: string) => ({
  nodes: [
    { id: 'a', type: 'say', config: {} },
    { id: 'b', type: 'api_request', config: { headers: [{ name: 'X', sealed: value }] } },
  ],
});

/** One value per registered field, and two channels so paging crosses a batch. */
const seed = async (keys = OLD) => {
  const v = (name: string) => seal(keys, `${MARKER}-${name}`);
  const accountId = new Types.ObjectId();
  for (const name of ['c1', 'c2', 'c3']) {
    await WhatsAppChannelModel.collection.insertOne({
      accountId,
      tokenSealed: v(name),
      registration: { pinSealed: v(`${name}-pin`) },
    });
  }
  await MetaWebhookEventModel.collection.insertOne({ payloadSealed: v('meta') });
  await WebhookEndpointModel.collection.insertOne({
    accountId,
    secretSealed: v('hook'),
    secretPreviousSealed: v('hook-old'),
  });
  await WebhookEndpointModel.collection.insertOne({
    accountId,
    secretSealed: v('hook2'),
    secretPreviousSealed: null,
  });
  await AiAgentModel.collection.insertOne({
    accountId,
    functions: [
      {
        headers: [
          { name: 'plain', value: 'x', sealed: null },
          { name: 'X', sealed: v('fn') },
        ],
      },
    ],
  });
  await FlowModel.collection.insertOne({ accountId, draft: graph(v('draft')) });
  await FlowVersionModel.collection.insertOne({ accountId, graph: graph(v('version')) });
  await UserModel.collection.insertOne({ accountId, mfa: { secretSealed: v('mfa') } });
  await ContactModel.collection.insertOne({
    accountId,
    variables: { loan: { $enc: v('loan') }, branch: 'Pune' },
  });
  await AccountModel.collection.insertOne({
    name: 'Sealed Co',
    voiceApi: { credentials: { mode: 'own', tokenSealed: v('cell24x7') } },
    sipTrunk: { host: 'sip.carrier.in', passwordSealed: v('trunk') },
  });
};

/** Every sealed value now in the database. */
const allValues = async () => {
  const out: { field: string; value: string }[] = [];
  for (const field of SEALED_FIELDS) {
    const docs = await field.collection().find({}).toArray();
    for (const doc of docs) {
      for (const { value } of readSealedValues(doc, field.path)) {
        out.push({ field: field.name, value });
      }
    }
  }
  return out;
};

beforeEach(async () => {
  await Promise.all(
    [
      WhatsAppChannelModel,
      MetaWebhookEventModel,
      WebhookEndpointModel,
      AiAgentModel,
      FlowModel,
      ContactModel,
      UserModel,
    ]
      .map((m) => m.collection.deleteMany({}))
      .concat(AccountModel.collection.deleteMany({ name: 'Sealed Co' }))
      .concat(FlowVersionModel.collection.deleteMany({})),
  );
});

describe('keys:reseal', () => {
  it('moves every field to the new key, and a second run changes nothing', async () => {
    await seed();
    const before = await allValues();
    expect(new Set(before.map((b) => b.field)).size).toBe(SEALED_FIELDS.length);

    const first = await resealAll(NEW, ARGS);
    expect(first.reduce((s, r) => s + r.moved, 0)).toBe(before.length);
    expect(first.every((r) => r.failed === 0)).toBe(true);

    const after = await allValues();
    expect(after).toHaveLength(before.length);
    const opened = after.map((a) => open(NEW_ONLY, a.value)); // the old key is no longer needed
    expect(opened.sort()).toEqual(before.map((b) => open(OLD, b.value)).sort());

    const second = await resealAll(NEW, ARGS);
    expect(second.reduce((s, r) => s + r.moved, 0)).toBe(0);
    expect(await allValues()).toEqual(after);
  });

  it('a dry run writes nothing', async () => {
    await seed();
    const before = await allValues();
    const res = await resealAll(NEW, { ...ARGS, dryRun: true });
    expect(res.reduce((s, r) => s + r.moved, 0)).toBe(before.length);
    expect(await allValues()).toEqual(before);
  });

  it('can stop in the middle and resume with no value lost', async () => {
    await seed();
    const before = await allValues();
    let docs = 0;
    await expect(
      resealAll(NEW, ARGS, () => {
        docs += 1;
        if (docs === 2) throw new Error('stopped');
      }),
    ).rejects.toThrow('stopped');
    const partial = await allValues();
    expect(partial.map((p) => open(NEW, p.value)).sort()).toEqual(
      before.map((b) => open(OLD, b.value)).sort(),
    );
    const resumed = await resealAll(NEW, ARGS);
    expect(resumed.reduce((s, r) => s + r.current, 0)).toBeGreaterThan(0);
    const final = await allValues();
    expect(final.map((f) => open(NEW_ONLY, f.value)).sort()).toEqual(
      before.map((b) => open(OLD, b.value)).sort(),
    );
  });

  it('a value it cannot open is counted and left exactly as it was', async () => {
    await seed();
    const before = await allValues();
    const res = await resealAll(STRANGER, ARGS);
    expect(res.reduce((s, r) => s + r.failed, 0)).toBe(before.length);
    expect(res.reduce((s, r) => s + r.moved, 0)).toBe(0);
    expect(await allValues()).toEqual(before);
  });

  it('a save during the run wins over the re-seal', async () => {
    const collection = WebhookEndpointModel.collection;
    await collection.insertOne({ secretSealed: seal(OLD, 'first') });
    const { insertedId } = await collection.insertOne({ secretSealed: seal(OLD, 'second') });
    let saved = false;
    // the second row is already read in this page when the first one finishes
    await resealAll(NEW, ARGS, async (name) => {
      if (saved || name !== 'webhookEndpoints.secretSealed') return;
      saved = true;
      await collection.updateOne(
        { _id: insertedId },
        { $set: { secretSealed: seal(OLD, 'saved meanwhile') } },
      );
    });
    const row = await collection.findOne({ _id: insertedId });
    expect(saved).toBe(true);
    expect(open(NEW, String(row?.secretSealed))).toBe('saved meanwhile');
  });

  it('counts never contain a value', async () => {
    await seed();
    const res = await resealAll(NEW, ARGS);
    const text = JSON.stringify(res);
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain('v2:');
  });

  it('audits counts on the platform account only', async () => {
    const platform = await AccountModel.collection.insertOne({ isPlatform: true, name: 'p' });
    await auditRun([{ name: 'x', seen: 3, current: 1, moved: 2, failed: 0 }]);
    const row = await AuditLogModel.findOne({ action: 'keys.resealed' }).lean();
    expect(row?.accountId.toString()).toBe(platform.insertedId.toString());
    expect(row?.meta).toEqual({ moved: 2, failed: 0 });
    await AccountModel.collection.deleteOne({ _id: platform.insertedId });
    await expect(auditRun([])).resolves.toBeUndefined();
  });

  it('parses its arguments', () => {
    expect(parseResealArgs([])).toEqual({ dryRun: false, batch: 200 });
    expect(parseResealArgs(['--dry-run', '--batch', '5'])).toEqual({ dryRun: true, batch: 5 });
    for (const bad of [['--batch'], ['--batch', '0'], ['--nope']]) {
      expect(() => parseResealArgs(bad)).toThrow('Usage');
    }
  });
});

describe('sealed registry is complete', () => {
  const src = path.resolve(__dirname, '..', '..', 'src');
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? files(path.join(dir, e.name))
        : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')
          ? [path.join(dir, e.name)]
          : [],
    );

  it('every sealed field of every model is registered', () => {
    const paths = SEALED_FIELDS.map((f) => f.path).join(' ');
    const missing: string[] = [];
    const modelDir = path.join(src, 'db', 'models');
    for (const file of readdirSync(modelDir).filter((f) => f.endsWith('.model.ts'))) {
      const source = readFileSync(path.join(modelDir, file), 'utf8');
      for (const m of source.matchAll(/^\s*(\w*[sS]ealed)\??:/gm)) {
        if (!paths.includes(m[1] ?? '')) missing.push(`${file}: ${m[1] ?? ''}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('only known files write sealed values', () => {
    const writers = files(src)
      .filter((f) => !f.endsWith('secret-box.ts') && !f.endsWith('keys-reseal.ts'))
      .filter((f) => /\bseal\(/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(src, f))
      .sort();
    // a new writer means a new sealed field: add it to the registry, then to this list
    expect(writers).toEqual([
      'modules/ai-agents/functions.service.ts',
      'modules/auth/mfa.service.ts',
      'modules/flows/flows.service.ts',
      'modules/privacy/sensitive.ts',
      'modules/sip-trunks/sip-trunks.service.ts',
      'modules/voice-api/voice-api.service.ts',
      'modules/webhooks/endpoints.service.ts',
      'modules/whatsapp/context.ts',
    ]);
  });
});
