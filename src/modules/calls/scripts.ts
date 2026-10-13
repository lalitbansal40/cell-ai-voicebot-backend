import { flowTemplate } from '../../core/engine/variables';
import type { AiVoiceController } from '../../core/voice/ai-session';
import { AiAgentModel, type AiAgentDoc } from '../../db/models/ai-agent.model';
import type { CallDoc } from '../../db/models/call.model';
import { agentValues } from '../flows/effects';

import { agentScript } from './agent-script';
import { flowScript, type FlowScriptDeps } from './flow-script';
import type { CallScript } from './session';

export interface ScriptChoice {
  script: CallScript;
  voice: string;
  language: string;
  /** Flow `settings.maxDurationSec` / agent `maxCallDurationSec`. */
  maxDurationSec?: number;
}

export type ScriptFactory = (call: CallDoc) => Promise<ScriptChoice>;

/** Placeholder for processes without voice (tests that never attach a call). */
export const noScripts: ScriptFactory = () =>
  Promise.reject(new Error('No call scripts are available yet'));

/**
 * The program of a call: a flow (Phase 6 host, AI steps run live by the
 * controller) or an AI agent alone.
 */
export const createScriptFactory = (
  deps: Omit<FlowScriptDeps, 'runAi'> & { controller: AiVoiceController },
): ScriptFactory => {
  const runAi: FlowScriptDeps['runAi'] = async (request, ctx) => {
    const agent = await AiAgentModel.findOne({
      _id: request.config.agentId,
      accountId: ctx.call.accountId,
    }).lean<AiAgentDoc>();
    if (!agent) return { outcome: {}, reason: 'fallback', turns: 0, aiSeconds: 0, language: null };
    const values = agentValues(agent, request.config, request.values);
    const goal = request.config.goal
      ? flowTemplate.renderText(request.config.goal, { values: request.values }, new Set())
      : '';
    return deps.controller.run({
      io: request.io,
      inputs: request.inputs,
      agent,
      sessionId: ctx.runId,
      company: ctx.company,
      timezone: ctx.timezone,
      contact: ctx.contact.templateValues,
      values,
      ...(goal ? { goal } : {}),
      history: request.turns,
      maxTurns: request.config.maxTurns,
      mode: 'flow',
    });
  };
  return (call) =>
    call.source.kind === 'agent'
      ? agentScript(call, deps.controller)
      : flowScript(call, { ...deps, runAi });
};
