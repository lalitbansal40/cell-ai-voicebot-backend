import type { Types } from 'mongoose';

import { notifyAccount } from '../../core/realtime/notify';
import { ContactModel, type MarketingStopSource } from '../../db/models/contact.model';
import { recordAudit } from '../audit/audit.service';
import { SYSTEM_ACTOR, type WaActor } from '../whatsapp/channel-status';

/**
 * The customer stopped / resumed marketing messages (WhatsApp setting, error 131050 or
 * by hand) → `whatsapp.marketing` on the contact. An older event never overwrites a
 * newer state. Returns whether the contact changed. No phone numbers in audit / logs.
 */
export const setMarketingPreference = async (input: {
  accountId: Types.ObjectId;
  contactId: Types.ObjectId;
  stopped: boolean;
  source: MarketingStopSource;
  at: Date;
  actor?: WaActor;
}): Promise<boolean> => {
  const marketing = { stopped: input.stopped, at: input.at, source: input.source };
  const res = await ContactModel.updateOne(
    {
      _id: input.contactId,
      accountId: input.accountId,
      whatsapp: { $ne: null },
      $or: [
        { 'whatsapp.marketing': null },
        { 'whatsapp.marketing': { $exists: false } },
        { 'whatsapp.marketing.at': null },
        // same second: the later event wins (a stop then a resume)
        { 'whatsapp.marketing.at': { $lte: input.at } },
      ],
    },
    { $set: { 'whatsapp.marketing': marketing } },
  );
  let changed = res.modifiedCount > 0;
  if (!changed) {
    // contacts that never had a WhatsApp profile (added by hand / import)
    const plain = await ContactModel.updateOne(
      { _id: input.contactId, accountId: input.accountId, whatsapp: null },
      { $set: { whatsapp: { waId: null, marketing } } },
    );
    changed = plain.modifiedCount > 0;
  }
  if (!changed) return false;
  const actor = input.actor ?? SYSTEM_ACTOR;
  await recordAudit({
    accountId: input.accountId,
    actor: {
      type: actor.type,
      id: actor.id,
      impersonatorId: actor.impersonatorId ?? null,
      platform: actor.platform ?? false,
    },
    action: 'contact.whatsapp_marketing_changed',
    target: { type: 'contact', id: input.contactId.toString() },
    meta: { stopped: input.stopped, source: input.source },
    ip: actor.ip ?? null,
  });
  notifyAccount(input.accountId.toString(), 'contacts.changed', { reason: 'whatsapp_marketing' });
  return true;
};

/** Contacts of the account a WhatsApp id belongs to (by `whatsapp.waId` or the phone). */
export const contactsForWaId = async (accountId: Types.ObjectId, waId: string) =>
  ContactModel.find({
    accountId,
    deletedAt: null,
    $or: [{ 'whatsapp.waId': waId }, { phoneE164: `+${waId}` }],
  })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }[]>();
