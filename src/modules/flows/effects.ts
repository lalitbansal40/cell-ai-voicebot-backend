import { Types } from 'mongoose';

import { compileAgent } from '../../core/ai/compile';
import { sendGuardedRequest, type HttpToolOptions } from '../../core/ai/http-tool';
import { turnCost } from '../../core/ai/pricing';
import { runAgentTurn } from '../../core/ai/run-turn';
import { open } from '../../core/ai/secret-box';
import type { AiProvider } from '../../core/ai/types';
import { chargeUsage } from '../../core/billing/engine';
import { effectiveRateCard } from '../../core/billing/rates';
import { getOrCreateWallet } from '../../core/billing/wallets';
import { intentMessages, parseIntentReply } from '../../core/engine/intent-ai';
import type { NodeConfig } from '../../core/engine/schema';
import type { AiTurnResult, FlowEffects } from '../../core/engine/types';
import { flowTemplate } from '../../core/engine/variables';
import type { Json } from '../../core/templating';
import { AiAgentModel, type AiAgentDoc } from '../../db/models/ai-agent.model';
import { FlowAudioModel } from '../../db/models/flow-audio.model';
import { AppError } from '../../shared/errors/app-error';

export interface FlowEffectsDeps {
  accountId: Types.ObjectId;
  /** Account name (`{{company}}`). */
  company: string;
  timezone: string;
  /** The run — AI charges reference it, keys use it. */
  runId: Types.ObjectId;
  /** Calls: text-model charges are billed to the call (kind `call`). */
  callId?: Types.ObjectId;
  mode: 'simulator' | 'call';
  /** Server-only contact facts: API templates (`{{contact.phone}}`) and agent functions. */
  contact: {
    phone: string | null;
    externalId: string | null;
    /** `{{contact.*}}` values for agent function templates (Phase 5 shape). */
    templateValues: Record<string, unknown>;
  };
  provider: AiProvider;
  textModel: string;
  embeddingModel: string;
  secretKey: Buffer;
  http: HttpToolOptions;
  now: () => Date;
  /** `none` (dry-run calls): AI intents are neither wallet-checked nor charged. Default `charge`. */
  billing?: 'charge' | 'none';
}

const OPEN_FAILED = 'secret_unavailable';

/** Renders an API node: flat `{{name}}` + server-only `{{contact.*}}`; secrets opened in memory. */
const renderApi = (
  config: NodeConfig<'api_request'>,
  values: Record<string, string>,
  deps: Pick<FlowEffectsDeps, 'contact' | 'secretKey'>,
) => {
  const ctx = {
    values,
    contact: { phone: deps.contact.phone, external_id: deps.contact.externalId },
  };
  const warnings = new Set<string>();
  const headers: Record<string, string> = {};
  for (const h of config.headers) {
    const value = h.secret
      ? open(deps.secretKey, h.sealed ?? '')
      : flowTemplate.renderHeader(h.value ?? '', ctx, warnings);
    if (value === null) throw new Error('invalid_request');
    headers[h.name.toLowerCase()] = value;
  }
  let body: string | null = null;
  if (config.method !== 'GET' && config.bodyTemplate?.trim()) {
    body = JSON.stringify(
      flowTemplate.renderJson(JSON.parse(config.bodyTemplate) as Json, ctx, warnings),
    );
    headers['content-type'] = 'application/json';
  }
  return { url: flowTemplate.renderUrl(config.url, ctx, warnings), headers, body };
};

/** Values the AI may see: the agent's allowed contact variables + the node's flow variables. */
export const agentValues = (
  agent: Pick<AiAgentDoc, 'allowedVariables'>,
  config: Pick<NodeConfig<'ai_agent'>, 'passVariables'>,
  values: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    [...new Set([...agent.allowedVariables, ...config.passVariables])].map((name) => [
      name,
      values[name] ?? '',
    ]),
  );

/** Live `FlowEffects` for the simulator (and Phase 7 calls with live built-ins later). */
export const createFlowEffects = (deps: FlowEffectsDeps): FlowEffects => {
  const agents = new Map<string, AiAgentDoc | null>();
  const loadAgent = async (id: string): Promise<AiAgentDoc | null> => {
    if (!agents.has(id)) {
      agents.set(
        id,
        Types.ObjectId.isValid(id)
          ? await AiAgentModel.findOne({ _id: id, accountId: deps.accountId }).lean<AiAgentDoc>()
          : null,
      );
    }
    return agents.get(id) ?? null;
  };
  const compiled = (agent: AiAgentDoc, values: Record<string, string>, goal?: string) =>
    compileAgent(agent, {
      company: deps.company,
      variables: values,
      channel: deps.mode === 'call' ? 'voice' : 'text',
      now: deps.now(),
      timezone: deps.timezone,
      ...(goal ? { extraInstructions: goal } : {}),
    });
  const goalOf = (config: NodeConfig<'ai_agent'>, values: Record<string, string>) =>
    config.goal ? flowTemplate.renderText(config.goal, { values }, new Set()) : undefined;

  return {
    callApi: async ({ config, values }) => {
      let rendered: ReturnType<typeof renderApi>;
      try {
        rendered = renderApi(config, values, deps);
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error && err.message === 'invalid_request'
              ? 'invalid_request'
              : OPEN_FAILED,
          durationMs: 0,
        };
      }
      const res = await sendGuardedRequest(
        { ...rendered, method: config.method, timeoutMs: config.timeoutMs },
        deps.http,
      );
      return res.ok
        ? { ok: true, status: res.status, body: res.body, durationMs: res.durationMs }
        : { ok: false, error: res.error, durationMs: res.durationMs };
    },

    aiStart: async ({ config, values }) => {
      const agent = await loadAgent(config.agentId);
      if (!agent) return { ok: false, text: null, reason: 'agent_missing' };
      const c = compiled(agent, agentValues(agent, config, values));
      if (!agent.isActive)
        return { ok: false, text: c.fallbacks.agentOff || null, reason: 'agentOff' };
      return { ok: true, text: c.openingLine || null, reason: null };
    },

    aiTurn: async ({ config, values, turns, userText, inputId }): Promise<AiTurnResult> => {
      const agent = await loadAgent(config.agentId);
      const seen = agent ? agentValues(agent, config, values) : {};
      if (!agent) {
        return {
          text: '',
          outcome: {},
          ended: false,
          fallback: 'agentOff',
          guardrail: null,
          toolCalls: [],
          knowledge: [],
          costMicros: 0,
        };
      }
      const goal = goalOf(config, values);
      try {
        const result = await runAgentTurn({
          accountId: deps.accountId,
          agent,
          session: { _id: deps.runId, turns, variables: seen },
          userText,
          clientTurnId: inputId,
          provider: deps.provider,
          now: deps.now(),
          timezone: deps.timezone,
          company: deps.company,
          contact: deps.contact.templateValues,
          secretKey: deps.secretKey,
          http: deps.http,
          embeddingModel: deps.embeddingModel,
          source: deps.mode === 'call' ? 'call' : 'flow_simulator',
          ...(goal ? { extraInstructions: goal } : {}),
        });
        const t = result.turn;
        return {
          text: t.text,
          outcome: result.outcome,
          ended: result.ended,
          fallback: t.fallback,
          guardrail: t.guardrail,
          toolCalls: t.toolCalls.map((c) => ({
            ...c,
            args: c.args ?? {},
            resultPreview: c.resultPreview ?? null,
            error: c.error ?? null,
          })),
          knowledge: t.knowledge,
          costMicros: t.costMicros,
        };
      } catch (err) {
        if (err instanceof AppError && err.code === 'AI_SPEND_CAP_REACHED') {
          return {
            text: compiled(agent, seen).fallbacks.capReached,
            outcome: {},
            ended: false,
            fallback: 'capReached',
            guardrail: null,
            toolCalls: [],
            knowledge: [],
            costMicros: 0,
          };
        }
        throw err;
      }
    },

    classifyIntent: async ({ text, intents, inputId }) => {
      const charge = deps.billing !== 'none';
      const wallet = charge ? await getOrCreateWallet(deps.accountId) : null;
      if (wallet && wallet.balanceMicros - wallet.holdMicros <= 0) throw new Error('wallet_empty');
      const out = await deps.provider.chat({
        model: deps.textModel,
        messages: intentMessages(text, intents),
        temperatureTenths: 0,
        maxOutputTokens: 50,
      });
      const cost = charge ? turnCost(await effectiveRateCard(deps.accountId), out.usage) : 0;
      if (cost > 0) {
        await chargeUsage({
          accountId: deps.accountId,
          type: 'ai_charge',
          amountMicros: cost,
          breakdown: {
            aiMicros: cost,
            inputTokens: out.usage.inputTokens,
            outputTokens: out.usage.outputTokens,
            model: deps.textModel,
            kind: deps.callId ? 'call' : 'flow_intent',
          },
          ref: deps.callId
            ? { type: 'call', id: deps.callId.toString() }
            : { type: 'usage', id: deps.runId.toString() },
          idempotencyKey: `aiintent:${deps.runId.toString()}:${inputId}`,
        });
      }
      return parseIntentReply(out.content, intents);
    },

    loadAudio: async (audioId) => {
      if (!Types.ObjectId.isValid(audioId)) return null;
      const audio = await FlowAudioModel.findOne({ _id: audioId, accountId: deps.accountId })
        .select({ name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }>();
      return audio ? { id: audio._id.toString(), name: audio.name } : null;
    },
  };
};
