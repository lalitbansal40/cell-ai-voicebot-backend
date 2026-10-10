import type { NodeHandler, NodeRuntime, Step } from '../runtime';
import { DEFAULT_NO_INPUT_TEXT } from '../schema';
import type { AiTurnResult } from '../types';

const MAX_SILENT_TURNS = 2;

const wait = (nodeId: string, rt: NodeRuntime): Step => {
  rt.push({ type: 'listen_speech', nodeId, timeoutSec: 8, language: rt.settings.language });
  return { wait: { kind: 'ai', nodeId } };
};

/** Copies a turn's outcome to the run (outcome + system variables + queued SMS). */
const applyOutcome = (nodeId: string, outcome: AiTurnResult['outcome'], rt: NodeRuntime) => {
  const o = rt.state.outcome;
  if (outcome.disposition) {
    o.disposition = outcome.disposition;
    rt.setVar('disposition', outcome.disposition);
  }
  if (outcome.promiseToPay) {
    o.promiseToPay = outcome.promiseToPay;
    rt.setVar('promise_date', outcome.promiseToPay.date);
    rt.setVar('promise_amount', outcome.promiseToPay.amountMicros);
    if (!o.disposition) {
      o.disposition = 'promise_to_pay';
      rt.setVar('disposition', 'promise_to_pay');
    }
  }
  if (outcome.callback) {
    o.callback = outcome.callback;
    rt.setVar('callback_date', outcome.callback.date);
    rt.setVar('callback_time', outcome.callback.time);
  }
  if (outcome.smsTemplate) {
    o.messages.push({
      channel: 'sms',
      nodeId,
      text: null,
      templateName: outcome.smsTemplate,
      language: null,
      params: [],
      dltTemplateId: null,
      queuedAt: rt.ctx.now().toISOString(),
    });
  }
};

/** First match wins (PHASE_6_PLAN §1g). */
export const aiExitOf = (result: Pick<AiTurnResult, 'outcome' | 'ended'>): string | null => {
  const o = result.outcome;
  if (o.transferRequested) return 'transfer';
  if (o.disposition === 'paid') return 'paid';
  if (o.promiseToPay) return 'promise_to_pay';
  if (o.callback) return 'callback';
  if (o.disposition === 'wrong_number') return 'wrong_number';
  if (o.endRequested || result.ended) return 'resolved';
  return null;
};

/** A Phase 5 agent talks; its outcome picks the exit. */
export const aiAgentNode: NodeHandler<'ai_agent'> = {
  enter: async (node, rt) => {
    const start = await rt.effects.aiStart({
      nodeId: node.id,
      config: node.config,
      values: rt.values(),
    });
    if (!start.ok) {
      if (start.text) {
        rt.push({
          type: 'ai_reply',
          nodeId: node.id,
          text: start.text,
          toolCalls: [],
          knowledge: [],
          costMicros: 0,
          fallback: start.reason,
          guardrail: null,
        });
      }
      return rt.fail(node.id, `AI agent unavailable (${start.reason ?? 'unknown'})`);
    }
    rt.state.ai = {
      nodeId: node.id,
      agentId: node.config.agentId,
      turns: [],
      turnCount: 0,
      noInputs: 0,
    };
    if (node.config.speakOpeningLine && start.text) {
      rt.state.ai.turns.push({ role: 'assistant', text: start.text, clientTurnId: null });
      rt.push({
        type: 'ai_reply',
        nodeId: node.id,
        text: start.text,
        toolCalls: [],
        knowledge: [],
        costMicros: 0,
        fallback: null,
        guardrail: null,
      });
    }
    return wait(node.id, rt);
  },
  input: async (node, input, rt) => {
    const ai = rt.state.ai;
    if (!ai) return rt.fail(node.id, 'AI session missing');
    const text = input.kind === 'speech' ? input.text.trim() : '';
    if (!text) {
      ai.noInputs += 1;
      if (ai.noInputs >= MAX_SILENT_TURNS) {
        rt.state.ai = null;
        return { exit: 'no_response' };
      }
      rt.say(node.id, DEFAULT_NO_INPUT_TEXT);
      return wait(node.id, rt);
    }
    ai.noInputs = 0;
    const result = await rt.effects.aiTurn({
      nodeId: node.id,
      config: node.config,
      values: rt.values(),
      turns: ai.turns,
      userText: text,
      inputId: rt.inputId,
    });
    ai.turns.push({ role: 'user', text, clientTurnId: rt.inputId });
    ai.turns.push({ role: 'assistant', text: result.text, clientTurnId: rt.inputId });
    ai.turnCount += 1;
    rt.push({
      type: 'ai_reply',
      nodeId: node.id,
      text: result.text,
      toolCalls: result.toolCalls,
      knowledge: result.knowledge,
      costMicros: result.costMicros,
      fallback: result.fallback,
      guardrail: result.guardrail,
    });
    if (result.fallback) {
      rt.state.ai = null;
      return rt.fail(node.id, `AI fallback: ${result.fallback}`);
    }
    applyOutcome(node.id, result.outcome, rt);
    const exit = aiExitOf(result);
    if (exit) {
      rt.state.ai = null;
      return { exit };
    }
    if (ai.turnCount >= node.config.maxTurns) {
      rt.state.ai = null;
      return { exit: 'no_response' };
    }
    return wait(node.id, rt);
  },
};
