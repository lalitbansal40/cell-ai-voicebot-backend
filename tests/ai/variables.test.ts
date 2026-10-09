import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';

import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import {
  accountVariables,
  contactVariables,
  manualVariables,
} from '../../src/modules/ai-agents/variables';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';

useTestDb();

let t: TestAccount;
const FIELDS = [
  ['loan_amount', 'currency'],
  ['due_date', 'date'],
  ['emi_count', 'number'],
  ['branch', 'text'],
  ['alt_phone', 'phone'],
] as const;

beforeAll(async () => {
  t = await createTestAccount();
  await CustomFieldModel.insertMany(
    FIELDS.map(([key, type], order) => ({
      accountId: t.account._id,
      key,
      label: key,
      type,
      order,
    })),
  );
});

describe('agent variables', () => {
  it('lists built-ins first, then custom fields in order', async () => {
    const vars = await accountVariables(t.account._id);
    expect(vars.map((v) => v.name)).toEqual(['name', 'phone_last4', ...FIELDS.map(([key]) => key)]);
    expect(vars[0]?.type).toBe('built_in');
    // other accounts' fields never show up
    const other = await createTestAccount();
    expect(await accountVariables(other.account._id)).toHaveLength(2);
  });

  it('formats allowed contact values for reading, nothing else', async () => {
    const c = await ContactModel.create({
      accountId: t.account._id,
      phoneE164: '+919876501234',
      name: 'Asha',
      source: { type: 'manual' },
      variables: {
        loan_amount: 1_250_500_000,
        due_date: '2026-10-05',
        emi_count: 12345,
        branch: 'Pune',
        alt_phone: '+919800000000',
      },
    });
    const all = ['name', 'phone_last4', ...FIELDS.map(([key]) => key)];
    const { values, contact } = await contactVariables(t.account._id, c._id, all);
    expect(values).toEqual({
      name: 'Asha',
      phone_last4: '1234',
      loan_amount: '₹1,250.50',
      due_date: '5 Oct 2026',
      emi_count: '12,345',
      branch: 'Pune',
      alt_phone: '+919800000000',
    });
    expect(contact.phoneE164).toBe('+919876501234');
    const some = await contactVariables(t.account._id, c._id, ['branch']);
    expect(some.values).toEqual({ branch: 'Pune' });
  });

  it('turns missing, unknown or odd values into empty strings', async () => {
    const c = await ContactModel.create({
      accountId: t.account._id,
      phoneE164: '+919876501235',
      source: { type: 'manual' },
    });
    const { values } = await contactVariables(t.account._id, c._id, [
      'name',
      'loan_amount',
      'due_date',
      'gone_field',
    ]);
    expect(values).toEqual({ name: '', loan_amount: '', due_date: '', gone_field: '' });
  });

  it("404s for another account's contact", async () => {
    const other = await createTestAccount();
    const c = await ContactModel.create({
      accountId: other.account._id,
      phoneE164: '+919876501236',
      source: { type: 'manual' },
    });
    await expect(contactVariables(t.account._id, c._id, ['name'])).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      contactVariables(t.account._id, new Types.ObjectId(), ['name']),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('keeps only allowed manual values, trimmed and capped', () => {
    expect(
      manualVariables({ name: '  Ravi  ', loan_amount: 'x'.repeat(300), other: 'no' }, [
        'name',
        'loan_amount',
        'due_date',
      ]),
    ).toEqual({ name: 'Ravi', loan_amount: 'x'.repeat(200), due_date: '' });
    expect(manualVariables(undefined, ['name'])).toEqual({ name: '' });
  });
});
