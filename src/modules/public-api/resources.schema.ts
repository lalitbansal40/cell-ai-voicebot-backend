import { registry } from '../../shared/openapi/registry';
import { okWith, publicErrors, publicOp } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

/** Account resources for API clients (DOCS-T2): the ids calls, campaigns and messages need. */

export const ResourceFlowsQuery = z.strictObject({
  status: z.enum(['published', 'all']).default('published'),
});
export const ResourceAgentsQuery = z.strictObject({
  active: z.enum(['true', 'false']).default('true'),
});

const AREA = 'Account resources';
const SCOPE = 'resources:read';
const base = '/api/v1/resources';
const ROWS_NOTE = 'At most 200 rows, newest first. Read limit class (600 / min per key).';

export const PublicFlowSchema = registry.register(
  'PublicFlow',
  z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    publishedVersion: z.number().int().nullable(),
    triggers: z.array(z.string()),
    agents: z.array(z.object({ id: z.string(), name: z.string() })),
    updatedAt: z.string(),
  }),
);
export const PublicAgentSchema = registry.register(
  'PublicAgent',
  z.object({
    id: z.string(),
    name: z.string(),
    language: z.string(),
    voice: z.string(),
    isActive: z.boolean(),
    updatedAt: z.string(),
  }),
);
export const PublicWhatsAppNumberSchema = registry.register(
  'PublicWhatsAppNumber',
  z.object({
    id: z.string(),
    label: z.string(),
    displayPhoneNumber: z.string().nullable(),
    status: z.string(),
    mode: z.string(),
    qualityRating: z.string(),
    messagingLimitTier: z.string().nullable(),
    messagesPerSecond: z.number().int(),
    calling: z.object({
      status: z.string(),
      ready: z.boolean(),
      unavailableReason: z.string().nullable(),
    }),
  }),
);
export const PublicContactListSchema = registry.register(
  'PublicContactList',
  z.object({
    id: z.string(),
    name: z.string(),
    contactsCount: z.number().int(),
    updatedAt: z.string(),
  }),
);
export const PublicSegmentSchema = registry.register(
  'PublicSegment',
  z.object({ id: z.string(), name: z.string(), updatedAt: z.string() }),
);
export const PublicPhoneLineSchema = registry.register(
  'PublicPhoneLine',
  z.object({
    line: z.enum(['sip', 'dryrun']),
    numbers: z.array(
      z.object({ id: z.string(), number: z.string(), kind: z.string(), label: z.string() }),
    ),
    voiceApi: z.object({ enabled: z.boolean() }),
    /** Phase 20: numbers customers can call (who answers is set in the app). */
    inboundNumbers: z.array(
      z.object({
        id: z.string(),
        number: z.string(),
        label: z.string(),
        enabled: z.boolean(),
        route: z.enum(['ai', 'team', 'ai_then_team', 'team_then_ai']),
      }),
    ),
  }),
);
export const PublicIvrSchema = registry.register(
  'PublicIvr',
  z.object({ id: z.number().int(), name: z.string() }),
);
export const PublicWalletSchema = registry.register(
  'PublicWallet',
  z.object({
    balanceMicros: z.number().int(),
    availableMicros: z.number().int(),
    holdMicros: z.number().int(),
    creditLimitMicros: z.number().int(),
    currency: z.literal('INR'),
  }),
);

const ID = '6720f0a1b2c3d4e5f6a7b8c9';
const AT = '2026-11-05T09:30:00.000Z';

registry.registerPath({
  method: 'get',
  path: `${base}/flows`,
  ...publicOp({
    operationId: 'listFlows',
    area: AREA,
    scope: SCOPE,
    summary: 'Call flows (ids for calls and campaigns)',
    description: `Published call flows by default (\`status=all\` adds drafts and archived ones). Use a flow \`id\` in \`POST /calls\` (\`flowId\`) or \`POST /campaigns\` (\`flowId\` / \`program\`). Only flows whose \`triggers\` include \`campaign\` can run in a campaign; \`api\` for single calls. ${ROWS_NOTE}`,
  }),
  request: { query: ResourceFlowsQuery },
  responses: {
    200: okWith(z.array(PublicFlowSchema), [
      {
        id: ID,
        name: 'Loan recovery',
        status: 'published',
        publishedVersion: 3,
        triggers: ['campaign', 'api'],
        agents: [{ id: '6720f0a1b2c3d4e5f6a7b8ca', name: 'Recovery agent' }],
        updatedAt: AT,
      },
    ]),
    ...publicErrors(),
  },
});

registry.registerPath({
  method: 'get',
  path: `${base}/agents`,
  ...publicOp({
    operationId: 'listAgents',
    area: AREA,
    scope: SCOPE,
    summary: 'AI agents (ids for agent calls and campaigns)',
    description: `Active AI agents by default (\`active=false\` lists all). Use an agent \`id\` as \`agentId\` in \`POST /calls\`, \`program: { kind: 'agent', id }\` in WhatsApp call campaigns, or in \`POST /whatsapp/calls\`. Prompts, functions and their secrets are never returned. ${ROWS_NOTE}`,
  }),
  request: { query: ResourceAgentsQuery },
  responses: {
    200: okWith(z.array(PublicAgentSchema), [
      {
        id: ID,
        name: 'Recovery agent',
        language: 'hinglish',
        voice: 'coral',
        isActive: true,
        updatedAt: AT,
      },
    ]),
    ...publicErrors(),
  },
});

registry.registerPath({
  method: 'get',
  path: `${base}/whatsapp-numbers`,
  ...publicOp({
    operationId: 'listWhatsAppNumbers',
    area: AREA,
    scope: SCOPE,
    summary: 'Connected WhatsApp numbers (channel ids)',
    description: `Connected WhatsApp numbers of the account. \`id\` is the \`channelId\` for template sends, WhatsApp calls and bulk campaigns. \`messagesPerSecond\` is the bulk-campaign cap of the number (Business App or unconfirmed: 18, Cloud API: 75). \`calling.ready\` says whether WhatsApp calls can go out now; \`unavailableReason\` explains why not (e.g. \`coexistence\`). ${ROWS_NOTE}`,
  }),
  responses: {
    200: okWith(z.array(PublicWhatsAppNumberSchema), [
      {
        id: ID,
        label: 'Support',
        displayPhoneNumber: '+91 90000 00001',
        status: 'connected',
        mode: 'cloud_api',
        qualityRating: 'GREEN',
        messagingLimitTier: 'TIER_10K',
        messagesPerSecond: 75,
        calling: { status: 'enabled', ready: true, unavailableReason: null },
      },
    ]),
    ...publicErrors(),
  },
});

registry.registerPath({
  method: 'get',
  path: `${base}/contact-lists`,
  ...publicOp({
    operationId: 'listContactLists',
    area: AREA,
    scope: SCOPE,
    summary: 'Contact lists (audience ids)',
    description: `Contact lists with their live contact counts. Use ids in campaign \`audience.listIds\`. ${ROWS_NOTE}`,
  }),
  responses: {
    200: okWith(z.array(PublicContactListSchema), [
      { id: ID, name: 'November dues', contactsCount: 1250, updatedAt: AT },
    ]),
    ...publicErrors(),
  },
});

registry.registerPath({
  method: 'get',
  path: `${base}/segments`,
  ...publicOp({
    operationId: 'listSegments',
    area: AREA,
    scope: SCOPE,
    summary: 'Saved segments (audience ids)',
    description: `Saved contact segments (filters). Use an id in campaign \`audience.segmentId\`; the filter is applied when the campaign starts. ${ROWS_NOTE}`,
  }),
  responses: {
    200: okWith(z.array(PublicSegmentSchema), [{ id: ID, name: 'Due this week', updatedAt: AT }]),
    ...publicErrors(),
  },
});

registry.registerPath({
  method: 'get',
  path: `${base}/phone-line`,
  ...publicOp({
    operationId: 'getPhoneLine',
    area: AREA,
    scope: SCOPE,
    summary: 'Phone line, caller numbers and recorded voice',
    description:
      'Which line phone calls use (`sip` = real phones, `dryrun` = the simulated test line), the caller numbers (`phoneLine.callerNumberId` in campaigns), whether recorded-voice / IVR campaigns (`line: voice_api`) are on for the account, and the numbers customers can call in (`inboundNumbers`: on / off and who answers — flows, AI agents or the team).',
  }),
  responses: {
    200: okWith(PublicPhoneLineSchema, {
      line: 'sip',
      numbers: [{ id: ID, number: '+911600123456', kind: '1600', label: 'Main' }],
      voiceApi: { enabled: true },
      inboundNumbers: [
        { id: ID, number: '+911600000001', label: 'Support line', enabled: true, route: 'ai' },
      ],
    }),
    ...publicErrors(),
  },
});

registry.registerPath({
  method: 'get',
  path: `${base}/ivrs`,
  ...publicOp({
    operationId: 'listIvrs',
    area: AREA,
    scope: SCOPE,
    summary: 'IVR menus for recorded-voice campaigns',
    description:
      "IVR menus assigned to this account for recorded-voice campaigns (`voiceApi.content: { kind: 'ivr', ivrId }`). Empty when recorded voice is off or no menu is assigned.",
  }),
  responses: {
    200: okWith(z.array(PublicIvrSchema), [{ id: 101, name: 'Press 1 to confirm' }]),
    ...publicErrors(),
  },
});

registry.registerPath({
  method: 'get',
  path: `${base}/wallet`,
  ...publicOp({
    operationId: 'getWalletBalance',
    area: AREA,
    scope: SCOPE,
    summary: 'Wallet balance',
    description:
      'Balance in micros (₹1 = 1,000,000). `availableMicros` = balance − holds + credit limit: what calls, messages and campaigns can still spend. Holds are money reserved by running calls and unsent batches.',
  }),
  responses: {
    200: okWith(PublicWalletSchema, {
      balanceMicros: 2_500_000_000,
      availableMicros: 2_480_000_000,
      holdMicros: 20_000_000,
      creditLimitMicros: 0,
      currency: 'INR',
    }),
    ...publicErrors(),
  },
});
