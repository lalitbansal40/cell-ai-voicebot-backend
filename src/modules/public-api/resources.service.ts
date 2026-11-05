import type { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { availableMicros } from '../../core/billing/events';
import { getOrCreateWallet } from '../../core/billing/wallets';
import { AiAgentModel } from '../../db/models/ai-agent.model';
import { ContactListModel } from '../../db/models/contact-list.model';
import { ContactModel } from '../../db/models/contact.model';
import { FlowModel } from '../../db/models/flow.model';
import { SegmentModel } from '../../db/models/segment.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { accountPhoneLine } from '../phone-numbers/phone-numbers.service';
import { accountIvrs } from '../voice-api/voice-api.service';
import { callingUnavailableReason } from '../whatsapp-calling/availability';
import { campaignMps } from '../whatsapp-campaigns/pacing';

/**
 * Account resources for the public API (DOCS-T2): the ids a client needs for calls,
 * campaigns and messages, as minimal views — never graphs, prompts, tokens, secrets
 * or provider costs. Every query is scoped to the account.
 */

const MAX = 200;

export const listResourceFlows = async (accountId: Types.ObjectId, status: 'published' | 'all') => {
  const flows = await FlowModel.find({
    accountId,
    ...(status === 'published'
      ? { publishedVersionId: { $ne: null }, status: { $ne: 'archived' } }
      : {}),
  })
    .sort({ updatedAt: -1 })
    .limit(MAX)
    .select({ name: 1, status: 1, publishedVersion: 1, stats: 1, updatedAt: 1 })
    .lean<
      {
        _id: Types.ObjectId;
        name: string;
        status: string;
        publishedVersion: number | null;
        stats?: { agents?: Types.ObjectId[]; triggers?: string[] };
        updatedAt: Date;
      }[]
    >();
  const agentIds = [...new Set(flows.flatMap((f) => (f.stats?.agents ?? []).map(String)))];
  const agents = agentIds.length
    ? await AiAgentModel.find({ _id: { $in: agentIds }, accountId })
        .select({ name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    : [];
  const names = new Map(agents.map((a) => [a._id.toString(), a.name]));
  return flows.map((f) => ({
    id: f._id.toString(),
    name: f.name,
    status: f.status,
    publishedVersion: f.publishedVersion,
    triggers: f.stats?.triggers ?? [],
    agents: (f.stats?.agents ?? []).map((id) => ({
      id: id.toString(),
      name: names.get(id.toString()) ?? '',
    })),
    updatedAt: f.updatedAt.toISOString(),
  }));
};

export const listResourceAgents = async (accountId: Types.ObjectId, activeOnly: boolean) => {
  const agents = await AiAgentModel.find({ accountId, ...(activeOnly ? { isActive: true } : {}) })
    .sort({ updatedAt: -1 })
    .limit(MAX)
    .select({ name: 1, language: 1, voice: 1, isActive: 1, updatedAt: 1 })
    .lean<
      {
        _id: Types.ObjectId;
        name: string;
        language: string;
        voice: string;
        isActive: boolean;
        updatedAt: Date;
      }[]
    >();
  return agents.map((a) => ({
    id: a._id.toString(),
    name: a.name,
    language: a.language,
    voice: a.voice,
    isActive: a.isActive,
    updatedAt: a.updatedAt.toISOString(),
  }));
};

const channelView = (c: WhatsAppChannelDoc) => {
  const unavailable = callingUnavailableReason(c);
  const callingStatus = c.calling?.status ?? 'disabled';
  return {
    id: c._id.toString(),
    label: c.label,
    displayPhoneNumber: c.displayPhoneNumber ?? c.phoneE164,
    status: c.status,
    mode: c.mode,
    qualityRating: c.qualityRating,
    messagingLimitTier: c.messagingLimitTier,
    /** Bulk campaign cap of this number (Business App / unknown 18, Cloud API 75). */
    messagesPerSecond: campaignMps(c, getEnv().WA_CAMPAIGN_MPS),
    calling: {
      status: callingStatus,
      ready: c.status === 'connected' && callingStatus === 'enabled' && !unavailable,
      unavailableReason: unavailable,
    },
  };
};

export const listResourceChannels = async (accountId: Types.ObjectId) => {
  const channels = await WhatsAppChannelModel.find({ accountId, status: { $ne: 'disconnected' } })
    .sort({ createdAt: 1 })
    .limit(MAX)
    .lean<WhatsAppChannelDoc[]>();
  return channels.map(channelView);
};

export const listResourceLists = async (accountId: Types.ObjectId) => {
  const lists = await ContactListModel.find({ accountId })
    .sort({ updatedAt: -1 })
    .limit(MAX)
    .select({ name: 1, updatedAt: 1 })
    .lean<{ _id: Types.ObjectId; name: string; updatedAt: Date }[]>();
  const counts = lists.length
    ? await ContactModel.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { accountId, deletedAt: null, listIds: { $in: lists.map((l) => l._id) } } },
        { $unwind: '$listIds' },
        { $match: { listIds: { $in: lists.map((l) => l._id) } } },
        { $group: { _id: '$listIds', n: { $sum: 1 } } },
      ])
    : [];
  const byId = new Map(counts.map((c) => [c._id.toString(), c.n]));
  return lists.map((l) => ({
    id: l._id.toString(),
    name: l.name,
    contactsCount: byId.get(l._id.toString()) ?? 0,
    updatedAt: l.updatedAt.toISOString(),
  }));
};

export const listResourceSegments = async (accountId: Types.ObjectId) => {
  const segments = await SegmentModel.find({ accountId })
    .sort({ updatedAt: -1 })
    .limit(MAX)
    .select({ name: 1, updatedAt: 1 })
    .lean<{ _id: Types.ObjectId; name: string; updatedAt: Date }[]>();
  return segments.map((s) => ({
    id: s._id.toString(),
    name: s.name,
    updatedAt: s.updatedAt.toISOString(),
  }));
};

export const resourcePhoneLine = async (accountId: Types.ObjectId) => {
  const line = await accountPhoneLine(accountId);
  return {
    line: line.line,
    numbers: line.numbers.map((n) => ({
      id: n.id,
      number: n.number,
      kind: n.kind,
      label: n.label,
    })),
    voiceApi: line.voiceApi,
  };
};

export const resourceIvrs = (accountId: Types.ObjectId) => accountIvrs(accountId);

export const resourceWallet = async (accountId: Types.ObjectId) => {
  const wallet = await getOrCreateWallet(accountId);
  return {
    balanceMicros: wallet.balanceMicros,
    availableMicros: availableMicros(wallet),
    holdMicros: wallet.holdMicros,
    creditLimitMicros: wallet.creditLimitMicros,
    currency: 'INR' as const,
  };
};
