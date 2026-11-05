import { SAMPLE } from './sample';

/**
 * Public API docs of the routes registered before DOCS-T4 (one place, PUBLIC_API_DOCS_PROMPT
 * L5): id, area tag, key scope, a Markdown description and the request example. Routes that
 * call `publicOp()` themselves (resources, WhatsApp bulk campaigns) are not listed here.
 */

export interface PublicOpDocs {
  operationId: string;
  area: string;
  scope: string | null;
  description: string;
  request?: unknown;
  /** Named request examples (OpenAPI `examples`) when one body has several shapes. */
  requestExamples?: Record<string, { summary: string; value: unknown }>;
  /** Extra error answers this route really gives (e.g. `503` when busy or a provider is down). */
  errors?: string[];
}

const ID = SAMPLE.id;
const WRITE = 'Write limit class (60 / min per key).';
const READ = 'Read limit class (600 / min per key).';
const CURSOR =
  'Cursor pagination: pass `meta.nextCursor` back as `cursor` until `hasMore` is false.';
const IDEM =
  '`Idempotency-Key` header required: a retry with the same key returns the first answer and never repeats the action.';
const REPORT = (tab: string) =>
  `Numbers of the **${tab}** tab for a date range in the account timezone (\`from\` / \`to\`, at most 366 days; \`compare=true\` adds the previous period). Answers are cached for 60 s and carry an \`ETag\` (send \`If-None-Match\` for a \`304\`). \`422 REPORT_RANGE_INVALID\` for a bad range. ${READ}`;

export const PUBLIC_DOCS: Record<string, PublicOpDocs> = {
  'GET /api/v1/api-keys/whoami': {
    operationId: 'whoAmI',
    area: 'Getting started',
    scope: null,
    description: `Checks an API key: answers the account id, the key id and its scopes. Any valid key works (no scope needed) — use it as the first call after creating a key. \`401\` = missing, wrong, expired or revoked key (revocation takes effect within 30 s). ${READ}`,
  },
  'GET /api/v1/contacts': {
    operationId: 'listContacts',
    area: 'Contacts',
    scope: 'contacts:read',
    description: `Contacts of the account with search (\`q\` on name / phone / email / external id), list / tag / field filters and sort. Phones are E.164. Sensitive fields come masked. Offset pagination (\`page\`, \`limit\` ≤ 100). ${READ}`,
  },
  'POST /api/v1/contacts': {
    operationId: 'createContact',
    area: 'Contacts',
    scope: 'contacts:write',
    description: `Creates one contact. \`phone\` is normalised to E.164 (Indian 10-digit numbers get \`+91\`). A live contact with the same phone or \`externalId\` answers \`409 CONFLICT_DUPLICATE\` with the existing id in \`details\` — or use \`POST /contacts?upsert=phone\` to update it instead. \`variables\` are custom field values by key. ${WRITE}`,
    request: {
      phone: SAMPLE.phone,
      name: SAMPLE.name,
      email: SAMPLE.email,
      externalId: 'CRM-1001',
      variables: { loan_id: 'LN-1001', amount_due: 2_500_000_000 },
      tags: ['november-dues'],
      listIds: [ID],
      consent: { source: 'website_form', at: SAMPLE.at },
    },
  },
  'GET /api/v1/contacts/{id}': {
    operationId: 'getContact',
    area: 'Contacts',
    scope: 'contacts:read',
    description: `One contact with its fields, tags, list names, opt-out / DND state and last call / message times. Another account's id answers \`404\`. ${READ}`,
  },
  'PATCH /api/v1/contacts/{id}': {
    operationId: 'updateContact',
    area: 'Contacts',
    scope: 'contacts:write',
    description: `Changes the fields sent. \`variables\` merge (a \`null\` value clears that field); \`tags\` and \`listIds\` replace the whole set. Changing \`phone\` to another live contact's number answers \`409\`. The API can never clear an opt-out or a do-not-call entry. ${WRITE}`,
    request: { name: 'Asha V.', variables: { amount_due: 1_250_000_000, promise_date: null } },
  },
  'POST /api/v1/contacts/bulk-upsert': {
    operationId: 'bulkUpsertContacts',
    area: 'Contacts',
    scope: 'contacts:write',
    description: `Creates or updates up to 1,000 contacts in one request, matched by \`phone\` (default) or \`externalId\`. Rows are processed one by one: the answer has a result per row (\`created\` / \`updated\` / \`failed\` with the reason) and the counts — one bad row never fails the others. ${WRITE}`,
    request: {
      upsert: 'phone',
      rows: [
        { phone: SAMPLE.phone, name: SAMPLE.name, variables: { amount_due: 2_500_000_000 } },
        { phone: '+919000000002', name: 'Ravi Kumar', tags: ['november-dues'] },
      ],
    },
  },
  'GET /api/v1/calls': {
    operationId: 'listCalls',
    area: 'Calls',
    scope: 'calls:read',
    description: `Calls of the account, newest first: phone (SIP / test line), WhatsApp and recorded-voice calls. Filters: status, provider, direction, mode, campaign, flow, agent, contact, disposition, sentiment, date range. Phones are masked to the last 4 digits. ${CURSOR} ${READ}`,
  },
  'POST /api/v1/calls': {
    errors: ['503'],
    operationId: 'startCall',
    area: 'Calls',
    scope: 'calls:write',
    description: `Calls one contact now on the account's phone line with a published flow (\`flowId\`, optional \`version\`) **or** an active AI agent (\`agentId\`) — ids from \`GET /resources/flows\` / \`/resources/agents\`. On the test line the call is simulated and never charged. \`variables\` seed flow variables / allowed agent values; \`externalRef\` comes back in webhooks. Checks: calling window, DND / opt-out, call caps, wallet (\`WALLET_INSUFFICIENT_BALANCE\`), concurrency (\`CALL_LIMIT_REACHED\`), \`NUMBER_NOT_ALLOWED\`. ${IDEM} ${WRITE}`,
    request: {
      contactId: ID,
      flowId: '6720f0a1b2c3d4e5f6a7b8ca',
      externalRef: 'loan-1001',
      variables: { due_date: '10 Nov' },
    },
  },
  'GET /api/v1/calls/{id}': {
    operationId: 'getCall',
    area: 'Calls',
    scope: 'calls:read',
    description: `One call: status, end reason, duration, disposition and outcome values, cost breakdown in micros, recording availability and metrics. Recorded-voice calls (\`provider: voice_api\`) carry the provider status, duration and key pressed in \`outcome.voiceApi\`. ${READ}`,
  },
  'GET /api/v1/calls/{id}/transcript': {
    operationId: 'getCallTranscript',
    area: 'Calls',
    scope: 'calls:read',
    description: `Final transcript turns of a call (customer / bot / agent, text, start / end ms, interrupted), up to 2,000 turns. Empty for calls without speech (recorded voice, unanswered). ${READ}`,
  },
  'GET /api/v1/calls/{id}/insights': {
    operationId: 'getCallInsights',
    area: 'Calls',
    scope: 'calls:read',
    description: `Post-call AI insights: summary, sentiment, disposition suggestion, promise to pay (date, amount in micros) and key facts — the latest version plus earlier ones. \`status\` is \`pending\`, \`done\`, \`skipped\` (with the reason, e.g. \`too_short\`, \`voice_api\`) or \`failed\`. The \`call.insights.ready\` webhook says when it is ready. ${READ}`,
  },
  'GET /api/v1/calls/{id}/after-call': {
    operationId: 'getCallAfterCallMessages',
    area: 'Calls',
    scope: 'calls:read',
    description: `WhatsApp templates sent after this call by after-call rules or the flow's Send WhatsApp steps: \`sent\`, \`scheduled\` (with the time) or \`skipped\` with the exact reason (no WhatsApp number, outside window, opted out…). ${READ}`,
  },
  'POST /api/v1/messages/template': {
    errors: ['503'],
    operationId: 'sendTemplateMessage',
    area: 'WhatsApp messages',
    scope: 'messages:write',
    description: `Sends an **approved** template (\`GET /whatsapp/templates\`) to a contact (\`contactId\`) or a phone (\`to\`, a contact is created if needed) from \`channelId\` (default: the account's first connected number). Works outside the 24-hour window. \`variables\` fill \`{{1}}\`, \`{{2}}\`… (or named ones); \`header\` carries an uploaded media token or a location. The price (template category × destination) is held and charged when Meta bills it. Errors: \`TEMPLATE_NOT_APPROVED\`, \`TEMPLATE_VARIABLES_MISSING\`, \`CONTACT_OPTED_OUT\`, \`WALLET_INSUFFICIENT_BALANCE\`. ${IDEM} ${WRITE}`,
    request: {
      to: SAMPLE.phone,
      channelId: ID,
      template: { name: 'emi_reminder', language: 'en' },
      variables: { '1': 'Asha', '2': '₹2,500' },
      externalRef: 'CRM-1001-reminder',
    },
  },
  'POST /api/v1/messages/text': {
    errors: ['503'],
    operationId: 'sendTextMessage',
    area: 'WhatsApp messages',
    scope: 'messages:write',
    description: `Sends free text (≤ 4,096 characters) — only inside the 24-hour window after the customer's last message; otherwise \`409 WHATSAPP_WINDOW_CLOSED\` (send a template instead). Same \`to\` / \`contactId\` / \`channelId\` rules as templates. ${IDEM} ${WRITE}`,
    request: {
      contactId: ID,
      text: 'Thanks Asha, we received your payment.',
      externalRef: 'CRM-1001-thanks',
    },
  },
  'GET /api/v1/messages/{id}': {
    operationId: 'getMessage',
    area: 'WhatsApp messages',
    scope: 'messages:read',
    description: `One message sent by the API: status history (queued → sent → delivered → read, or failed with Meta's error code), the charge in micros and your \`externalRef\`. Only messages created through the API are readable with a key. ${READ}`,
  },
  'GET /api/v1/whatsapp/templates': {
    operationId: 'listTemplates',
    area: 'WhatsApp templates',
    scope: 'templates:read',
    description: `Templates of the account with status (\`APPROVED\`, \`PENDING\`, \`REJECTED\`…), category, language, the WhatsApp number(s) that can send them (\`channelId\` filter) and the variables they need. List rows carry no bodies. Only \`APPROVED\` templates can be sent. ${READ}`,
  },
  'POST /api/v1/whatsapp/calls': {
    errors: ['503'],
    operationId: 'startWhatsAppCall',
    area: 'WhatsApp calls',
    scope: 'whatsapp-calls:write',
    description: `Places a WhatsApp call from a calling-ready number (\`GET /resources/whatsapp-numbers\`, \`calling.ready\`) to a contact who allowed calls from that number. \`mode: ai\` runs a published flow or an active agent (\`program\`); \`mode: human\` needs a signed-in team member (not possible with a key). Errors: \`WHATSAPP_CALL_PERMISSION_MISSING\`, \`WHATSAPP_CALLING_DISABLED\`, \`WALLET_INSUFFICIENT_BALANCE\`. 10 / min. ${IDEM}`,
    request: {
      channelId: ID,
      contactId: '6720f0a1b2c3d4e5f6a7b8ca',
      mode: 'ai',
      program: { kind: 'agent', id: '6720f0a1b2c3d4e5f6a7b8cb' },
    },
  },
  'GET /api/v1/whatsapp/channels/{id}/calling/quote': {
    operationId: 'quoteWhatsAppCall',
    area: 'WhatsApp calls',
    scope: 'calls:write',
    description: `Selling price per minute of a WhatsApp call from this number to \`contactId\` (destination market and the account's rates; never provider costs). Use it before \`POST /whatsapp/calls\` to show the cost. ${READ}`,
  },
  'GET /api/v1/campaigns': {
    operationId: 'listCampaigns',
    area: 'Campaigns',
    scope: 'campaigns:read',
    description: `Call campaigns with live stats: \`line=phone\` lists SIP / test-line and recorded-voice campaigns, \`line=whatsapp\` WhatsApp call campaigns, \`line=voice_api\` only recorded voice. Filters: status, mode, flow, recurring parent, contact, name search. ${CURSOR} ${READ}`,
  },
  'POST /api/v1/campaigns': {
    operationId: 'createCampaign',
    area: 'Campaigns',
    scope: 'campaigns:write',
    description: `Creates a draft call campaign. Three lines:\n\n- \`line: phone\` — a published flow (\`flowId\`) or agent, on the SIP line (\`mode: live\`) or the test line (\`mode: dry_run\`, simulated, never charged).\n- \`line: whatsapp\` — WhatsApp calls from \`channelId\` with \`program\` (flow or agent); only people who allowed calls are called (\`askPermissionFirst\` sends the permission template first).\n- \`line: voice_api\` — recorded audio or an IVR played by the provider (\`voiceApi.content\`), always live, 10-digit Indian mobiles only, charged per number per started 15 s when each batch is sent.\n\nAudience: lists, segment, filter or contact ids; calling window, retries, pacing and schedule (recurring allowed). Nothing dials until \`start\`. Errors: \`VOICE_API_NOT_ENABLED\`, \`VALIDATION_FAILED\` with field paths. ${WRITE}`,
    request: {
      name: 'November EMI calls',
      mode: 'live',
      line: 'phone',
      flowId: ID,
      audience: { listIds: ['6720f0a1b2c3d4e5f6a7b8ca'], excludeActiveCampaigns: true },
      window: { start: '10:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] },
      retry: { maxAttempts: 3, intervalMinutes: 60, retryOn: ['no_answer', 'busy'] },
      schedule: { startAt: '2026-11-06T04:30:00.000Z', timezone: 'Asia/Kolkata' },
    },
    requestExamples: {
      phoneFlow: {
        summary: 'Phone calls with a published flow (SIP line)',
        value: {
          name: 'November EMI calls',
          mode: 'live',
          line: 'phone',
          flowId: ID,
          audience: { listIds: ['6720f0a1b2c3d4e5f6a7b8ca'] },
          window: { start: '10:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] },
          retry: { maxAttempts: 3, intervalMinutes: 60, retryOn: ['no_answer', 'busy'] },
        },
      },
      whatsappAgent: {
        summary: 'WhatsApp calls with an AI agent',
        value: {
          name: 'WhatsApp follow-up',
          mode: 'live',
          line: 'whatsapp',
          channelId: '6720f0a1b2c3d4e5f6a7b8d1',
          program: { kind: 'agent', id: '6720f0a1b2c3d4e5f6a7b8cb' },
          askPermissionFirst: { templateId: '6720f0a1b2c3d4e5f6a7b8d2' },
          audience: { segmentId: '6720f0a1b2c3d4e5f6a7b8cc' },
        },
      },
      recordedVoice: {
        summary: 'Recorded voice / IVR (Cell24x7)',
        value: {
          name: 'Payment reminder (voice)',
          line: 'voice_api',
          voiceApi: {
            content: { kind: 'audio', flowAudioId: '6720f0a1b2c3d4e5f6a7b8cd' },
            retries: 1,
            retryIntervalMin: 30,
          },
          audience: { listIds: ['6720f0a1b2c3d4e5f6a7b8ca'] },
          window: { start: '10:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] },
        },
      },
    },
  },
  'GET /api/v1/campaigns/{id}': {
    operationId: 'getCampaign',
    area: 'Campaigns',
    scope: 'campaigns:read',
    description: `One campaign: settings, status / pause reason, live stats (pending, calling, completed, failed, answered, dispositions, skipped by reason, spend in micros), the last estimate, \`waitingUntil\` when outside the window, and for recorded voice the batches sent to the provider. ${READ}`,
  },
  'POST /api/v1/campaigns/{id}/estimate': {
    operationId: 'estimateCampaign',
    area: 'Campaigns',
    scope: 'campaigns:read',
    description: `Cost estimate of a draft for its current settings, next to the wallet's available money. Phone / WhatsApp calls: contacts × expected attempts × an average call (range \`minMicros\`–\`maxMicros\`). Recorded voice: eligible numbers × 15 s pulses × price (\`voice\`: pulses, price per number, \`notPriced\`, numbers skipped as not Indian mobiles, ETA). Nothing is charged. ${READ}`,
  },
  'POST /api/v1/campaigns/{id}/start': {
    operationId: 'startCampaign',
    area: 'Campaigns',
    scope: 'campaigns:write',
    description: `Starts now (or schedules when \`schedule.startAt\` is in the future / recurring): pins the flow version, snapshots the audience (skips DND, opted out, invalid, duplicates, other active campaigns) and begins dialing in the window. Errors: \`409 CAMPAIGN_NOT_RUNNABLE\` (details say why), \`429 CAMPAIGN_LIMIT_REACHED\`, \`VOICE_API_NOT_PRICED\`, \`WALLET_INSUFFICIENT_BALANCE\`. ${IDEM}`,
  },
  'POST /api/v1/campaigns/{id}/pause': {
    operationId: 'pauseCampaign',
    area: 'Campaigns',
    scope: 'campaigns:write',
    description: `Pauses dialing; calls in progress finish. Recorded voice: numbers already sent to the provider keep ringing, the next batch waits. \`409\` when not running or scheduled. ${WRITE}`,
  },
  'POST /api/v1/campaigns/{id}/resume': {
    operationId: 'resumeCampaign',
    area: 'Campaigns',
    scope: 'campaigns:write',
    description: `Resumes a paused campaign. Refused (\`409\`, the message says why) while the cause holds: empty wallet, flow not runnable, recorded-voice batch being checked, or a pause by the platform team. ${WRITE}`,
  },
  'POST /api/v1/campaigns/{id}/cancel': {
    operationId: 'cancelCampaign',
    area: 'Campaigns',
    scope: 'campaigns:write',
    description: `Cancels for good: waiting contacts become \`canceled\`. \`hangUpLive: true\` also ends the calls in progress (not possible for recorded voice already sent to the provider). Cannot be undone. ${WRITE}`,
    request: { hangUpLive: false },
  },
  'GET /api/v1/campaigns/{id}/contacts': {
    operationId: 'listCampaignContacts',
    area: 'Campaigns',
    scope: 'campaigns:read',
    description: `Per-contact results: status, attempts, last result, disposition, promise to pay, callback, skip / wait reason, cost; recorded voice adds the provider status, duration and key pressed (\`voice\`). Phones are the last 4 digits only. Filters: status, lastResult, disposition, skipReason, name. ${CURSOR} ${READ}`,
  },
  'GET /api/v1/campaigns/{id}/runs': {
    operationId: 'listCampaignRuns',
    area: 'Campaigns',
    scope: 'campaigns:read',
    description: `Runs of a recurring campaign (one child campaign per occurrence), newest first, with their stats. Empty for a one-time campaign. ${READ}`,
  },
  'GET /api/v1/reports/overview': {
    operationId: 'getOverviewReport',
    area: 'Reports',
    scope: 'reports:read',
    description: REPORT('overview'),
  },
  'GET /api/v1/reports/calls': {
    operationId: 'getCallsReport',
    area: 'Reports',
    scope: 'reports:read',
    description: REPORT('calls'),
  },
  'GET /api/v1/reports/whatsapp': {
    operationId: 'getWhatsAppReport',
    area: 'Reports',
    scope: 'reports:read',
    description: REPORT('WhatsApp'),
  },
  'GET /api/v1/reports/templates': {
    operationId: 'getTemplatesReport',
    area: 'Reports',
    scope: 'reports:read',
    description: REPORT('templates'),
  },
  'GET /api/v1/reports/campaigns': {
    operationId: 'getCampaignsReport',
    area: 'Reports',
    scope: 'reports:read',
    description: REPORT('campaigns'),
  },
  'GET /api/v1/reports/flows': {
    operationId: 'getFlowsReport',
    area: 'Reports',
    scope: 'reports:read',
    description: REPORT('flows'),
  },
  'GET /api/v1/reports/agents': {
    operationId: 'getAgentsReport',
    area: 'Reports',
    scope: 'reports:read',
    description: REPORT('AI agents'),
  },
  'GET /api/v1/reports/team': {
    operationId: 'getTeamReport',
    area: 'Reports',
    scope: 'reports:read',
    description: REPORT('team'),
  },
  'POST /api/v1/exports/calls': {
    operationId: 'exportCalls',
    area: 'Exports',
    scope: 'exports:write',
    description: `Starts a CSV / XLSX export of calls (same filters as \`GET /calls\`, at most 200,000 rows). Answers the export job; poll \`GET /exports/{id}\` until \`ready\`, then download from its 15-minute link. Keys always get masked phones (\`includePhone\` needs a person with \`contacts.export\`). One export at a time per account. ${WRITE}`,
    request: {
      format: 'csv',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-05T23:59:59.000Z',
      status: ['completed'],
    },
  },
  'POST /api/v1/exports/messages': {
    operationId: 'exportMessages',
    area: 'Exports',
    scope: 'exports:write',
    description: `Starts an export of WhatsApp message metadata (status, template, category, charge — never the message text) for a date range, optionally one number or direction. Poll \`GET /exports/{id}\`. ${WRITE}`,
    request: {
      format: 'xlsx',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-05T23:59:59.000Z',
      direction: 'out',
    },
  },
  'POST /api/v1/exports/report': {
    operationId: 'exportReport',
    area: 'Exports',
    scope: 'exports:write',
    description: `Exports the numbers of one report tab with the same \`query\` as \`GET /reports/{tab}\`. Poll \`GET /exports/{id}\`. ${WRITE}`,
    request: { format: 'csv', tab: 'campaigns', query: { from: '2026-11-01', to: '2026-11-05' } },
  },
  'GET /api/v1/exports/{id}': {
    operationId: 'getExport',
    area: 'Exports',
    scope: 'exports:write',
    description: `An export job: \`queued\` → \`running\` → \`ready\` (with a download URL valid 15 minutes — fetch this again for a fresh link) or \`failed\`. ${READ}`,
  },
  'GET /api/v1/webhook-endpoints': {
    operationId: 'listWebhookEndpoints',
    area: 'Webhooks',
    scope: 'webhooks:manage',
    description: `Webhook endpoints of the account (at most 10): URL, events, personal-data flag, active / disabled state with the failure streak, last delivery. Secrets are never shown again after creation / rotation. ${READ}`,
  },
  'POST /api/v1/webhook-endpoints': {
    operationId: 'createWebhookEndpoint',
    area: 'Webhooks',
    scope: 'webhooks:manage',
    description: `Adds an endpoint for the chosen events (or \`*\`). The answer shows the signing secret (\`whsec_…\`) **once** — store it to verify \`X-Webhook-Signature\`. HTTPS only in production; private / local addresses answer \`422 WEBHOOK_URL_BLOCKED\`. \`includePersonalData\` adds phone, name, summary and message text to payloads. ${WRITE}`,
    request: {
      url: SAMPLE.url,
      description: 'CRM sync',
      events: ['call.completed', 'whatsapp.message.status'],
      includePersonalData: false,
    },
  },
  'GET /api/v1/webhook-endpoints/{id}': {
    operationId: 'getWebhookEndpoint',
    area: 'Webhooks',
    scope: 'webhooks:manage',
    description: `One endpoint with its events, state and the last delivery result. ${READ}`,
  },
  'PATCH /api/v1/webhook-endpoints/{id}': {
    operationId: 'updateWebhookEndpoint',
    area: 'Webhooks',
    scope: 'webhooks:manage',
    description: `Changes the URL, description, events or the personal-data flag; \`active: false\` pauses deliveries (use \`/enable\` to turn it on again). ${WRITE}`,
    request: { events: ['call.completed', 'campaign.completed', 'whatsapp_campaign.completed'] },
  },
  'DELETE /api/v1/webhook-endpoints/{id}': {
    operationId: 'deleteWebhookEndpoint',
    area: 'Webhooks',
    scope: 'webhooks:manage',
    description: `Removes an endpoint; nothing more is delivered to it. Its delivery log expires after 30 days. ${WRITE}`,
  },
  'POST /api/v1/webhook-endpoints/{id}/test': {
    operationId: 'testWebhookEndpoint',
    area: 'Webhooks',
    scope: 'webhooks:manage',
    description: `Sends a signed sample event of \`type\` now and answers what your server replied (status, time, first 1 KB). Logged as a test delivery, never retried. ${WRITE}`,
    request: { type: 'call.completed' },
  },
  'POST /api/v1/webhook-endpoints/{id}/rotate-secret': {
    operationId: 'rotateWebhookSecret',
    area: 'Webhooks',
    scope: 'webhooks:manage',
    description: `Creates a new signing secret (shown once). For 24 hours requests carry both signatures (\`v1=<new>, v1=<old>\`) so you can switch without missing events. ${WRITE}`,
  },
  'POST /api/v1/webhook-endpoints/{id}/enable': {
    operationId: 'enableWebhookEndpoint',
    area: 'Webhooks',
    scope: 'webhooks:manage',
    description: `Turns a disabled endpoint on again (after 5 events given up in a row or 24 h of failures it is disabled automatically) and resets its failure streak. ${WRITE}`,
  },
  'GET /api/v1/webhook-endpoints/{id}/deliveries': {
    operationId: 'listWebhookDeliveries',
    area: 'Webhooks',
    scope: 'webhooks:manage',
    description: `Delivery log of an endpoint for 30 days, newest first: event id and type, each attempt's status code and time, the next retry. Filters: status, type, from / to. ${CURSOR} ${READ}`,
  },
  'POST /api/v1/webhook-deliveries/{id}/replay': {
    operationId: 'replayWebhookDelivery',
    area: 'Webhooks',
    scope: 'webhooks:manage',
    description: `Delivers an event again now with the same event id (de-duplicate on \`id\`); one attempt, logged. ${WRITE}`,
  },
};
