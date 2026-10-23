import { describe, expect, it } from 'vitest';

import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { createTemplate } from '../../src/modules/templates/template.service';
import { eventKey } from '../../src/modules/whatsapp/webhooks.service';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { useTemplateWorld } from '../helpers/templates';
import { userActor } from '../helpers/whatsapp';

useTestDb();
useCapturedEmail();
const t = useTemplateWorld();

/**
 * Regression (found by the P11-B2 manual check): Meta's template status value has no
 * timestamp, so the APPROVED after an edit is byte-identical to the first APPROVED. The
 * webhook dedupe key hashed the value only and dropped it as a duplicate — the edited
 * template stayed PENDING. A new delivery (another `entry.time`) must be processed.
 */
describe('template status webhooks — the same event again later', () => {
  it('a second APPROVED (after an edit) is stored and applied', async () => {
    const { accountId, users } = await t.setup();
    const d = await createTemplate(t.state.tx, accountId, userActor(users.owner.user._id), {
      channelId: t.state.channel._id.toString(),
      name: 'redelivery_check',
      language: 'en',
      category: 'UTILITY',
      components: [
        { type: 'BODY', text: 'Hi {{1}}, your EMI is due.', example: { body_text: [['A']] } },
      ],
    });
    const row = (await WhatsAppTemplateModel.findById(d.id).lean())!;
    await WhatsAppTemplateModel.updateOne({ _id: row._id }, { $set: { lastEventAt: new Date(0) } });
    const approved = (time: number) => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: t.state.channel.wabaId,
          time,
          changes: [
            {
              field: 'message_template_status_update',
              value: {
                event: 'APPROVED',
                message_template_id: row.metaTemplateId,
                message_template_name: row.name,
                message_template_language: row.language,
                message_template_category: row.category,
                reason: 'NONE',
              },
            },
          ],
        },
      ],
    });
    expect(await t.deliver(approved(1_793_000_000))).toEqual(['processed']);
    expect((await WhatsAppTemplateModel.findById(row._id).lean())?.status).toBe('APPROVED');
    // the template is edited → PENDING; Meta approves it again with the same value
    await WhatsAppTemplateModel.updateOne({ _id: row._id }, { $set: { status: 'PENDING' } });
    expect(await t.deliver(approved(1_793_003_600))).toEqual(['processed']);
    expect((await WhatsAppTemplateModel.findById(row._id).lean())?.status).toBe('APPROVED');
    // a true redelivery (same entry time) is still deduped
    expect(await t.deliver(approved(1_793_003_600))).toEqual([]);
  });

  it('the entry time is part of the key only for template fields', () => {
    const v = { event: 'APPROVED' };
    const tpl = 'message_template_status_update';
    expect(eventKey('o', 'e', tpl, v, 1)).not.toBe(eventKey('o', 'e', tpl, v, 2));
    expect(eventKey('o', 'e', tpl, v, 1)).toBe(eventKey('o', 'e', tpl, v, 1));
    expect(eventKey('o', 'e', 'messages', v, 1)).toBe(eventKey('o', 'e', 'messages', v, 2));
  });
});
