import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  accountUpdateValueSchema,
  buildTemplatePayload,
  inboxMessagesValueSchema,
  mapSendError,
  mapTemplateError,
  REACTIONS_BILLABLE,
  TEMPLATE_WEBHOOK_VALUE_SCHEMAS,
  templateSendEffect,
  VOLUME_TIER_EVENT,
  WEBHOOK_FIELDS,
  webhookEnvelopeSchema,
  type TemplateSendInput,
} from '../../src/core/meta';
import { ValidationError } from '../../src/shared/errors/app-error';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '../fixtures/meta', name), 'utf8'));
const valueOf = (name: string) => {
  const env = webhookEnvelopeSchema.parse(fixture(name));
  const change = env.entry[0]?.changes[0];
  if (!change) throw new Error('no change');
  return change;
};

describe('Phase 11 webhook schemas (Meta samples)', () => {
  it('template status updates: approved, rejected, paused, disabled', () => {
    const parse = (name: string) => {
      const c = valueOf(name);
      expect(c.field).toBe('message_template_status_update');
      return TEMPLATE_WEBHOOK_VALUE_SCHEMAS.message_template_status_update.parse(c.value);
    };
    expect(parse('templates-status-approved.json')).toMatchObject({
      event: 'APPROVED',
      message_template_id: '9000000000000001',
      message_template_name: 'test_order_update',
      message_template_language: 'en_US',
      message_template_category: 'UTILITY',
    });
    expect(parse('templates-status-rejected.json')).toMatchObject({
      event: 'REJECTED',
      reason: 'INVALID_FORMAT',
      rejection_info: { reason: 'Test reason' },
    });
    expect(parse('templates-status-paused.json').other_info?.title).toBe('FIRST_PAUSE');
    expect(parse('templates-status-disabled.json').disable_info?.disable_date).toBe(1761206400);
    // the Phase 9 sample still parses
    expect(parse('webhook-template-status.json').event).toBe('APPROVED');
  });

  it('quality, category (both variants) and components updates', () => {
    const s = TEMPLATE_WEBHOOK_VALUE_SCHEMAS;
    expect(
      s.message_template_quality_update.parse(valueOf('templates-quality.json').value),
    ).toMatchObject({
      previous_quality_score: 'GREEN',
      new_quality_score: 'RED',
    });
    expect(
      s.template_category_update.parse(valueOf('templates-category-pending.json').value),
    ).toMatchObject({
      correct_category: 'MARKETING',
      new_category: 'UTILITY',
    });
    expect(
      s.template_category_update.parse(valueOf('templates-category-changed.json').value),
    ).toMatchObject({ previous_category: 'UTILITY', new_category: 'MARKETING' });
    const comp = s.message_template_components_update.parse(
      valueOf('templates-components.json').value,
    );
    expect(comp.message_template_buttons).toHaveLength(2);
    expect(comp.message_template_buttons?.[0]?.message_template_button_type).toBe('URL');
    expect(() => s.message_template_quality_update.parse({ message_template_id: 1 })).toThrow();
  });

  it('user preferences stop / resume', () => {
    const stop = TEMPLATE_WEBHOOK_VALUE_SCHEMAS.user_preferences.parse(
      valueOf('user-preferences-stop.json').value,
    );
    expect(stop.user_preferences[0]).toMatchObject({
      wa_id: '919000000101',
      category: 'marketing_messages',
      value: 'stop',
    });
    expect(stop.metadata?.phone_number_id).toBe('106540352242922');
    const resume = TEMPLATE_WEBHOOK_VALUE_SCHEMAS.user_preferences.parse(
      valueOf('user-preferences-resume.json').value,
    );
    expect(resume.user_preferences[0]?.value).toBe('resume');
    expect(() =>
      TEMPLATE_WEBHOOK_VALUE_SCHEMAS.user_preferences.parse({ user_preferences: [] }),
    ).toThrow();
  });

  it('account_update volume tier event', () => {
    const v = accountUpdateValueSchema.parse(
      valueOf('webhook-account-update-volume-tier.json').value,
    );
    expect(v.event).toBe(VOLUME_TIER_EVENT);
    expect(v.volume_tier_info).toMatchObject({
      pricing_category: 'UTILITY',
      tier: '25000001:50000000',
      effective_month: '2026-11',
      region: 'India',
    });
  });

  it('status pricing incl. subtype and free entry point', () => {
    const pricing = (name: string) =>
      inboxMessagesValueSchema.parse(valueOf(name).value).statuses?.[0]?.pricing;
    expect(pricing('pricing-template-billable.json')).toMatchObject({
      billable: true,
      category: 'marketing',
      type: 'regular',
    });
    expect(pricing('pricing-service-free.json')).toMatchObject({
      billable: false,
      type: 'free_customer_service',
    });
    expect(pricing('pricing-service-paid-exempt.json')?.subtype).toBe('paid_exempt');
    expect(pricing('pricing-free-entry-point.json')).toMatchObject({
      billable: false,
      type: 'free_entry_point',
    });
  });

  it('subscribes the components update field; reactions are held like service', () => {
    expect(WEBHOOK_FIELDS).toContain('message_template_components_update');
    expect(new Set(WEBHOOK_FIELDS).size).toBe(WEBHOOK_FIELDS.length);
    expect(
      Object.keys(TEMPLATE_WEBHOOK_VALUE_SCHEMAS).every((f) =>
        (WEBHOOK_FIELDS as readonly string[]).includes(f),
      ),
    ).toBe(true);
    expect(REACTIONS_BILLABLE).toBe(true);
  });
});

describe('buildTemplatePayload', () => {
  const base: TemplateSendInput = {
    name: 'order_update',
    language: 'en',
    parameterFormat: 'positional',
  };

  it('no parameters → no components', () => {
    expect(buildTemplatePayload('919000000101', base)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919000000101',
      type: 'template',
      template: { name: 'order_update', language: { code: 'en' } },
    });
  });

  it('positional: text header, body in number order, every button kind', () => {
    const payload = buildTemplatePayload('919000000101', {
      ...base,
      language: 'en_US',
      header: { type: 'text', text: 'ORD-1' },
      body: [
        { key: '10', text: 'ten' },
        { key: '2', text: 'two' },
        { key: '1', text: 'one' },
      ],
      buttons: [
        { subType: 'quick_reply', index: 2, payload: 'qr_t1_2' },
        { subType: 'url', index: 0, text: 'a b/c?d=1&e' },
        { subType: 'copy_code', index: 1, code: 'SAVE20' },
      ],
    });
    expect(payload).toMatchSnapshot();
    const components = (payload.template as { components: Record<string, unknown>[] }).components;
    expect(components.map((c) => c.type)).toEqual(['header', 'body', 'button', 'button', 'button']);
    expect((components[1]?.parameters as { text: string }[]).map((p) => p.text)).toEqual([
      'one',
      'two',
      'ten',
    ]);
    expect(components[2]).toEqual({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: 'a%20b%2Fc%3Fd%3D1%26e' }],
    });
  });

  it('named: parameter_name on body and text header; media / location headers', () => {
    expect(
      buildTemplatePayload('919000000101', {
        ...base,
        parameterFormat: 'named',
        header: { type: 'text', text: 'Asha', name: 'first_name' },
        body: [
          { key: 'first_name', text: 'Asha' },
          { key: 'order_id', text: 'ORD-1' },
        ],
      }),
    ).toMatchSnapshot();
    for (const header of [
      { type: 'image' as const, mediaId: 'm1' },
      { type: 'video' as const, mediaId: 'm2' },
      { type: 'document' as const, mediaId: 'm3', fileName: 'invoice.pdf' },
      {
        type: 'location' as const,
        latitude: 28.6,
        longitude: 77.2,
        name: 'Shop',
        address: 'Delhi',
      },
    ]) {
      expect(buildTemplatePayload('919000000101', { ...base, header })).toMatchSnapshot(
        header.type,
      );
    }
  });

  it('refuses bad input with one error per path', () => {
    const errorsOf = (input: TemplateSendInput, to = '919000000101') => {
      try {
        buildTemplatePayload(to, input);
        return [];
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        return ((err as ValidationError).details ?? []).map((d) => d.path);
      }
    };
    expect(errorsOf(base, '+91 9000')).toEqual(['to']);
    expect(errorsOf({ ...base, name: 'Order-Update' })).toEqual(['template.name']);
    expect(errorsOf({ ...base, language: 'english' })).toEqual(['template.language']);
    expect(errorsOf({ ...base, header: { type: 'text', text: 'a\nb' } })).toEqual(['header']);
    expect(errorsOf({ ...base, header: { type: 'text', text: 'x'.repeat(61) } })).toEqual([
      'header',
    ]);
    expect(errorsOf({ ...base, header: { type: 'text', text: ' ' } })).toEqual(['header']);
    expect(errorsOf({ ...base, header: { type: 'image', mediaId: '' } })).toEqual(['header']);
    expect(
      errorsOf({ ...base, header: { type: 'location', latitude: 91, longitude: 181 } }),
    ).toEqual(['header.latitude', 'header.longitude']);
    expect(
      errorsOf({
        ...base,
        body: [
          { key: '1', text: '' },
          { key: '1', text: 'x' },
          { key: 'name', text: 'x' },
          { key: '3', text: 'x'.repeat(1025) },
        ],
      }),
    ).toEqual(['body.1', 'body.1', 'body.name', 'body.3']);
    expect(
      errorsOf({ ...base, parameterFormat: 'named', body: [{ key: '1', text: 'x' }] }),
    ).toEqual(['body.1']);
    expect(
      errorsOf({
        ...base,
        body: Array.from({ length: 21 }, (_, i) => ({ key: String(i + 1), text: 'x' })),
      }),
    ).toEqual(['body']);
    expect(
      errorsOf({
        ...base,
        buttons: [
          { subType: 'copy_code', index: 0, code: 'x'.repeat(21) },
          { subType: 'url', index: 10, text: 'ok' },
          { subType: 'quick_reply', index: 1, payload: 'a\tb' },
          { subType: 'url', index: 2, text: 'x'.repeat(2001) },
        ],
      }),
    ).toEqual(['buttons.0', 'buttons.10', 'buttons.1', 'buttons.2']);
  });
});

describe('template error mapping', () => {
  it('send errors: reasons and template / contact effects', () => {
    const cases: [number, string, string][] = [
      [132000, "Template variables don't match the template", 'none'],
      [132001, 'Template not found for this language', 'template_sync'],
      [132005, 'Text too long after filling the variables', 'none'],
      [132007, 'Template content violates WhatsApp policy', 'none'],
      [132012, "Variable format doesn't match the template", 'none'],
      [132015, 'Template is paused for low quality', 'template_paused'],
      [132016, 'Template is disabled', 'template_disabled'],
      [131049, 'WhatsApp limited marketing messages to this customer — try later', 'none'],
      [131050, 'Customer stopped marketing messages', 'marketing_stopped'],
    ];
    for (const [code, reason, effect] of cases) {
      expect(mapSendError({ code })).toMatchObject({ retryable: false, reason });
      expect(templateSendEffect(code)).toBe(effect);
    }
    expect(templateSendEffect(null)).toBe('none');
    expect(templateSendEffect(131026)).toBe('none');
  });

  it('management errors → our codes (code or subcode)', () => {
    const m = (code: number | null, subcode: number | null = null, message = 'Meta said no') =>
      mapTemplateError({ code, subcode, message });
    expect(m(100, 2388023).code).toBe('TEMPLATE_NAME_TAKEN');
    expect(m(2388024).code).toBe('TEMPLATE_NAME_TAKEN');
    expect(m(100, 2388042).code).toBe('TEMPLATE_LIMIT_REACHED');
    expect(m(100, 2388040, 'Body text too long access_token=SECRET')).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'Body text too long access_token=***',
    });
    expect(m(100, 2388047).code).toBe('VALIDATION_FAILED');
    expect(m(80008).code).toBe('RATE_LIMITED');
    expect(m(80007).code).toBe('RATE_LIMITED');
    expect(m(100, 1234)).toEqual({
      code: 'META_API_ERROR',
      message: 'Meta refused the template (code 1234)',
    });
    expect(m(null)).toEqual({ code: 'META_API_ERROR', message: 'Meta refused the template' });
  });
});
