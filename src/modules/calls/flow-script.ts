import type { Redis } from 'ioredis';
import { Types } from 'mongoose';

import type { Env } from '../../config/env';
import { FLOW_LIMITS } from '../../config/limits';
import type { HttpToolOptions } from '../../core/ai/http-tool';
import { outgoingPolicy } from '../../core/ai/ip-guard';
import type { AiProvider } from '../../core/ai/types';
import { mongoStatsRecorder } from '../../core/engine/stats';
import type { StorageProvider } from '../../core/storage';
import { decodedAudio } from '../../core/voice/audio/decode';
import { FlowHost, type AiStepEnd, type AiStepRequest } from '../../core/voice/flow-host';
import type { SttProvider } from '../../core/voice/providers/types';
import { AccountModel } from '../../db/models/account.model';
import type { CallDoc } from '../../db/models/call.model';
import { CallModel } from '../../db/models/call.model';
import { FlowAudioModel } from '../../db/models/flow-audio.model';
import { FlowRunModel } from '../../db/models/flow-run.model';
import { createFlowEffects } from '../flows/effects';
import { findFlow, type FlowsDeps } from '../flows/flows.service';
import { resolveStartValues, resolveVersion, type RunContact } from '../flows/run-values';
import { accountTimezone } from '../wallet/wallet.service';

import type { ScriptChoice } from './scripts';

export interface FlowScriptDeps extends FlowsDeps {
  env: FlowsDeps['env'] & Pick<Env, 'OPENAI_TEXT_MODEL' | 'OPENAI_EMBEDDING_MODEL'>;
  provider: AiProvider;
  stt: SttProvider;
  storage: StorageProvider | undefined;
  redis?: Redis;
  /** Test hooks for API steps (fake resolver, dial map). */
  http?: Omit<HttpToolOptions, 'policy'>;
  now?: () => Date;
  /** Live AI step (T7.7 controller). */
  runAi: (request: AiStepRequest, context: AiCallContext) => Promise<AiStepEnd>;
}

/** What the AI step needs from the call besides the step itself. */
export interface AiCallContext {
  call: CallDoc;
  company: string;
  timezone: string;
  contact: RunContact;
  runId: Types.ObjectId;
}

/** Builds the Phase 6 flow host for a flow call (PHASE_7_PLAN §1g). */
export const flowScript = async (call: CallDoc, deps: FlowScriptDeps): Promise<ScriptChoice> => {
  const now = deps.now ?? (() => new Date());
  const accountId = call.accountId;
  const flow = await findFlow(accountId, String(call.source.flowId));
  const { graph, versionRef, checksum } = await resolveVersion(
    flow,
    call.source.flowVersionRef ?? 'published',
    deps,
  );
  const withPhone = await CallModel.findById(call._id)
    .select({ testPhone: 1 })
    .lean<{ testPhone: string | null }>();
  const { contact, seed } = await resolveStartValues(accountId, graph, {
    contactId: call.contactId,
    variables: call.manualVariables,
    testPhone: withPhone?.testPhone ?? null,
  });
  const account = await AccountModel.findById(accountId)
    .select({ name: 1 })
    .lean<{ name: string }>();
  const company = account?.name ?? '';
  const timezone = await accountTimezone(accountId);
  const run = await FlowRunModel.create({
    accountId,
    flowId: flow._id,
    mode: 'call',
    callId: call._id,
    versionRef,
    graph: versionRef === 'draft' ? graph : null,
    graphChecksum: checksum,
    contactId: call.contactId,
    manualVariables: call.manualVariables,
    createdBy: call.startedBy,
  });
  const stats = mongoStatsRecorder({
    accountId,
    flowId: flow._id,
    version: versionRef === 'draft' ? 0 : versionRef,
    mode: 'call',
    timezone,
    now,
  });
  const effects = createFlowEffects({
    accountId,
    company,
    timezone,
    runId: run._id,
    callId: call._id,
    mode: 'call',
    contact: {
      phone: contact.phone,
      externalId: contact.externalId,
      templateValues: contact.templateValues,
    },
    provider: deps.provider,
    textModel: deps.env.OPENAI_TEXT_MODEL,
    embeddingModel: deps.env.OPENAI_EMBEDDING_MODEL,
    secretKey: deps.secretKey,
    http: { ...(deps.http ?? {}), policy: outgoingPolicy(deps.env, deps.extraPorts) },
    now,
  });
  const callId = call._id.toString();
  const host = new FlowHost({
    graph,
    ctx: { now, timezone, company, mode: 'call', stats },
    effects,
    contact: contact.display,
    seed,
    stt: deps.stt,
    language: graph.settings.language,
    voice: graph.settings.voice,
    loadAudio: async (audioId) => {
      if (!deps.storage || !Types.ObjectId.isValid(audioId)) return null;
      const audio = await FlowAudioModel.findOne({ _id: audioId, accountId }).lean();
      if (!audio) return null;
      return decodedAudio(deps.storage, {
        id: audioId,
        accountId: accountId.toString(),
        fileKey: audio.fileKey,
        format: audio.format,
      }).catch(() => null);
    },
    runAi: (request) => deps.runAi(request, { call, company, timezone, contact, runId: run._id }),
    onStep: async (result) => {
      await stats.flush();
      await deps.redis
        ?.set(`call:state:${callId}`, JSON.stringify(result.state), 'EX', 2 * 60 * 60)
        .catch(() => undefined);
    },
    onFinish: async (state, trace) => {
      await FlowRunModel.updateOne(
        { _id: run._id },
        {
          $set: {
            state,
            status: 'ended',
            waiting: null,
            trace: trace.slice(-FLOW_LIMITS.traceRowsMax),
            endReason: state.endReason,
            endedAt: now(),
          },
        },
      );
      await deps.redis?.del(`call:state:${callId}`).catch(() => undefined);
      return run._id.toString();
    },
  });
  return { script: host, voice: graph.settings.voice, language: graph.settings.language };
};
