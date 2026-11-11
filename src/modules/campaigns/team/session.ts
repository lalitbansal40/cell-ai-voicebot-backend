import type { Redis } from 'ioredis';
import { Types } from 'mongoose';

import { getEnv } from '../../../config/env';
import { getAppRedis } from '../../../core/queues/redis';
import { notifyAccount } from '../../../core/realtime/notify';
import type { CampaignDoc } from '../../../db/models/campaign.model';
import { UserModel } from '../../../db/models/user.model';
import { getLogger } from '../../../shared/logger';

/**
 * CM — the calling session of a team campaign: who joined and what each agent is doing.
 * Redis hash `cm:team:<campaignId>`: userId → `{ state, since, callId, seenAt }`. An agent
 * whose browser stopped sending heartbeats for `AWAY_MS` is away (gets no calls).
 */

export const AGENT_STATES = ['ready', 'on_call', 'wrap_up', 'paused'] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export interface AgentSlot {
  state: AgentState;
  since: number;
  callId: string | null;
  seenAt: number;
  /** `wrap_up` ends at (ms). */
  until: number | null;
}

export const HEARTBEAT_MS = 10_000;
export const AWAY_MS = 30_000;
const HASH_TTL_SEC = 24 * 60 * 60;

let redisOverride: Redis | null = null;
/** Tests: the Redis to keep sessions in. */
export const setSessionRedis = (redis: Redis | null): void => {
  redisOverride = redis;
};
const redis = (): Redis => redisOverride ?? getAppRedis(getEnv().REDIS_URL, getLogger());
const key = (campaignId: string) => `cm:team:${campaignId}`;

export const readSlot = async (campaignId: string, userId: string): Promise<AgentSlot | null> => {
  const raw = await redis().hget(key(campaignId), userId);
  return raw ? (JSON.parse(raw) as AgentSlot) : null;
};

export const writeSlot = async (
  campaignId: string,
  userId: string,
  slot: AgentSlot,
): Promise<void> => {
  const r = redis();
  await r.hset(key(campaignId), userId, JSON.stringify(slot));
  await r.expire(key(campaignId), HASH_TTL_SEC);
};

export const dropSlot = async (campaignId: string, userId: string): Promise<void> => {
  await redis().hdel(key(campaignId), userId);
};

export const readSlots = async (campaignId: string): Promise<Map<string, AgentSlot>> => {
  const raw = await redis().hgetall(key(campaignId));
  return new Map(Object.entries(raw).map(([u, v]) => [u, JSON.parse(v) as AgentSlot]));
};

/** The agent's state now (a finished wrap-up is `ready`; a silent browser is away). */
export const effectiveState = (slot: AgentSlot, now: number): AgentState | 'away' => {
  if (now - slot.seenAt > AWAY_MS) return 'away';
  if (slot.state === 'wrap_up' && slot.until !== null && slot.until <= now) return 'ready';
  return slot.state;
};

/** May this user take the campaign's calls (listed, or anyone who may call when no list). */
export const mayJoin = (campaign: Pick<CampaignDoc, 'team'>, userId: string): boolean => {
  const ids = campaign.team?.agentUserIds;
  return !ids || ids.some((id) => id.toString() === userId);
};

/** Live board for the campaign page (agents' names, states, current calls). */
export const sessionBoard = async (campaign: CampaignDoc, now = Date.now()) => {
  const slots = await readSlots(campaign._id.toString());
  const ids = [...slots.keys()].filter((id) => Types.ObjectId.isValid(id));
  const users = await UserModel.find({ _id: { $in: ids }, accountId: campaign.accountId })
    .select({ name: 1 })
    .lean<{ _id: Types.ObjectId; name: string }[]>();
  const names = new Map(users.map((u) => [u._id.toString(), u.name]));
  const agents = [...slots.entries()].map(([userId, slot]) => ({
    userId,
    name: names.get(userId) ?? 'Team member',
    state: effectiveState(slot, now),
    callId: slot.callId,
    since: new Date(slot.since).toISOString(),
    wrapUpUntil: slot.state === 'wrap_up' && slot.until ? new Date(slot.until).toISOString() : null,
  }));
  return {
    agents,
    ready: agents.filter((a) => a.state === 'ready').length,
    onCall: agents.filter((a) => a.state === 'on_call').length,
  };
};

/** Tells the campaign page that the session changed (ids and states only). */
export const publishSession = (campaign: Pick<CampaignDoc, '_id' | 'accountId'>): void => {
  notifyAccount(campaign.accountId.toString(), 'campaign.session', {
    campaignId: campaign._id.toString(),
  });
};
