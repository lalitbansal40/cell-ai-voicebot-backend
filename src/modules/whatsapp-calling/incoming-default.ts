import { Types } from 'mongoose';

import type { Env } from '../../config/env';
import { availableMicros } from '../../core/billing/events';
import { getOrCreateWallet } from '../../core/billing/wallets';
import {
  AccountModel,
  DEFAULT_WA_INCOMING,
  type AccountWaIncoming,
} from '../../db/models/account.model';
import type { WaCallingInbound } from '../../db/models/whatsapp-channel.model';
import { ValidationError, type ErrorDetail } from '../../shared/errors/app-error';
import { recordAudit, type AuditActorInput } from '../audit/audit.service';

import { programProblems } from './program';

/**
 * SAC-T6: "AI se incoming calls uthao". The simple switch maps onto the existing routes (D13):
 * ON + "AI first, then the team" → `ai_then_team`, ON + "AI only" → `ai`, OFF → `team`,
 * Advanced "Team first, then AI" → `team_then_ai`. The account keeps a default that every
 * number connected from now on starts with; each number keeps its own copy.
 */

export type IncomingRoute = AccountWaIncoming['route'];

export interface IncomingView {
  route: IncomingRoute;
  aiProgram: { kind: 'flow' | 'agent'; id: string } | null;
  ringTimeoutSec: number;
}

export const incomingView = (v: AccountWaIncoming | undefined | null): IncomingView => {
  const x = v ?? DEFAULT_WA_INCOMING;
  return {
    route: x.route,
    aiProgram: x.aiProgram ? { kind: x.aiProgram.kind, id: x.aiProgram.id.toString() } : null,
    ringTimeoutSec: x.ringTimeoutSec,
  };
};

/** AI answers somewhere in this route. */
export const aiAnswers = (route: IncomingRoute): boolean => route !== 'team';

/**
 * SAC D14: what an AI route needs on this install / account — the program, call audio on
 * this server and money in the wallet. Channel checks (calling on, readiness) are the
 * number's own (`settings.service.ts`).
 */
export const aiRouteProblems = async (
  env: Pick<Env, 'NODE_ENV' | 'WA_MEDIA_ENABLED' | 'WA_MEDIA_PUBLIC_IP'>,
  accountId: Types.ObjectId,
  program: { kind: 'flow' | 'agent'; id: string } | null,
  path = 'inbound.aiProgram',
): Promise<ErrorDetail[]> => {
  const problems = await programProblems(accountId, program, path);
  if (!env.WA_MEDIA_ENABLED || (env.NODE_ENV === 'production' && !env.WA_MEDIA_PUBLIC_IP)) {
    problems.push({
      path: 'media',
      message: 'Call audio is not set up on this server — ask support (WA_MEDIA_* settings).',
    });
  }
  if (availableMicros(await getOrCreateWallet(accountId)) <= 0) {
    problems.push({
      path: 'wallet',
      message: 'Add money first — AI answers are paid from the wallet.',
    });
  }
  return problems;
};

export const getIncomingDefault = async (accountId: Types.ObjectId): Promise<IncomingView> => {
  const account = await AccountModel.findById(accountId)
    .select({ 'settings.waIncoming': 1 })
    .lean<{ settings?: { waIncoming?: AccountWaIncoming } }>();
  return incomingView(account?.settings?.waIncoming);
};

export const setIncomingDefault = async (
  env: Pick<Env, 'NODE_ENV' | 'WA_MEDIA_ENABLED' | 'WA_MEDIA_PUBLIC_IP'>,
  accountId: Types.ObjectId,
  body: IncomingView,
  actor: AuditActorInput & { ip?: string | null },
): Promise<IncomingView> => {
  if (aiAnswers(body.route)) {
    const problems = await aiRouteProblems(env, accountId, body.aiProgram, 'aiProgram');
    if (problems.length) throw new ValidationError(problems);
  }
  const value: AccountWaIncoming = {
    route: body.route,
    aiProgram:
      aiAnswers(body.route) && body.aiProgram
        ? { kind: body.aiProgram.kind, id: new Types.ObjectId(body.aiProgram.id) }
        : null,
    ringTimeoutSec: body.ringTimeoutSec,
  };
  await AccountModel.updateOne({ _id: accountId }, { $set: { 'settings.waIncoming': value } });
  await recordAudit({
    accountId,
    actor,
    action: 'whatsapp.incoming_default_updated',
    target: { type: 'account', id: accountId.toString() },
    meta: { route: value.route, program: value.aiProgram?.kind ?? null },
    ip: actor.ip ?? null,
  });
  return incomingView(value);
};

/** The `calling.inbound` a new number starts with (the account default; nobody listed). */
export const inboundForNewChannel = async (
  accountId: Types.ObjectId,
): Promise<WaCallingInbound> => {
  const account = await AccountModel.findById(accountId)
    .select({ 'settings.waIncoming': 1 })
    .lean<{ settings?: { waIncoming?: AccountWaIncoming } }>();
  const d = account?.settings?.waIncoming ?? DEFAULT_WA_INCOMING;
  return {
    route: d.route,
    aiProgram: d.aiProgram,
    ringTimeoutSec: d.ringTimeoutSec,
    ringUserIds: null,
  };
};
