/**
 * PIN: the Pinnacle partner API (`partnersv1.pinbot.ai/v3`) as superadmins see it for a managed
 * number — from `core/meta/pinnacle.client.ts` (what we call) and the partner's relay of Meta's
 * Graph paths. Placeholders: `{phoneNumberId}`, `{wabaId}`, `{mediaId}`, `{templateName}`.
 * Never a real id or key here. `tryIt` = a safe read our backend may run (PIN-T4).
 */
export const PARTNER_API_GROUPS = [
  'Key',
  'Callback',
  'Number',
  'Profile',
  'Messages',
  'Templates',
  'Media',
  'Register',
  'Calling',
] as const;
export type PartnerApiGroup = (typeof PARTNER_API_GROUPS)[number];

export interface PartnerEndpoint {
  id: string;
  group: PartnerApiGroup;
  method: 'GET' | 'POST' | 'DELETE';
  /** Under the base URL (or the voice URL for `host: 'voice'`), without the version. */
  path: string;
  host: 'base' | 'voice';
  summary: string;
  body?: Record<string, unknown>;
  response?: unknown;
  notes?: string;
  /** false = the partner doesn't carry it (calling). */
  supported: boolean;
  /** A safe read our backend may run for a superadmin (no write, no customer data change). */
  tryIt: boolean;
}

export const PARTNER_API_ENDPOINTS: readonly PartnerEndpoint[] = [
  {
    id: 'key.details',
    group: 'Key',
    method: 'GET',
    path: '/getuserdetails',
    host: 'base',
    summary: 'The WhatsApp accounts and numbers this API key may use (key check)',
    response: {
      data: [
        {
          whatsapp_business_account_id: '{wabaId}',
          phone_number_id: '{phoneNumberId}',
          wanumber: '91XXXXXXXXXX',
        },
      ],
    },
    supported: true,
    tryIt: true,
  },
  {
    id: 'callback.set',
    group: 'Callback',
    method: 'POST',
    path: '/{phoneNumberId}/setwebhook',
    host: 'base',
    summary: "Where the partner relays Meta's callbacks for the number (with our secret header)",
    body: {
      webhook_url: 'https://wa.notifynow.in/api/v1/webhooks/pinnacle/{channelId}',
      headers: { 'x-cell-webhook-secret': '<secret>' },
    },
    notes:
      "Changing it here breaks our webhook — use the number card's Reset webhook instead (it sets a new secret).",
    supported: true,
    tryIt: false,
  },
  {
    id: 'callback.get',
    group: 'Callback',
    method: 'GET',
    path: '/{phoneNumberId}/getwebhook',
    host: 'base',
    summary: 'The callback set for the number (a list; the `source: API` entry is ours)',
    response: [{ webhook_url: 'https://…/webhooks/pinnacle/{channelId}', source: 'API' }],
    supported: true,
    tryIt: true,
  },
  {
    id: 'number.get',
    group: 'Number',
    method: 'GET',
    path: '/business/{phoneNumberId}',
    host: 'base',
    summary: 'The number: display number, verified name, quality, messaging limit, status',
    supported: true,
    tryIt: true,
  },
  {
    id: 'number.list',
    group: 'Number',
    method: 'GET',
    path: '/business/{wabaId}/phone_numbers',
    host: 'base',
    summary: 'Numbers of the WhatsApp account',
    supported: true,
    tryIt: true,
  },
  {
    id: 'profile.get',
    group: 'Profile',
    method: 'GET',
    path: '/business/{phoneNumberId}/whatsapp_business_profile',
    host: 'base',
    summary: 'Business profile: about, address, description, email, websites, vertical',
    supported: true,
    tryIt: true,
  },
  {
    id: 'profile.update',
    group: 'Profile',
    method: 'POST',
    path: '/business/{phoneNumberId}/whatsapp_business_profile',
    host: 'base',
    summary: 'Update the business profile',
    body: { messaging_product: 'whatsapp', about: 'We are open 9–6' },
    supported: true,
    tryIt: false,
  },
  {
    id: 'messages.text',
    group: 'Messages',
    method: 'POST',
    path: '/{phoneNumberId}/messages',
    host: 'base',
    summary: 'Send a text (only inside the 24-hour window)',
    body: {
      messaging_product: 'whatsapp',
      to: '91XXXXXXXXXX',
      type: 'text',
      text: { body: 'Hello' },
    },
    response: { messages: [{ id: 'wamid.…' }] },
    notes: 'Sends from the dashboard / our API are billed and logged; a direct call is not.',
    supported: true,
    tryIt: false,
  },
  {
    id: 'messages.template',
    group: 'Messages',
    method: 'POST',
    path: '/{phoneNumberId}/messages',
    host: 'base',
    summary: 'Send an approved template',
    body: {
      messaging_product: 'whatsapp',
      to: '91XXXXXXXXXX',
      type: 'template',
      template: {
        name: '{templateName}',
        language: { code: 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }] }],
      },
    },
    supported: true,
    tryIt: false,
  },
  {
    id: 'messages.read',
    group: 'Messages',
    method: 'POST',
    path: '/{phoneNumberId}/messages',
    host: 'base',
    summary: 'Mark a customer message as read',
    body: { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.…' },
    supported: true,
    tryIt: false,
  },
  {
    id: 'templates.list',
    group: 'Templates',
    method: 'GET',
    path: '/{wabaId}/message_templates',
    host: 'base',
    summary: 'Templates of the WhatsApp account with status and category',
    supported: true,
    tryIt: true,
  },
  {
    id: 'templates.create',
    group: 'Templates',
    method: 'POST',
    path: '/{wabaId}/message_templates',
    host: 'base',
    summary: 'Create a template (Meta reviews it)',
    body: {
      name: 'payment_reminder',
      language: 'en',
      category: 'UTILITY',
      components: [
        { type: 'BODY', text: 'Hi {{1}}, your EMI is due.', example: { body_text: [['Asha']] } },
      ],
    },
    notes: 'Prefer our API (`POST /api/v1/whatsapp/templates`): it keeps our records in step.',
    supported: true,
    tryIt: false,
  },
  {
    id: 'templates.delete',
    group: 'Templates',
    method: 'DELETE',
    path: '/{wabaId}/message_templates?name={templateName}',
    host: 'base',
    summary: 'Delete a template (every language of the name)',
    supported: true,
    tryIt: false,
  },
  {
    id: 'media.upload',
    group: 'Media',
    method: 'POST',
    path: '/{phoneNumberId}/media',
    host: 'base',
    summary: 'Upload a media file to send (multipart `file`, `messaging_product=whatsapp`)',
    supported: true,
    tryIt: false,
  },
  {
    id: 'media.url',
    group: 'Media',
    method: 'GET',
    path: '/{mediaId}',
    host: 'base',
    summary: 'The download URL of a received media file',
    supported: true,
    tryIt: false,
  },
  {
    id: 'media.download',
    group: 'Media',
    method: 'GET',
    path: '/downloadMedia/{mediaId}',
    host: 'base',
    summary: 'Download a received media file through the partner',
    supported: true,
    tryIt: false,
  },
  {
    id: 'media.example',
    group: 'Media',
    method: 'POST',
    path: '/app/uploads',
    host: 'base',
    summary: 'Resumable upload session for a template header example → a handle',
    supported: true,
    tryIt: false,
  },
  {
    id: 'register',
    group: 'Register',
    method: 'POST',
    path: '/{phoneNumberId}/register',
    host: 'base',
    summary: 'Register the number on the Cloud API with a 6-digit PIN',
    body: { messaging_product: 'whatsapp', pin: '<6 digits>' },
    supported: true,
    tryIt: false,
  },
  {
    id: 'calling.calls',
    group: 'Calling',
    method: 'POST',
    path: '/{phoneNumberId}/calls',
    host: 'voice',
    summary: 'Call actions (connect, pre_accept, accept, reject, terminate)',
    notes: "The partner doesn't carry WhatsApp calling — use Calls via Meta direct on the number.",
    supported: false,
    tryIt: false,
  },
  {
    id: 'calling.settings',
    group: 'Calling',
    method: 'GET',
    path: '/{phoneNumberId}/settings',
    host: 'voice',
    summary: 'Calling settings',
    notes: "The partner doesn't carry WhatsApp calling (provider_unsupported).",
    supported: false,
    tryIt: false,
  },
  {
    id: 'calling.permissions',
    group: 'Calling',
    method: 'GET',
    path: '/{phoneNumberId}/call_permissions?user_wa_id=…',
    host: 'voice',
    summary: "A customer's call permission",
    notes: "The partner doesn't carry WhatsApp calling (provider_unsupported).",
    supported: false,
    tryIt: false,
  },
];

/** The endpoint by id (Try it only runs ids with `tryIt`). */
export const partnerEndpoint = (id: string): PartnerEndpoint | undefined =>
  PARTNER_API_ENDPOINTS.find((e) => e.id === id);

/** The path with this number's ids filled in (`{templateName}` / `{mediaId}` stay as they are). */
export const fillPartnerPath = (
  path: string,
  ids: { phoneNumberId: string; wabaId: string },
): string =>
  path.replaceAll('{phoneNumberId}', ids.phoneNumberId).replaceAll('{wabaId}', ids.wabaId);
