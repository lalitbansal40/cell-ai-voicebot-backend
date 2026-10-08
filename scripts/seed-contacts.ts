/**
 * DEV ONLY — demo contacts for an account (used by `npm run db:seed`).
 * Idempotent: upserts by field key, list / segment name and phone.
 * All data is fake: phones +91 90009 001xx, names "Demo Borrower NN".
 */
import type { Types } from 'mongoose';

import { ContactListModel } from '../src/db/models/contact-list.model';
import { ContactModel } from '../src/db/models/contact.model';
import { CustomFieldModel, type FieldType } from '../src/db/models/custom-field.model';
import { DndEntryModel } from '../src/db/models/dnd-entry.model';
import { SegmentModel } from '../src/db/models/segment.model';
import { buildSearchText } from '../src/modules/contacts/normalize';

export const DEMO_FIELDS: { key: string; label: string; type: FieldType; required?: boolean }[] = [
  { key: 'loan_id', label: 'Loan ID', type: 'text' },
  { key: 'loan_amount', label: 'Loan amount', type: 'currency', required: true },
  { key: 'emi_amount', label: 'EMI amount', type: 'currency' },
  { key: 'due_date', label: 'Due date', type: 'date' },
  { key: 'days_past_due', label: 'Days past due', type: 'number' },
  { key: 'branch', label: 'Branch', type: 'text' },
];

const BRANCHES = ['Pune', 'Mumbai', 'Delhi', 'Jaipur', 'Indore'];
export const DEMO_CONTACT_COUNT = 25;
export const demoPhone = (i: number): string => `+9190009001${String(i).padStart(2, '0')}`;

export const seedContacts = async (
  accountId: Types.ObjectId,
  createdBy: Types.ObjectId,
): Promise<{ fields: number; contacts: number; dnd: number }> => {
  for (const [order, f] of DEMO_FIELDS.entries()) {
    await CustomFieldModel.updateOne(
      { accountId, key: f.key },
      {
        $setOnInsert: {
          accountId,
          key: f.key,
          label: f.label,
          type: f.type,
          required: Boolean(f.required),
          defaultValue: null,
          order: order + 1,
        },
      },
      { upsert: true },
    );
  }
  const list = await ContactListModel.findOneAndUpdate(
    { accountId, name: 'Demo borrowers' },
    {
      $setOnInsert: {
        accountId,
        name: 'Demo borrowers',
        description: 'Seed data',
        source: { type: 'manual', fileName: null },
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  let contacts = 0;
  for (let i = 1; i <= DEMO_CONTACT_COUNT; i += 1) {
    const phoneE164 = demoPhone(i);
    const name = `Demo Borrower ${String(i).padStart(2, '0')}`;
    const loanId = `DEMO-${String(i).padStart(4, '0')}`;
    const dpd = (i * 9) % 75;
    const due = new Date(Date.UTC(2026, 9, 1) - dpd * 86_400_000).toISOString().slice(0, 10);
    const res = await ContactModel.updateOne(
      { accountId, phoneE164, deletedAt: null },
      {
        $setOnInsert: {
          accountId,
          phoneE164,
          name,
          email: null,
          externalId: loanId,
          variables: {
            loan_id: loanId,
            loan_amount: (50_000 + i * 2_500) * 1_000_000,
            emi_amount: (2_000 + i * 100) * 1_000_000,
            due_date: due,
            days_past_due: dpd,
            branch: BRANCHES[i % BRANCHES.length],
          },
          tags: i % 5 === 0 ? ['vip'] : [],
          listIds: [list?._id],
          dnd: i <= 2,
          optedOutAt: null,
          consent: { source: 'Loan agreement', at: new Date(Date.UTC(2026, 0, 1)) },
          source: { type: 'manual', importJobId: null },
          searchText: buildSearchText({ name, phoneE164, externalId: loanId }),
          lastCalledAt: null,
          callCount: 0,
          deletedAt: null,
        },
      },
      { upsert: true },
    );
    contacts += res.upsertedCount;
  }

  let dnd = 0;
  for (const i of [1, 2]) {
    const res = await DndEntryModel.updateOne(
      { accountId, phoneE164: demoPhone(i) },
      {
        $setOnInsert: {
          accountId,
          phoneE164: demoPhone(i),
          reason: 'Asked not to be called',
          source: 'manual',
          addedBy: createdBy,
        },
      },
      { upsert: true },
    );
    dnd += res.upsertedCount;
  }

  await SegmentModel.updateOne(
    { accountId, name: 'Overdue > 30 days' },
    {
      $setOnInsert: {
        accountId,
        name: 'Overdue > 30 days',
        filter: { conditions: [{ key: 'days_past_due', op: 'gt', value: 30 }] },
        createdBy,
      },
    },
    { upsert: true },
  );
  return { fields: DEMO_FIELDS.length, contacts, dnd };
};
