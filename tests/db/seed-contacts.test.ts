import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  DEMO_CONTACT_COUNT,
  DEMO_FIELDS,
  demoPhone,
  seedContacts,
} from '../../scripts/seed-contacts';
import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { DndEntryModel } from '../../src/db/models/dnd-entry.model';
import { SegmentModel } from '../../src/db/models/segment.model';
import { useTestDb } from '../helpers/db';

useTestDb();

describe('seedContacts', () => {
  it('creates demo fields, list, contacts, DND and a segment — idempotently', async () => {
    const accountId = new Types.ObjectId();
    const by = new Types.ObjectId();
    expect(await seedContacts(accountId, by)).toEqual({ fields: 6, contacts: 25, dnd: 2 });
    expect(await seedContacts(accountId, by)).toEqual({ fields: 6, contacts: 0, dnd: 0 });
    expect(await CustomFieldModel.countDocuments({ accountId })).toBe(DEMO_FIELDS.length);
    expect(await ContactModel.countDocuments({ accountId })).toBe(DEMO_CONTACT_COUNT);
    const list = await ContactListModel.findOne({ accountId, name: 'Demo borrowers' }).lean();
    expect(await ContactModel.countDocuments({ accountId, listIds: list?._id })).toBe(25);
    const first = await ContactModel.findOne({ accountId, phoneE164: demoPhone(1) }).lean();
    expect(first).toMatchObject({ dnd: true, name: 'Demo Borrower 01', externalId: 'DEMO-0001' });
    expect(first?.searchText).toContain('919000900101');
    expect(await DndEntryModel.countDocuments({ accountId })).toBe(2);
    expect(await SegmentModel.countDocuments({ accountId, name: 'Overdue > 30 days' })).toBe(1);
  });
});
