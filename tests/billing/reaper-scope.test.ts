import { Writable } from 'node:stream';

import { Types } from 'mongoose';
import { afterEach, describe, expect, it } from 'vitest';

import { reapStaleHolds } from '../../src/core/billing/reaper';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { createLogger, setLogger } from '../../src/shared/logger';
import { useTestDb } from '../helpers/db';

useTestDb();

afterEach(() => setLogger(createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' })));

/**
 * Regression (Phase 11, locked fix): the call-hold reaper released every `held` row
 * older than 2 h. WhatsApp message holds live up to 72 h and are not call holds —
 * the reaper must leave them alone (no release attempt, no error, no batch slot).
 */
describe('call hold reaper scope', () => {
  it('leaves WhatsApp message holds alone', async () => {
    const lines: string[] = [];
    setLogger(
      createLogger(
        { NODE_ENV: 'test', LOG_LEVEL: 'trace' },
        new Writable({
          write(chunk: Buffer, _enc, done) {
            lines.push(chunk.toString());
            done();
          },
        }),
      ),
    );
    const accountId = new Types.ObjectId();
    await LedgerEntryModel.create({
      accountId,
      type: 'whatsapp_charge',
      direction: 'debit',
      status: 'held',
      amountMicros: 132_300,
      ref: { type: 'whatsapp_message', id: 'm1' },
      idempotencyKey: 'wa-hold-reaper-scope',
    });
    await LedgerEntryModel.collection.updateOne(
      { idempotencyKey: 'wa-hold-reaper-scope' },
      { $set: { createdAt: new Date(Date.now() - 3 * 3_600_000) } },
    );
    expect(await reapStaleHolds()).toEqual({ released: 0 });
    expect(
      await LedgerEntryModel.findOne({ idempotencyKey: 'wa-hold-reaper-scope' }).lean(),
    ).toMatchObject({ status: 'held' });
    expect(lines.join('')).not.toContain('stale hold release failed');
  });
});
