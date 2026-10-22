import type { Types } from 'mongoose';

import { isDuplicateKeyError } from '../../db/errors';
import {
  ContactModel,
  EMPTY_CONTACT_WHATSAPP,
  type ContactDoc,
} from '../../db/models/contact.model';
import { DndEntryModel } from '../../db/models/dnd-entry.model';
import { buildSearchText } from '../contacts/normalize/search-text';

const clipName = (name: string | null | undefined): string | null => {
  const v = name?.replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, 120) : null;
};

/**
 * The live contact for a WhatsApp customer (PHASE_10_PLAN §1g): matched by
 * `+<waId>`, else created (`source: whatsapp`). The WhatsApp profile is kept up to
 * date; the contact's own name changes only while no person named it (a
 * WhatsApp-created contact follows the profile name; any contact without a name
 * takes it). Deleted contacts are never revived. Race-safe (unique live phone).
 */
export const findOrCreateWhatsAppContact = async (input: {
  accountId: Types.ObjectId;
  waId: string;
  profileName?: string | null;
  /** Customer message time (`lastInboundAt`); null for echoes / syncs. */
  inboundAt?: Date | null;
  /** History / phone-contact syncs: name from the business's phone book. */
  bookName?: string | null;
}): Promise<ContactDoc> => {
  const phoneE164 = `+${input.waId}`;
  const profileName = clipName(input.profileName);
  const bookName = clipName(input.bookName);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await ContactModel.findOne({
      accountId: input.accountId,
      phoneE164,
      deletedAt: null,
    }).lean<ContactDoc>();
    if (existing) {
      const wa = existing.whatsapp ?? EMPTY_CONTACT_WHATSAPP;
      const set: Record<string, unknown> = {};
      const nextWa = {
        ...wa,
        waId: input.waId,
        ...(profileName ? { profileName } : {}),
        ...(input.inboundAt && (!wa.lastInboundAt || wa.lastInboundAt < input.inboundAt)
          ? { lastInboundAt: input.inboundAt }
          : {}),
        ...(bookName ? { syncRemovedAt: null } : {}),
      };
      const candidate = bookName ?? profileName;
      const mayRename =
        candidate &&
        !wa.nameEditedAt &&
        (!existing.name || (existing.source.type === 'whatsapp' && existing.name !== candidate));
      if (mayRename) {
        set.name = candidate;
        set.searchText = buildSearchText({
          name: candidate,
          email: existing.email ?? null,
          phoneE164,
          externalId: existing.externalId ?? null,
        });
      }
      if (JSON.stringify(nextWa) !== JSON.stringify(wa)) set.whatsapp = nextWa;
      if (!Object.keys(set).length) return existing;
      const updated = await ContactModel.findOneAndUpdate(
        { _id: existing._id, accountId: input.accountId },
        { $set: set },
        { returnDocument: 'after' },
      ).lean<ContactDoc>();
      return updated ?? existing;
    }
    const name = bookName ?? profileName;
    try {
      const dnd = Boolean(await DndEntryModel.exists({ accountId: input.accountId, phoneE164 }));
      const created = await ContactModel.create({
        accountId: input.accountId,
        phoneE164,
        name,
        source: { type: 'whatsapp' },
        dnd,
        searchText: buildSearchText({ name, email: null, phoneE164, externalId: null }),
        whatsapp: {
          ...EMPTY_CONTACT_WHATSAPP,
          waId: input.waId,
          profileName,
          lastInboundAt: input.inboundAt ?? null,
        },
      });
      return created.toObject({ transform: false });
    } catch (err) {
      // the same customer's other message created it a moment ago → read it
      if (!isDuplicateKeyError(err) || attempt > 0) throw err;
    }
  }
  /* c8 ignore next -- the loop always returns or throws */
  throw new Error('unreachable');
};
