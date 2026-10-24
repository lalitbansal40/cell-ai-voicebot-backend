import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  accountSettingsUpdateValueSchema,
  accountUpdateValueSchema,
  buildMessagePayload,
  buildTemplatePayload,
  callDurationSec,
  callEventSchema,
  callingSettingsBody,
  callPermissionReplySchema,
  callPermissionsSchema,
  callRetryAfterSec,
  callsValueSchema,
  callStatusSchema,
  inboundMessageSchema,
  inboxMessagesValueSchema,
  isCallingRestrictionType,
  isCallingViolationType,
  mapCallError,
  phoneNumberIdOf,
  phoneSettingsSchema,
  scrubSecrets,
  startCallSchema,
  toCallingSettings,
  toCallPermission,
  WEBHOOK_FIELDS,
} from '../../src/core/meta';
import { describeSdp } from '../../src/core/telephony/whatsapp/sdp';

const raw = (name: string) => readFileSync(join(__dirname, '../fixtures/meta', name), 'utf8');
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(raw(name)) as Record<string, unknown>;
/** The first change value of a webhook fixture. */
const valueOf = (name: string): unknown =>
  (fixture(name) as { entry: { changes: { value: unknown }[] }[] }).entry[0]?.changes[0]?.value;

describe('calls webhook values', () => {
  it('business-initiated connect carries Meta’s SDP answer (ICE-lite, DTLS active)', () => {
    const v = callsValueSchema.parse(valueOf('calls-connect-bic.json'));
    expect(v.metadata.phone_number_id).toBe('106540352242922');
    const call = v.calls?.[0];
    expect(call).toMatchObject({
      event: 'connect',
      direction: 'BUSINESS_INITIATED',
      to_user_id: 'IN.1234567890123456',
      biz_opaque_callback_data: 'call_6716a0000000000000000001',
    });
    expect(call?.session?.sdp_type).toBe('answer');
    expect(describeSdp(call?.session?.sdp ?? '')).toMatchObject({ iceLite: true, setup: 'active' });
  });

  it('user-initiated connect carries the offer, BSUID and the call button payload', () => {
    const v = callsValueSchema.parse(valueOf('calls-connect-uic.json'));
    const call = v.calls?.[0];
    expect(call).toMatchObject({
      direction: 'USER_INITIATED',
      from: '919000000101',
      from_user_id: 'IN.1234567890123456',
      cta_payload: 'loan_reminder_42',
    });
    expect(call?.session?.sdp_type).toBe('offer');
    expect(describeSdp(call?.session?.sdp ?? '')).toMatchObject({
      iceLite: true,
      setup: 'actpass',
    });
    expect(v.contacts?.[0]).toMatchObject({
      wa_id: '919000000101',
      user_id: 'IN.1234567890123456',
    });
  });

  it('statuses: ringing / accepted / rejected (upper case, also from lower case)', () => {
    for (const [file, status] of [
      ['calls-status-ringing.json', 'RINGING'],
      ['calls-status-accepted.json', 'ACCEPTED'],
      ['calls-status-rejected.json', 'REJECTED'],
    ] as const) {
      const v = callsValueSchema.parse(valueOf(file));
      expect(callStatusSchema.parse(v.statuses?.[0])).toMatchObject({
        status,
        type: 'call',
        recipient_id: '919000000101',
      });
    }
    expect(callStatusSchema.parse({ id: 'wacid.X', type: 'call', status: 'ringing' }).status).toBe(
      'RINGING',
    );
    expect(() => callStatusSchema.parse({ id: 'wacid.X', type: 'call', status: 'BUSY' })).toThrow();
  });

  it('terminate: duration, times and value-level errors', () => {
    const done = callsValueSchema.parse(valueOf('calls-terminate-completed.json'));
    const ev = done.calls?.[0];
    expect(ev?.status).toBe('COMPLETED');
    expect(ev && callDurationSec(ev)).toBe(90);
    const failed = callsValueSchema.parse(valueOf('calls-terminate-failed.json'));
    expect(failed.calls?.[0]?.status).toBe('FAILED');
    expect(failed.errors?.[0]?.code).toBe(138004);
    expect(failed.calls?.[0] && callDurationSec(failed.calls[0])).toBeNull();
    // no duration field: end − start
    expect(
      callDurationSec(
        callEventSchema.parse({
          id: 'wacid.X',
          event: 'terminate',
          start_time: '1761300000',
          end_time: '1761300042',
        }),
      ),
    ).toBe(42);
    expect(
      callDurationSec(callEventSchema.parse({ id: 'wacid.X', event: 'terminate', duration: '7' })),
    ).toBe(7);
  });

  it('refuses SDP larger than 16 KB', () => {
    expect(() =>
      callEventSchema.parse({
        id: 'wacid.X',
        event: 'connect',
        session: { sdp_type: 'offer', sdp: 'a'.repeat(16_385) },
      }),
    ).toThrow();
  });
});

describe('call permission replies', () => {
  it('parse in the messages webhook (temporary, permanent, reject, automatic)', () => {
    const cases = [
      ['call-permission-reply-temporary.json', 'accept', false, 'user_action'],
      ['call-permission-reply-permanent.json', 'accept', true, 'user_action'],
      ['call-permission-reply-reject.json', 'reject', false, 'user_action'],
      ['call-permission-reply-automatic.json', 'accept', false, 'automatic'],
    ] as const;
    for (const [file, response, permanent, source] of cases) {
      const v = inboxMessagesValueSchema.parse(valueOf(file));
      const m = inboundMessageSchema.parse(v.messages?.[0]);
      expect(m?.from_user_id).toBe('IN.1234567890123456');
      expect(m?.context?.id).toBeTruthy();
      const reply = callPermissionReplySchema.parse(m?.interactive?.call_permission_reply);
      expect(reply).toMatchObject({
        response,
        is_permanent: permanent,
        response_source: source,
      });
      expect(Boolean(reply.expiration_timestamp)).toBe(!permanent && response === 'accept');
    }
  });
});

describe('settings, account updates and routing', () => {
  it('account_settings_update → calling block; routed by phone_number_settings', () => {
    const value = valueOf('account-settings-update.json');
    const v = accountSettingsUpdateValueSchema.parse(value);
    expect(phoneNumberIdOf(value)).toBe('106540352242922');
    expect(toCallingSettings(v.phone_number_settings.calling)).toEqual({
      status: 'ENABLED',
      callIconVisibility: 'DEFAULT',
      iconCountries: ['IN'],
      callHours: {
        status: 'ENABLED',
        timezoneId: 'Asia/Kolkata',
        weekly: [
          { day: 'MONDAY', open: '0900', close: '1300' },
          { day: 'MONDAY', open: '1400', close: '1800' },
          { day: 'SATURDAY', open: '1000', close: '1400' },
        ],
        holidays: [{ date: '2026-12-25', start: '0000', end: '2359' }],
      },
      callbackPermissionStatus: 'ENABLED',
      sipStatus: 'DISABLED',
      restrictions: [],
    });
    // lower-case enums are tolerated
    expect(
      toCallingSettings(
        accountSettingsUpdateValueSchema.parse({
          phone_number_settings: { phone_number_id: 1, calling: { status: 'enabled' } },
        }).phone_number_settings.calling,
      ).status,
    ).toBe('ENABLED');
    expect(toCallingSettings(null)).toMatchObject({ status: null, restrictions: [] });
    expect(WEBHOOK_FIELDS).toContain('account_settings_update');
  });

  it('calling account_update events are recognised', () => {
    const r = accountUpdateValueSchema.parse(valueOf('account-update-calling-restriction.json'));
    expect(r.event).toBe('ACCOUNT_RESTRICTION');
    expect(isCallingRestrictionType(r.restriction_info?.[0]?.restriction_type)).toBe(true);
    const w = accountUpdateValueSchema.parse(valueOf('account-update-calling-violation.json'));
    expect(isCallingViolationType(w.violation_info?.violation_type)).toBe(true);
    expect(isCallingRestrictionType('RESTRICTED_ADD_PHONE_NUMBER_ACTION')).toBe(false);
    expect(isCallingViolationType(null)).toBe(false);
  });

  it('Graph answers: settings with restrictions, permissions with limits, connect', () => {
    const s = toCallingSettings(
      phoneSettingsSchema.parse(fixture('graph-phone-settings.json')).calling,
    );
    expect(s.restrictions).toEqual([
      {
        type: 'RESTRICTED_BUSINESS_INITIATED_CALLING',
        reason: 'Paused after negative feedback',
        expiresAt: new Date(1761905000 * 1000),
      },
    ]);
    // the field table's spelling (restriction_list) is read too
    expect(
      toCallingSettings(
        phoneSettingsSchema.parse({
          calling: { restrictions: { restriction_list: [{ type: 'X' }, { reason: 'no type' }] } },
        }).calling,
      ).restrictions,
    ).toEqual([{ type: 'X', reason: null, expiresAt: null }]);
    const p = toCallPermission(callPermissionsSchema.parse(fixture('graph-call-permissions.json')));
    expect(p.status).toBe('temporary');
    expect(p.expiresAt).toEqual(new Date(1761905000 * 1000));
    expect(p.actions.map((a) => [a.action, a.canPerform])).toEqual([
      ['send_call_permission_request', true],
      ['start_call', false],
    ]);
    expect(p.actions[1]?.limits[0]).toEqual({
      timePeriod: 'PT24H',
      maxAllowed: 100,
      currentUsage: 100,
      limitExpiresAt: new Date(1761386400 * 1000),
    });
    expect(
      toCallPermission(callPermissionsSchema.parse({ permission: { status: 'permanent' } })),
    ).toEqual({ status: 'permanent', expiresAt: null, actions: [] });
    expect(startCallSchema.parse(fixture('graph-call-connect.json')).calls[0]?.id).toMatch(
      /^wacid\./,
    );
  });

  it('settings body: only the given fields; holidays always sent with the hours', () => {
    expect(callingSettingsBody({})).toEqual({});
    expect(
      callingSettingsBody({
        status: 'ENABLED',
        callIconVisibility: 'DISABLE_ALL',
        iconCountries: [],
        callbackPermissionStatus: 'DISABLED',
        callHours: {
          status: 'ENABLED',
          timezoneId: 'Asia/Kolkata',
          weekly: [{ day: 'MONDAY', open: '0900', close: '1800' }],
          holidays: [],
        },
      }),
    ).toEqual({
      status: 'ENABLED',
      call_icon_visibility: 'DISABLE_ALL',
      call_icons: { restrict_to_user_countries: [] },
      callback_permission_status: 'DISABLED',
      call_hours: {
        status: 'ENABLED',
        timezone_id: 'Asia/Kolkata',
        weekly_operating_hours: [{ day_of_week: 'MONDAY', open_time: '0900', close_time: '1800' }],
        holiday_schedule: [],
      },
    });
  });
});

describe('mapCallError', () => {
  const e = (code: number | null) => ({
    code,
    subcode: null,
    status: 400,
    retryable: false,
    tokenInvalid: false,
  });

  it('maps every documented code to our error', () => {
    const table: [number, string][] = [
      [138000, 'WHATSAPP_CALLING_DISABLED'],
      [138001, 'WHATSAPP_CALL_FAILED'],
      [138002, 'RATE_LIMITED'],
      [138005, 'RATE_LIMITED'],
      [138003, 'WHATSAPP_CALL_ACTIVE'],
      [138004, 'WHATSAPP_CALL_FAILED'],
      [138007, 'WHATSAPP_CALL_FAILED'],
      [138019, 'WHATSAPP_CALL_FAILED'],
      [138023, 'WHATSAPP_CALL_FAILED'],
      [138006, 'WHATSAPP_CALL_PERMISSION_MISSING'],
      [138009, 'WHATSAPP_CALL_PERMISSION_LIMIT'],
      [138012, 'WHATSAPP_CALL_LIMIT_REACHED'],
      [138013, 'WHATSAPP_CALLING_UNAVAILABLE'],
      [138015, 'WHATSAPP_CALLING_UNAVAILABLE'],
      [138018, 'WHATSAPP_CALLING_UNAVAILABLE'],
      [138014, 'WHATSAPP_CALLING_RESTRICTED'],
      [138017, 'WHATSAPP_CALL_PERMISSION_EXISTS'],
      [131030, 'WHATSAPP_CALL_FAILED'],
      [131044, 'WHATSAPP_CALL_FAILED'],
      [131055, 'WHATSAPP_CALLING_UNAVAILABLE'],
      [613, 'WHATSAPP_CALL_PERMISSION_CHECK_FAILED'],
      [1, 'META_API_ERROR'],
    ];
    for (const [code, ours] of table) expect(mapCallError(e(code)).code).toBe(ours);
    expect(mapCallError(e(null)).code).toBe('META_API_ERROR');
    expect(mapCallError(e(138001)).reason).toBe("The customer can't take WhatsApp calls");
    expect(mapCallError(e(131030)).reason).toBe('Test number not on the allowed list');
    expect(mapCallError(e(131044)).reason).toBe('Payment method missing at Meta');
    expect(mapCallError(e(131055)).reason).toBe('SIP is enabled on this number');
    expect(mapCallError(e(613)).retryOnce).toBe(true);
    expect(mapCallError(e(138006)).retryOnce).toBe(false);
  });

  it('wait hints: seconds or a unix time; only for rate / call limits', () => {
    const now = Date.UTC(2026, 9, 24);
    expect(callRetryAfterSec(30)).toBe(30);
    expect(callRetryAfterSec('2.5')).toBe(3);
    expect(callRetryAfterSec(now / 1000 + 600, now)).toBe(600);
    expect(callRetryAfterSec(now / 1000 - 10, now)).toBe(0);
    for (const bad of [null, undefined, '', 'soon', 0, -5])
      expect(callRetryAfterSec(bad)).toBeNull();
    expect(mapCallError(e(138002), 12).retryAfterSec).toBe(12);
    expect(mapCallError(e(138006), 12).retryAfterSec).toBeNull();
  });

  it('scrubs SDP, ICE credentials and candidates out of Meta messages', () => {
    const sdp = raw('calls-sdp-answer.txt');
    const out = scrubSecrets(`Invalid offer: ${sdp}`);
    expect(out).toBe('Invalid offer: <sdp>');
    const line = scrubSecrets(
      'bad a=candidate:1 1 udp 2122260223 203.0.113.10 3480 typ host\na=ice-pwd:testpassword\na=fingerprint:sha-256 00:11:22',
    );
    for (const bit of ['testpassword', '203.0.113.10', '3480', '00:11:22']) {
      expect(line).not.toContain(bit);
    }
    expect(line).toBe('bad <sdp>\n<sdp>\n<sdp>');
  });
});

describe('calling payload builders', () => {
  it('call permission request (body optional, ≤ 1,024)', () => {
    expect(
      buildMessagePayload('919000000101', { type: 'call_permission_request', body: 'Call?' }),
    ).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919000000101',
      type: 'interactive',
      interactive: {
        type: 'call_permission_request',
        action: { name: 'call_permission_request' },
        body: { text: 'Call?' },
      },
    });
    expect(
      (
        buildMessagePayload('919000000101', { type: 'call_permission_request' })
          .interactive as Record<string, unknown>
      ).body,
    ).toBeUndefined();
    expect(() =>
      buildMessagePayload('919000000101', {
        type: 'call_permission_request',
        body: 'x'.repeat(1_025),
      }),
    ).toThrow();
  });

  it('voice call button (display text ≤ 20, TTL 1–43,200, payload ≤ 512)', () => {
    expect(
      buildMessagePayload('919000000101', {
        type: 'voice_call',
        body: 'Talk to us',
        displayText: 'Call now',
        ttlMinutes: 100,
        payload: 'loan_42',
      }).interactive,
    ).toEqual({
      type: 'voice_call',
      body: { text: 'Talk to us' },
      action: {
        name: 'voice_call',
        parameters: { display_text: 'Call now', ttl_minutes: 100, payload: 'loan_42' },
      },
    });
    expect(
      (
        buildMessagePayload('919000000101', { type: 'voice_call', body: 'Hi' }).interactive as {
          action: unknown;
        }
      ).action,
    ).toEqual({ name: 'voice_call', parameters: {} });
    for (const bad of [
      { displayText: 'x'.repeat(21) },
      { ttlMinutes: 0 },
      { ttlMinutes: 43_201 },
      { ttlMinutes: 1.5 },
      { payload: 'x'.repeat(513) },
    ]) {
      expect(() =>
        buildMessagePayload('919000000101', { type: 'voice_call', body: 'Hi', ...bad }),
      ).toThrow();
    }
    expect(() => buildMessagePayload('919000000101', { type: 'voice_call', body: '' })).toThrow();
  });

  it('template voice_call button: no index, TTL / payload parameters, nothing when empty', () => {
    const base = { name: 'call_us', language: 'en', parameterFormat: 'positional' as const };
    const p = buildTemplatePayload('919000000101', {
      ...base,
      buttons: [
        { subType: 'quick_reply', index: 1, payload: 'yes' },
        { subType: 'voice_call', ttlMinutes: 1440, payload: 'loan_42' },
      ],
    });
    expect((p.template as { components: unknown[] }).components).toEqual([
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '1',
        parameters: [{ type: 'payload', payload: 'yes' }],
      },
      {
        type: 'button',
        sub_type: 'voice_call',
        parameters: [
          { type: 'ttl_minutes', ttl_minutes: 1440 },
          { type: 'payload', payload: 'loan_42' },
        ],
      },
    ]);
    const empty = buildTemplatePayload('919000000101', {
      ...base,
      buttons: [{ subType: 'voice_call' }],
    });
    expect(empty.template).not.toHaveProperty('components');
    for (const bad of [{ ttlMinutes: 0 }, { ttlMinutes: 50_000 }, { payload: 'x'.repeat(513) }]) {
      expect(() =>
        buildTemplatePayload('919000000101', {
          ...base,
          buttons: [{ subType: 'voice_call', ...bad }],
        }),
      ).toThrow();
    }
  });
});
