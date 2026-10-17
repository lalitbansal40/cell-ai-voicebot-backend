import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { CallModel } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { DndEntryModel } from '../../src/db/models/dnd-entry.model';
import {
  decideDial,
  isValidPhone,
  loadContactFacts,
  type DialFacts,
} from '../../src/modules/campaigns/dial-guard';
import { useTestDb } from '../helpers/db';

useTestDb();

const IST = 'Asia/Kolkata';
const ist = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+05:30`);
const W = { start: '09:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] };

const facts = (over: Partial<DialFacts> = {}): DialFacts => ({
  now: ist('2026-10-19', '10:00'), // Monday
  accountStatus: 'active',
  campaignStatus: 'running',
  window: W,
  timezone: IST,
  endAt: null,
  contact: { deleted: false, optedOut: false },
  phoneValid: true,
  dnd: false,
  caps: { perDay: 3, perWeek: 10, minGapMinutes: 30 },
  counts: { today: 0, week: 0, lastCallAt: null },
  money: 'ok',
  ...over,
});

describe('decideDial (PHASE_8_PLAN §1d)', () => {
  it('dials when every check passes; single calls have no campaign status', () => {
    expect(decideDial(facts())).toEqual({ kind: 'dial' });
    expect(decideDial(facts({ campaignStatus: null }))).toEqual({ kind: 'dial' });
  });

  it('each check in order', () => {
    expect(decideDial(facts({ accountStatus: 'suspended', campaignStatus: 'paused' }))).toEqual({
      kind: 'pause',
      reason: 'account_suspended',
    });
    expect(decideDial(facts({ campaignStatus: 'paused', dnd: true }))).toEqual({ kind: 'release' });
    expect(decideDial(facts({ now: ist('2026-10-19', '07:00'), dnd: true }))).toEqual({
      kind: 'wait',
      until: ist('2026-10-19', '09:00'),
      reason: 'window',
    });
    expect(decideDial(facts({ contact: { deleted: true, optedOut: true }, dnd: true }))).toEqual({
      kind: 'skip',
      reason: 'contact_deleted',
    });
    expect(decideDial(facts({ dnd: true, contact: { deleted: false, optedOut: true } }))).toEqual({
      kind: 'skip',
      reason: 'dnd',
    });
    expect(
      decideDial(facts({ contact: { deleted: false, optedOut: true }, phoneValid: false })),
    ).toEqual({ kind: 'skip', reason: 'opted_out' });
    expect(decideDial(facts({ phoneValid: false, money: 'insufficient' }))).toEqual({
      kind: 'skip',
      reason: 'invalid_phone',
    });
    expect(decideDial(facts({ money: 'insufficient' }))).toEqual({
      kind: 'pause',
      reason: 'wallet_empty',
    });
    expect(decideDial(facts({ money: 'budget' }))).toEqual({
      kind: 'pause',
      reason: 'budget_reached',
    });
  });

  it('window: no window left → skip; a wait past the campaign end → skip', () => {
    expect(decideDial(facts({ window: { ...W, days: [] } }))).toEqual({
      kind: 'skip',
      reason: 'campaign_ended',
    });
    expect(
      decideDial(facts({ now: ist('2026-10-19', '20:00'), endAt: ist('2026-10-20', '08:00') })),
    ).toEqual({ kind: 'skip', reason: 'campaign_ended' });
    expect(
      decideDial(facts({ now: ist('2026-10-19', '20:00'), endAt: ist('2026-10-21', '08:00') })),
    ).toEqual({ kind: 'wait', until: ist('2026-10-20', '09:00'), reason: 'window' });
  });

  it('caps: week first, then day, then the minimum gap', () => {
    expect(decideDial(facts({ counts: { today: 3, week: 10, lastCallAt: null } }))).toEqual({
      kind: 'wait',
      until: ist('2026-10-26', '09:00'),
      reason: 'cap_reached',
    });
    expect(decideDial(facts({ counts: { today: 3, week: 3, lastCallAt: null } }))).toEqual({
      kind: 'wait',
      until: ist('2026-10-20', '09:00'),
      reason: 'cap_reached',
    });
    // Saturday's daily cap → Monday
    expect(
      decideDial(
        facts({ now: ist('2026-10-24', '12:00'), counts: { today: 3, week: 4, lastCallAt: null } }),
      ),
    ).toEqual({ kind: 'wait', until: ist('2026-10-26', '09:00'), reason: 'cap_reached' });
    expect(
      decideDial(facts({ counts: { today: 1, week: 1, lastCallAt: ist('2026-10-19', '09:45') } })),
    ).toEqual({ kind: 'wait', until: ist('2026-10-19', '10:15'), reason: 'min_gap' });
    expect(
      decideDial(facts({ counts: { today: 1, week: 1, lastCallAt: ist('2026-10-19', '09:00') } })),
    ).toEqual({ kind: 'dial' });
    expect(
      decideDial(
        facts({
          caps: { perDay: 3, perWeek: 10, minGapMinutes: 0 },
          counts: { today: 1, week: 1, lastCallAt: ist('2026-10-19', '09:59') },
        }),
      ),
    ).toEqual({ kind: 'dial' });
    // waits past the campaign end become skips
    expect(
      decideDial(
        facts({
          endAt: ist('2026-10-19', '18:00'),
          counts: { today: 3, week: 3, lastCallAt: null },
        }),
      ),
    ).toEqual({ kind: 'skip', reason: 'cap_reached' });
    expect(
      decideDial(
        facts({
          endAt: ist('2026-10-19', '10:05'),
          counts: { today: 1, week: 1, lastCallAt: ist('2026-10-19', '09:50') },
        }),
      ),
    ).toEqual({ kind: 'skip', reason: 'cap_reached' });
  });
});

describe('loadContactFacts', () => {
  const accountId = new Types.ObjectId();
  const callAt = async (
    contactId: Types.ObjectId,
    at: Date,
    provider = 'dryrun',
    isTest = true,
  ) => {
    const call = await CallModel.create({
      accountId,
      contactId,
      direction: 'outbound',
      provider: provider as 'dryrun',
      from: 'x',
      to: '+919000500001',
      isTest,
      source: { kind: 'agent', agentId: new Types.ObjectId() },
      timestamps: { queuedAt: at },
    });
    await CallModel.collection.updateOne({ _id: call._id }, { $set: { createdAt: at } });
  };

  it('contact state, DND on the snapshot or the current phone, and call counts per mode', async () => {
    const contact = await ContactModel.create({
      accountId,
      phoneE164: '+919000500010',
      source: { type: 'manual' },
    });
    const now = ist('2026-10-21', '12:00'); // Wednesday
    const base = {
      accountId: accountId.toString(),
      contactId: contact._id.toString(),
      phone: '+919000500010',
      mode: 'dry_run' as const,
      now,
      timezone: IST,
      minGapMinutes: 30,
    };
    expect(await loadContactFacts(base)).toEqual({
      contact: { deleted: false, optedOut: false },
      phoneValid: true,
      dnd: false,
      counts: { today: 0, week: 0, lastCallAt: null },
    });
    await callAt(contact._id, ist('2026-10-21', '10:00'));
    await callAt(contact._id, ist('2026-10-20', '10:00'));
    await callAt(contact._id, ist('2026-10-18', '10:00')); // last week
    await callAt(contact._id, ist('2026-10-21', '11:00'), 'webcall'); // web test calls never count
    await callAt(contact._id, ist('2026-10-21', '11:30'), 'sip', false);
    expect((await loadContactFacts(base)).counts).toEqual({
      today: 1,
      week: 2,
      lastCallAt: ist('2026-10-21', '10:00'),
    });
    expect((await loadContactFacts({ ...base, mode: 'live' })).counts).toEqual({
      today: 1,
      week: 1,
      lastCallAt: ist('2026-10-21', '11:30'),
    });

    // the contact changed its phone and the new one is on the DND list
    await ContactModel.updateOne({ _id: contact._id }, { phoneE164: '+919000500011' });
    await DndEntryModel.create({ accountId, phoneE164: '+919000500011', source: 'manual' });
    expect((await loadContactFacts(base)).dnd).toBe(true);
    await ContactModel.updateOne(
      { _id: contact._id },
      { optedOutAt: new Date(), deletedAt: new Date() },
    );
    expect((await loadContactFacts(base)).contact).toEqual({ deleted: true, optedOut: true });
    expect(
      (
        await loadContactFacts({
          ...base,
          contactId: new Types.ObjectId().toString(),
          phone: '123',
        })
      ).contact,
    ).toEqual({ deleted: true, optedOut: false });
  });

  it('phone validity', () => {
    expect(isValidPhone('+919000500010')).toBe(true);
    expect(isValidPhone('12345')).toBe(false);
  });
});
