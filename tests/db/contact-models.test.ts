import type mongoose from 'mongoose';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { DndEntryModel } from '../../src/db/models/dnd-entry.model';
import { ExportJobModel } from '../../src/db/models/export-job.model';
import { emptyImportTotals, ImportJobModel } from '../../src/db/models/import-job.model';
import { SegmentModel } from '../../src/db/models/segment.model';
import { useTestDb } from '../helpers/db';

useTestDb();

interface IndexInfo {
  key: Record<string, number>;
  unique: boolean;
  partial?: Record<string, unknown>;
  collation?: { locale: string; strength: number };
}
const indexes = async (model: mongoose.Model<never>): Promise<IndexInfo[]> =>
  (await model.collection.listIndexes().toArray()).map((i) => ({
    key: i.key as Record<string, number>,
    unique: Boolean(i.unique),
    partial: i.partialFilterExpression as Record<string, unknown> | undefined,
    collation: i.collation as IndexInfo['collation'],
  }));
const keysOf = async (model: mongoose.Model<never>) =>
  (await indexes(model)).map((i) => JSON.stringify(i.key));

const acc = () => new Types.ObjectId();
const contact = (accountId: Types.ObjectId, extra: Record<string, unknown> = {}) =>
  ContactModel.create({
    accountId,
    phoneE164: '+919000000001',
    source: { type: 'manual' },
    ...extra,
  });

describe('Contact', () => {
  it('applies defaults and hides searchText / deletedAt in JSON', async () => {
    const c = await contact(acc(), { searchText: 'asha 9000000001' });
    expect(c.dnd).toBe(false);
    expect(c.callCount).toBe(0);
    expect(c.tags).toEqual([]);
    expect(c.listIds).toEqual([]);
    expect(c.variables.size).toBe(0);
    expect(c.consent).toBeNull();
    expect(c.source).toMatchObject({ type: 'manual', importJobId: null });
    const json = c.toJSON() as unknown as Record<string, unknown>;
    expect(json.id).toBe(c._id.toString());
    expect(json).not.toHaveProperty('searchText');
    expect(json).not.toHaveProperty('deletedAt');
    expect(json).not.toHaveProperty('_id');
  });

  it('stores typed variables in a map', async () => {
    const c = await contact(acc(), {
      variables: { loan_amount: 12_500_000_000, due_date: '2026-10-05', branch: 'Pune' },
    });
    const stored = await ContactModel.findById(c._id).lean();
    expect(stored?.variables).toEqual({
      loan_amount: 12_500_000_000,
      due_date: '2026-10-05',
      branch: 'Pune',
    });
  });

  it('is unique per account by phone, but a soft-deleted contact frees the number', async () => {
    const a = acc();
    const first = await contact(a);
    await expect(contact(a)).rejects.toMatchObject({ code: 11000 });
    await contact(acc()); // another account — fine
    await ContactModel.updateOne({ _id: first._id }, { $set: { deletedAt: new Date() } });
    await expect(contact(a)).resolves.toBeTruthy();
  });

  it('externalId is unique per account only when set', async () => {
    const a = acc();
    await contact(a, { phoneE164: '+919000000010' });
    await contact(a, { phoneE164: '+919000000011' }); // both null — fine
    await contact(a, { phoneE164: '+919000000012', externalId: 'LN-1' });
    await expect(
      contact(a, { phoneE164: '+919000000013', externalId: 'LN-1' }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('rejects an unknown source type and too long names', async () => {
    await expect(contact(acc(), { source: { type: 'fax' as never } })).rejects.toThrow();
    await expect(contact(acc(), { name: 'x'.repeat(121) })).rejects.toThrow();
  });

  it('has the documented indexes', async () => {
    const list = await indexes(ContactModel as never);
    const find = (key: Record<string, number>) =>
      list.find((i) => JSON.stringify(i.key) === JSON.stringify(key));
    expect(find({ accountId: 1, phoneE164: 1 })).toMatchObject({
      unique: true,
      partial: { deletedAt: null },
    });
    expect(find({ accountId: 1, externalId: 1 })).toMatchObject({
      unique: true,
      partial: { externalId: { $type: 'string' }, deletedAt: null },
    });
    expect(find({ accountId: 1, name: 1 })?.collation).toMatchObject({
      locale: 'en',
      strength: 2,
    });
    for (const key of [
      { accountId: 1, deletedAt: 1, createdAt: -1 } as Record<string, number>,
      { accountId: 1, listIds: 1 },
      { accountId: 1, tags: 1 },
      { accountId: 1, dnd: 1 },
    ]) {
      expect(find(key)).toBeTruthy();
    }
  });
});

describe('ContactList', () => {
  it('names are unique per account (case-insensitive) among live lists', async () => {
    const a = acc();
    const first = await ContactListModel.create({
      accountId: a,
      name: 'March',
      source: { type: 'manual' },
    });
    await expect(
      ContactListModel.create({ accountId: a, name: 'march', source: { type: 'manual' } }),
    ).rejects.toMatchObject({ code: 11000 });
    await ContactListModel.updateOne({ _id: first._id }, { $set: { deletedAt: new Date() } });
    await expect(
      ContactListModel.create({ accountId: a, name: 'March', source: { type: 'upload' } }),
    ).resolves.toBeTruthy();
    expect(first.toJSON()).not.toHaveProperty('deletedAt');
  });

  it('rejects an unknown source', async () => {
    await expect(
      ContactListModel.create({ accountId: acc(), name: 'x', source: { type: 'ftp' as never } }),
    ).rejects.toThrow();
  });
});

describe('CustomField', () => {
  it('validates key format and type; unique key per account', async () => {
    const a = acc();
    await CustomFieldModel.create({
      accountId: a,
      key: 'loan_amount',
      label: 'Loan',
      type: 'currency',
    });
    await expect(
      CustomFieldModel.create({ accountId: a, key: 'loan_amount', label: 'Again', type: 'text' }),
    ).rejects.toMatchObject({ code: 11000 });
    await expect(
      CustomFieldModel.create({ accountId: a, key: 'Loan', label: 'x', type: 'text' }),
    ).rejects.toThrow();
    await expect(
      CustomFieldModel.create({ accountId: a, key: 'flag', label: 'x', type: 'boolean' as never }),
    ).rejects.toThrow();
    const f = await CustomFieldModel.create({
      accountId: a,
      key: 'branch',
      label: 'Branch',
      type: 'text',
    });
    expect(f.required).toBe(false);
    expect(f.defaultValue).toBeNull();
    expect(await keysOf(CustomFieldModel as never)).toContain(
      JSON.stringify({ accountId: 1, key: 1 }),
    );
  });
});

describe('Segment, DND entry', () => {
  it('segment names are unique per account (case-insensitive)', async () => {
    const a = acc();
    const by = new Types.ObjectId();
    await SegmentModel.create({ accountId: a, name: 'Overdue', filter: {}, createdBy: by });
    await expect(
      SegmentModel.create({ accountId: a, name: 'OVERDUE', filter: {}, createdBy: by }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('DND phone is unique per account; source is an enum', async () => {
    const a = acc();
    await DndEntryModel.create({ accountId: a, phoneE164: '+919000000001', source: 'manual' });
    await expect(
      DndEntryModel.create({ accountId: a, phoneE164: '+919000000001', source: 'upload' }),
    ).rejects.toMatchObject({ code: 11000 });
    await expect(
      DndEntryModel.create({ accountId: a, phoneE164: '+919000000002', source: 'sms' as never }),
    ).rejects.toThrow();
  });
});

describe('Import / export jobs', () => {
  it('import job defaults and hidden storage keys', async () => {
    const job = await ImportJobModel.create({
      accountId: acc(),
      kind: 'contacts',
      fileName: 'march.csv',
      fileKey: 'accounts/a/imports/x.csv',
      fileType: 'csv',
      fileSize: 10,
      createdBy: new Types.ObjectId(),
    });
    expect(job.status).toBe('uploaded');
    expect(job.totals).toEqual(emptyImportTotals());
    expect(job.progress).toMatchObject({ processed: 0, total: 0 });
    const json = job.toJSON() as unknown as Record<string, unknown>;
    expect(json).not.toHaveProperty('fileKey');
    expect(json).not.toHaveProperty('errorReportKey');
    expect(json).not.toHaveProperty('cancelRequested');
    await expect(
      ImportJobModel.create({
        accountId: job.accountId,
        kind: 'contacts',
        fileName: 'x.csv',
        fileType: 'csv',
        fileSize: 1,
        createdBy: job.createdBy,
        status: 'paused' as never,
      }),
    ).rejects.toThrow();
  });

  it('export job defaults and hidden file key', async () => {
    const job = await ExportJobModel.create({
      accountId: acc(),
      scope: 'filter',
      createdBy: new Types.ObjectId(),
    });
    expect(job.status).toBe('pending');
    expect(job.filter).toEqual({});
    expect(job.toJSON()).not.toHaveProperty('fileKey');
    expect(await keysOf(ExportJobModel as never)).toContain(
      JSON.stringify({ status: 1, expiresAt: 1 }),
    );
    expect(await keysOf(ImportJobModel as never)).toContain(
      JSON.stringify({ accountId: 1, createdAt: -1 }),
    );
  });
});
