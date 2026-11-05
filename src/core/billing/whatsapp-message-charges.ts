import type { Types } from 'mongoose';

import { LedgerEntryModel } from '../../db/models/ledger-entry.model';

/** Captures reference a client ID; late charges reference a message ID. Read-only. */
export const capturedWhatsAppMessageCost = async (
  accountId: Types.ObjectId,
  references: readonly string[],
) => {
  let micros = 0;
  for (let offset = 0; offset < references.length; offset += 5000) {
    const rows = await LedgerEntryModel.aggregate<{ micros: number }>([
      {
        $match: {
          accountId,
          type: 'whatsapp_charge',
          status: 'captured',
          'ref.type': 'whatsapp_message',
          'ref.id': { $in: references.slice(offset, offset + 5000) },
        },
      },
      { $group: { _id: null, micros: { $sum: '$amountMicros' } } },
    ]);
    micros += rows[0]?.micros ?? 0;
  }
  return micros;
};
