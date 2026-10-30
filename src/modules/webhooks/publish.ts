import { Types } from 'mongoose';

import { CallInsightModel, type CallInsightDoc } from '../../db/models/call-insight.model';
import { CallModel, type CallDoc } from '../../db/models/call.model';
import type { CampaignDoc } from '../../db/models/campaign.model';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import type { MessageDoc } from '../../db/models/message.model';
import { getLogger } from '../../shared/logger';

import { emitAccountEvent, type WebhookEventType } from './events';

/**
 * Typed `data` per event (PHASE_15_PLAN §1c). Ids always; `phone`, `name`, `summary`
 * and `text` are personal — sent only to endpoints with `includePersonalData`.
 */
export interface WebhookEventMap {
  'call.started': CallStartedData;
  'call.completed': CallCompletedData;
  'call.insights.ready': InsightsReadyData;
  'campaign.completed': CampaignCompletedData;
  'whatsapp.message.received': MessageReceivedData;
  'whatsapp.message.status': MessageStatusData;
  'whatsapp.call.started': WhatsAppCallData;
  'whatsapp.call.ended': WhatsAppCallData;
  'whatsapp.call.missed': WhatsAppCallData;
  'contact.opted_out': ContactOptData;
  'contact.opted_in': ContactOptData;
}

interface Personal {
  phone: string | null;
  name: string | null;
}

export interface CallStartedData extends Personal {
  callId: string;
  contactId: string | null;
  contactExternalId: string | null;
  externalRef: string | null;
  provider: string;
  direction: string;
  campaignId: string | null;
  flowId: string | null;
  agentId: string | null;
}

export interface CallCompletedData extends CallStartedData {
  status: string;
  endReason: string | null;
  durationSec: number;
  costMicros: number;
  disposition: string | null;
  dispositionSource: string | null;
  recording: boolean;
}

export interface InsightsReadyData {
  callId: string;
  contactId: string | null;
  externalRef: string | null;
  status: string;
  reason: string | null;
  sentiment: string | null;
  disposition: string | null;
  keyInfo: {
    promiseDate: string | null;
    promiseAmountMicros: number | null;
    callbackAt: string | null;
  };
  summary: string | null;
}

export interface CampaignCompletedData {
  campaignId: string;
  parentId: string | null;
  counts: {
    contacts: number;
    calls: number;
    answered: number;
    completed: number;
    failed: number;
    skipped: number;
    canceled: number;
  };
  outcomes: Record<string, number>;
  costMicros: number;
  dryRun: boolean;
}

export interface MessageReceivedData extends Personal {
  messageId: string;
  conversationId: string;
  channelId: string;
  contactId: string;
  contactExternalId: string | null;
  type: string;
  text: string | null;
}

export interface MessageStatusData {
  messageId: string;
  conversationId: string;
  channelId: string;
  contactId: string;
  externalRef: string | null;
  status: string;
  errorCode: number | null;
  chargeMicros: number | null;
}

export interface WhatsAppCallData {
  callId: string;
  contactId: string | null;
  channelId: string | null;
  direction: 'inbound' | 'outbound';
  durationSec: number;
  answeredBy: string | null;
  phone: string | null;
}

export interface ContactOptData {
  contactId: string;
  contactExternalId: string | null;
  /** `whatsapp` (STOP / START) or `calls` (opt-out / do-not-call list). */
  channel: 'whatsapp' | 'calls';
  source: 'stop_keyword' | 'start_keyword' | 'manual' | 'dnd_list';
  phone: string | null;
}

const publish = <T extends WebhookEventType>(
  accountId: Types.ObjectId | string,
  type: T,
  data: WebhookEventMap[T],
  key: string,
) => emitAccountEvent(accountId, type, data as unknown as Record<string, unknown>, { key });

const idOf = (v: Types.ObjectId | null | undefined) => (v ? v.toString() : null);

const contactOf = async (accountId: Types.ObjectId, id: Types.ObjectId | null | undefined) =>
  id
    ? ContactModel.findOne({ _id: id, accountId })
        .select({ name: 1, phoneE164: 1, externalId: 1 })
        .lean<Pick<ContactDoc, 'name' | 'phoneE164' | 'externalId'>>()
    : null;

const loadCall = (callId: string | Types.ObjectId) => CallModel.findById(callId).lean<CallDoc>();

const callBase = async (call: CallDoc): Promise<CallStartedData> => {
  const contact = await contactOf(call.accountId, call.contactId);
  return {
    callId: call._id.toString(),
    contactId: idOf(call.contactId),
    contactExternalId: contact?.externalId ?? null,
    externalRef: call.externalRef ?? null,
    provider: call.provider,
    direction: call.direction,
    campaignId: idOf(call.campaignId),
    flowId: idOf(call.source.flowId),
    agentId: idOf(call.source.agentId),
    phone: contact?.phoneE164 ?? null,
    name: contact?.name ?? null,
  };
};

const waCall = (call: CallDoc, contact: CallStartedData): WhatsAppCallData => ({
  callId: call._id.toString(),
  contactId: contact.contactId,
  channelId: idOf(call.whatsapp?.channelId),
  direction: call.whatsapp?.direction === 'USER_INITIATED' ? 'inbound' : 'outbound',
  durationSec: call.durationSec,
  answeredBy: idOf(call.whatsapp?.answeredBy),
  phone: contact.phone,
});

/** Never throws into the call path. */
const safely = async (what: string, run: () => Promise<unknown>): Promise<void> => {
  try {
    await run();
  } catch (err) {
    getLogger().error({ err, event: what }, 'webhooks: publish failed');
  }
};

/** `call.started` (+ `whatsapp.call.started`): the call was answered (CallSession). */
export const publishCallStarted = (callId: string): Promise<void> =>
  safely('call.started', async () => {
    const call = await loadCall(callId);
    if (!call) return;
    const base = await callBase(call);
    await publish(call.accountId, 'call.started', base, `call.started:${callId}`);
    if (call.provider === 'whatsapp')
      await publish(
        call.accountId,
        'whatsapp.call.started',
        waCall(call, base),
        `whatsapp.call.started:${callId}`,
      );
  });

/**
 * `call.completed` (+ `whatsapp.call.ended` / `.missed`): the call ended and its money
 * is settled — read from the stored call so every end path sends the same payload.
 */
export const publishCallCompleted = (callId: string): Promise<void> =>
  safely('call.completed', async () => {
    const call = await loadCall(callId);
    if (!call?.timestamps.endedAt) return;
    const base = await callBase(call);
    await publish(
      call.accountId,
      'call.completed',
      {
        ...base,
        status: call.status,
        endReason: call.endReason ?? null,
        durationSec: call.durationSec,
        costMicros: call.cost.totalMicros,
        disposition: call.disposition,
        dispositionSource: call.dispositionSource ?? null,
        recording: Boolean(call.recording),
      },
      `call.completed:${callId}`,
    );
    if (call.provider !== 'whatsapp') return;
    const answered = Boolean(call.timestamps.answeredAt);
    const inbound = call.whatsapp?.direction === 'USER_INITIATED';
    const type = !answered && inbound ? 'whatsapp.call.missed' : 'whatsapp.call.ended';
    await publish(call.accountId, type, waCall(call, base), `${type}:${callId}`);
  });

/** `call.insights.ready`: insights done / skipped / failed for one version. */
export const publishInsightsReady = (callId: Types.ObjectId, version: number): Promise<void> =>
  safely('call.insights.ready', async () => {
    const call = await loadCall(callId);
    if (!call) return;
    const insight = await CallInsightModel.findOne({
      accountId: call.accountId,
      callId: call._id,
      version,
    }).lean<CallInsightDoc>();
    const out = insight?.output ?? null;
    await publish(
      call.accountId,
      'call.insights.ready',
      {
        callId: call._id.toString(),
        contactId: idOf(call.contactId),
        externalRef: call.externalRef ?? null,
        status: insight?.status ?? call.insights?.status ?? 'skipped',
        reason: insight?.reason ?? call.insights?.reason ?? null,
        sentiment: out?.sentiment.label ?? null,
        disposition: call.disposition,
        keyInfo: {
          promiseDate: out?.keyInfo.promiseDate ?? null,
          promiseAmountMicros: out?.keyInfo.promiseAmountMicros ?? null,
          callbackAt: out?.keyInfo.callbackAt ?? null,
        },
        summary: out?.summary ?? null,
      },
      `call.insights.ready:${call._id.toString()}:v${String(version)}`,
    );
  });

/** `campaign.completed`: a campaign or one recurring run finished. */
export const publishCampaignCompleted = (campaign: CampaignDoc): Promise<void> =>
  safely('campaign.completed', async () => {
    const s = campaign.stats;
    await publish(
      campaign.accountId,
      'campaign.completed',
      {
        campaignId: campaign._id.toString(),
        parentId: idOf(campaign.parentId),
        counts: {
          contacts: s.total,
          calls: s.attempts,
          answered: s.answered,
          completed: s.completed,
          failed: s.failed,
          skipped: s.skipped,
          canceled: s.canceled,
        },
        outcomes: Object.fromEntries(Object.entries(s.dispositions ?? {}).filter(([, n]) => n > 0)),
        costMicros: s.spentMicros,
        dryRun: campaign.mode === 'dry_run',
      },
      `campaign.completed:${campaign._id.toString()}`,
    );
  });

/** `whatsapp.message.received`: a customer message was stored (Meta redeliveries de-duplicated). */
export const publishMessageReceived = (m: MessageDoc): Promise<void> =>
  safely('whatsapp.message.received', async () => {
    const contact = await contactOf(m.accountId, m.contactId);
    await publish(
      m.accountId,
      'whatsapp.message.received',
      {
        messageId: m._id.toString(),
        conversationId: m.conversationId.toString(),
        channelId: m.channelId.toString(),
        contactId: m.contactId.toString(),
        contactExternalId: contact?.externalId ?? null,
        type: m.type,
        phone: contact?.phoneE164 ?? null,
        name: contact?.name ?? null,
        text: m.text ?? null,
      },
      `whatsapp.message.received:${m._id.toString()}`,
    );
  });

/** `whatsapp.message.status`: one of our messages moved forward (repeats never sent). */
export const publishMessageStatus = (m: MessageDoc): Promise<void> =>
  safely('whatsapp.message.status', async () => {
    if (m.direction !== 'out') return;
    await publish(
      m.accountId,
      'whatsapp.message.status',
      {
        messageId: m._id.toString(),
        conversationId: m.conversationId.toString(),
        channelId: m.channelId.toString(),
        contactId: m.contactId.toString(),
        externalRef: m.externalRef ?? null,
        status: m.status,
        errorCode: m.error?.code ?? null,
        chargeMicros: m.billing ? m.billing.priceMicros : null,
      },
      `whatsapp.message.status:${m._id.toString()}:${m.status}`,
    );
  });

/** `contact.opted_out` / `.opted_in` — the caller knows the state really changed. */
export const publishContactOpt = (
  contact: Pick<ContactDoc, '_id' | 'accountId' | 'externalId' | 'phoneE164'>,
  kind: 'opted_out' | 'opted_in',
  channel: ContactOptData['channel'],
  source: ContactOptData['source'],
  at: Date = new Date(),
): Promise<void> =>
  safely(`contact.${kind}`, async () => {
    await publish(
      contact.accountId,
      kind === 'opted_out' ? 'contact.opted_out' : 'contact.opted_in',
      {
        contactId: contact._id.toString(),
        contactExternalId: contact.externalId ?? null,
        channel,
        source,
        phone: contact.phoneE164,
      },
      `contact.${kind}:${contact._id.toString()}:${String(at.getTime())}`,
    );
  });

/** Every live contact with this phone (DND entries are per phone). */
export const publishPhoneOpt = (
  accountId: Types.ObjectId,
  phoneE164: string,
  kind: 'opted_out' | 'opted_in',
  source: ContactOptData['source'],
): Promise<void> =>
  safely(`contact.${kind}`, async () => {
    const at = new Date();
    const contacts = await ContactModel.find({
      accountId: new Types.ObjectId(accountId),
      phoneE164,
      deletedAt: null,
    })
      .select({ _id: 1, accountId: 1, externalId: 1, phoneE164: 1 })
      .limit(20)
      .lean<Pick<ContactDoc, '_id' | 'accountId' | 'externalId' | 'phoneE164'>[]>();
    for (const c of contacts) await publishContactOpt(c, kind, 'calls', source, at);
  });
