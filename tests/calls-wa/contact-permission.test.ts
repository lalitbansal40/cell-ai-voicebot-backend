import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { ContactModel } from '../../src/db/models/contact.model';
import { WhatsAppCallPermissionModel } from '../../src/db/models/whatsapp-call-permission.model';
import {
  compileContactFilter,
  type CompileContext,
} from '../../src/modules/contacts/filter/compile';
import {
  permissionSummary,
  summarizePermission,
} from '../../src/modules/whatsapp-calling/permissions.service';
import { useTestDb } from '../helpers/db';

useTestDb();
const now = new Date('2026-11-04T10:00:00Z');
const later = new Date('2026-11-10T10:00:00Z');
const earlier = new Date('2026-11-01T10:00:00Z');
const ctx: CompileContext = { fields: new Map(), timezone: 'Asia/Kolkata', country: 'IN', now };

describe('contact call permission summary (T18B.3)', () => {
  it('allowed wins over asked over declined; an old temporary is declined', () => {
    const r = (status: string, expiresAt: Date | null = null) => ({ status, expiresAt }) as never;
    expect(permissionSummary([], now)).toBe('none');
    expect(permissionSummary([r('none')], now)).toBe('none');
    expect(permissionSummary([r('declined'), r('requested')], now)).toBe('asked');
    expect(permissionSummary([r('requested'), r('temporary', later)], now)).toBe('allowed');
    expect(permissionSummary([r('permanent')], now)).toBe('allowed');
    expect(permissionSummary([r('temporary', earlier)], now)).toBe('declined');
    expect(permissionSummary([r('revoked')], now)).toBe('declined');
    expect(permissionSummary([r('expired')], now)).toBe('declined');
  });

  it('writes the summary on the contact from its rows', async () => {
    const accountId = new Types.ObjectId();
    const contact = await ContactModel.create({
      accountId,
      phoneE164: '+919000000101',
      name: 'A',
      source: { type: 'manual' },
    });
    expect(contact.waCallPermission).toBe('none');
    const row = { accountId, contactId: contact._id, waId: '919000000101' };
    await WhatsAppCallPermissionModel.create({
      ...row,
      channelId: new Types.ObjectId(),
      status: 'requested',
    });
    expect(await summarizePermission(accountId, contact._id, now)).toBe('asked');
    await WhatsAppCallPermissionModel.create({
      ...row,
      channelId: new Types.ObjectId(),
      status: 'temporary',
      expiresAt: later,
    });
    expect(await summarizePermission(accountId, contact._id, now)).toBe('allowed');
    expect((await ContactModel.findById(contact._id).lean())?.waCallPermission).toBe('allowed');
  });

  it('filter: whatsappCallPermission eq / neq, none also matches old rows without the field', () => {
    const one = (op: 'eq' | 'neq', value: string) => {
      const { query, problems } = compileContactFilter(
        new Types.ObjectId(),
        { conditions: [{ key: 'whatsappCallPermission', op, value }] },
        ctx,
      );
      expect(problems).toEqual([]);
      return (query.$and as Record<string, unknown>[])[0];
    };
    expect(one('eq', 'allowed')).toEqual({ waCallPermission: 'allowed' });
    expect(one('neq', 'declined')).toEqual({ waCallPermission: { $ne: 'declined' } });
    expect(one('eq', 'none')).toEqual({ waCallPermission: { $in: ['none', null] } });
    expect(one('neq', 'none')).toEqual({ waCallPermission: { $nin: ['none', null] } });
    const bad = compileContactFilter(
      new Types.ObjectId(),
      { conditions: [{ key: 'whatsappCallPermission', op: 'eq', value: 'maybe' }] },
      ctx,
    );
    expect(bad.problems[0]?.message).toMatch(/allowed, asked, declined, none/);
    const op = compileContactFilter(
      new Types.ObjectId(),
      { conditions: [{ key: 'whatsappCallPermission', op: 'exists' }] },
      ctx,
    );
    expect(op.problems[0]?.message).toMatch(/can't be used/);
  });
});
