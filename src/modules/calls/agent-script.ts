import { Types } from 'mongoose';

import type { AiSessionEnd, AiVoiceController } from '../../core/voice/ai-session';
import { AccountModel } from '../../db/models/account.model';
import { AiAgentModel, type AiAgentDoc } from '../../db/models/ai-agent.model';
import type { CallDoc, CallEndReason } from '../../db/models/call.model';
import { CallModel } from '../../db/models/call.model';
import { contactTemplateValues } from '../ai-agents/functions.service';
import { contactVariables, manualVariables } from '../ai-agents/variables';
import { accountTimezone } from '../wallet/wallet.service';

import type { ScriptChoice } from './scripts';
import type { CallIO, CallScript, ScriptResult } from './session';

interface AgentScriptDeps {
  controller: AiVoiceController;
  agent: AiAgentDoc;
  call: CallDoc;
  company: string;
  timezone: string;
  values: Record<string, string>;
  contact: Record<string, unknown>;
}

/** An agent-only call: one live AI conversation from the opening line to the end. */
export class AgentScript implements CallScript {
  private end: AiSessionEnd | null = null;
  private stopped = false;
  private stopSession: (() => void) | null = null;
  private running: Promise<AiSessionEnd> | null = null;

  constructor(private readonly deps: AgentScriptDeps) {}

  async run(io: CallIO): Promise<CallEndReason | void> {
    let audio: ((frame: Int16Array) => void) | null = null;
    let text: ((words: string) => void) | null = null;
    io.leg.onAudio((frame) => audio?.(frame));
    io.leg.onText((words) => text?.(words));
    io.leg.onDtmf(() => io.event('dtmf', {})); // agents talk; keys are only noted
    this.running = this.deps.controller.run({
      io,
      inputs: {
        setAudio: (fn) => (audio = fn),
        setText: (fn) => (text = fn),
        onStop: (fn) => (this.stopSession = fn),
      },
      agent: this.deps.agent,
      sessionId: this.deps.call._id,
      company: this.deps.company,
      timezone: this.deps.timezone,
      contact: this.deps.contact,
      values: this.deps.values,
      history: [],
      maxTurns: null,
      mode: 'agent',
    });
    this.end = await this.running;
    if (this.stopped) return;
    return this.end.callEnd;
  }

  /** Ends the live session and waits for its result (outcome, language, AI seconds). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopSession?.();
    if (this.running) this.end = await this.running;
  }

  result(): ScriptResult {
    const o = this.end?.outcome ?? {};
    return {
      outcome: { ...o },
      disposition: o.disposition ?? (o.promiseToPay ? 'promise_to_pay' : null),
      variables: this.deps.values,
      flowRunId: null,
      aiSeconds: this.end?.aiSeconds ?? 0,
      languageDetected: this.end?.language ?? null,
    };
  }
}

/** Builds the script of an agent-only call (allowed values from the contact or typed). */
export const agentScript = async (
  call: CallDoc,
  controller: AiVoiceController,
): Promise<ScriptChoice> => {
  const agent = await AiAgentModel.findOne({
    _id: call.source.agentId,
    accountId: call.accountId,
  }).lean<AiAgentDoc>();
  if (!agent) throw new Error('call agent not found');
  let values: Record<string, string>;
  let contact: Record<string, unknown>;
  if (call.contactId) {
    const found = await contactVariables(
      call.accountId,
      new Types.ObjectId(String(call.contactId)),
      agent.allowedVariables,
    );
    values = found.values;
    contact = contactTemplateValues(found.contact);
  } else {
    values = manualVariables(call.manualVariables ?? undefined, agent.allowedVariables);
    const withPhone = await CallModel.findById(call._id)
      .select({ testPhone: 1 })
      .lean<{ testPhone: string | null }>();
    const testPhone = withPhone?.testPhone ?? null;
    if (testPhone && agent.allowedVariables.includes('phone_last4') && !values.phone_last4) {
      values.phone_last4 = testPhone.slice(-4);
    }
    contact = testPhone ? { phone: testPhone, name: values.name ?? '' } : {};
  }
  const account = await AccountModel.findById(call.accountId)
    .select({ name: 1 })
    .lean<{ name: string }>();
  const script = new AgentScript({
    controller,
    agent,
    call,
    company: account?.name ?? '',
    timezone: await accountTimezone(call.accountId),
    values,
    contact,
  });
  return {
    script,
    voice: agent.voice,
    language: agent.language,
    maxDurationSec: agent.callBehaviour.maxCallDurationSec,
  };
};
