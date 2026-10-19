import type { Types } from 'mongoose';

import { CALL_LIMITS, CALL_LINES } from '../../config/limits';
import type { AiAgentDoc } from '../../db/models/ai-agent.model';
import type { CallEndReason } from '../../db/models/call.model';
import { chargeCallUsage } from '../../modules/calls/billing';
import type { BotStream, CallIO } from '../../modules/calls/session';
import { AppError } from '../../shared/errors/app-error';
import { assertAgentBudget } from '../ai/budget';
import { compileAgent, type CompiledAgent } from '../ai/compile';
import { FAKE_RULES } from '../ai/fake.provider';
import type { HttpToolOptions } from '../ai/http-tool';
import { embedCost } from '../ai/pricing';
import { searchKnowledgeBases } from '../ai/retrieve';
import { runAgentTurn } from '../ai/run-turn';
import { createToolRunner } from '../ai/tool-runner';
import type { BuiltInOutcome } from '../ai/tools';
import type { AiProvider, ToolDefinition } from '../ai/types';
import { effectiveRateCard } from '../billing/rates';
import { aiExitOf } from '../engine/nodes/ai-agent';
import type { AiTurnLite } from '../engine/types';

import type { AiInputs, AiStepEnd } from './flow-host';
import type {
  AiVoiceSession,
  RealtimeUsage,
  TurnDone,
  VoiceAiProvider,
  VoiceToolCall,
} from './providers/types';

/** Customer language from the words (Devanagari / Roman Hindi markers → `hi`). */
export const languageOf = (text: string): 'hi' | 'en' =>
  /[ऀ-ॿ]/.test(text) || FAKE_RULES.hinglishMarkers.test(text) ? 'hi' : 'en';

export const SEARCH_KNOWLEDGE_TOOL: ToolDefinition = {
  name: 'search_knowledge',
  description:
    "Search the company's documents for facts (policies, charges, process). Use it before answering factual questions.",
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What to look up, in a few words.' } },
    required: ['query'],
    additionalProperties: false,
  },
};

const STT_LANG: Record<string, string | null> = { hi: 'hi', en: 'en', hinglish: 'hi' };

export interface AiControllerDeps {
  voice: VoiceAiProvider;
  /** Text model (chat pipeline turns) + embeddings. */
  ai: AiProvider;
  embeddingModel: string;
  secretKey: Buffer;
  http: HttpToolOptions;
  now?: () => Date;
  /** `none` (dry runs): no wallet / cap gate and no knowledge charges. Default `charge`. */
  billing?: 'charge' | 'none';
}

export interface AiSessionRequest {
  io: CallIO;
  inputs: AiInputs;
  agent: AiAgentDoc;
  /** Flow run (flow step) or call (agent-only): tool logs + idempotency keys. */
  sessionId: Types.ObjectId;
  company: string;
  timezone: string;
  /** `{{contact.*}}` values for functions only — never sent to the model. */
  contact: Record<string, unknown>;
  /** Allowed variable values the model may see. */
  values: Record<string, string>;
  /** Flow step goal (rendered). */
  goal?: string;
  /** Turns so far (a flow step's opening line). */
  history: AiTurnLite[];
  /** Flow step `maxTurns`; null = until an outcome / end / limit. */
  maxTurns: number | null;
  /** `flow`: an outcome ends the step; `agent`: the call goes on until `end_call`. */
  mode: 'flow' | 'agent';
}

export interface AiSessionEnd extends AiStepEnd {
  /** Agent-only calls: what the call should end with. */
  callEnd: CallEndReason;
}

/**
 * Runs one live AI conversation on a call (PHASE_7_PLAN §1h). The provider only
 * moves audio, text and tool calls; this owns the opening line, tools, outcome,
 * barge-in bookkeeping, silence prompts, limits, fallbacks and `aiSeconds`.
 */
export class AiVoiceController {
  constructor(private readonly deps: AiControllerDeps) {}

  run(request: AiSessionRequest): Promise<AiSessionEnd> {
    return new LiveAiSession(this.deps, request).run();
  }
}

type EndReason = AiStepEnd['reason'];

class LiveAiSession {
  private session: AiVoiceSession | null = null;
  private compiled: CompiledAgent | null = null;
  private stream: BotStream | null = null;
  private botText = '';
  private readonly outcome: BuiltInOutcome = {};
  private readonly history: AiTurnLite[];
  private customerTurns = 0;
  private silenceRetries = 0;
  private silenceTimer: unknown = null;
  private durationTimer: unknown = null;
  private pendingTools: VoiceToolCall[] = [];
  private language: string | null = null;
  private readonly startedAt: number;
  private finished = false;
  private turnSeq = 0;
  private chain: Promise<void> = Promise.resolve();
  private resolve: (end: AiSessionEnd) => void = () => undefined;
  private transferTried = false;
  private callEnd: CallEndReason = 'agent_end_call';

  constructor(
    private readonly deps: AiControllerDeps,
    private readonly req: AiSessionRequest,
  ) {
    this.startedAt = req.io.clock.now();
    this.history = [...req.history];
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  run(): Promise<AiSessionEnd> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.req.inputs.onStop(() => void this.finish('outcome'));
      this.start().catch((err: unknown) => {
        this.req.io.logger.error({ err, callId: this.req.io.callId }, 'ai session: start failed');
        void this.fail();
      });
    });
  }

  private async start(): Promise<void> {
    const { io, agent, req } = { io: this.req.io, agent: this.req.agent, req: this.req };
    const compiled = compileAgent(agent, {
      company: req.company,
      variables: req.values,
      channel: 'voice',
      now: this.now(),
      timezone: req.timezone,
      ...(req.goal ? { extraInstructions: req.goal } : {}),
    });
    this.compiled = compiled;
    if (!agent.isActive) return this.fallbackEnd(compiled.fallbacks.agentOff, 'ai_failed');
    if (!(await this.budgetOk())) return;
    const realtime = this.deps.voice.pipeline === 'realtime';
    const tools = realtime
      ? [
          ...compiled.tools,
          ...(agent.knowledge.knowledgeBaseIds.length ? [SEARCH_KNOWLEDGE_TOOL] : []),
        ]
      : [];
    io.event('ai_session_started', { mode: req.mode, pipeline: this.deps.voice.pipeline });
    let session: AiVoiceSession;
    try {
      session = await this.deps.voice.open({
        instructions: compiled.instructions,
        voice: agent.voice,
        tools,
        bargeIn: agent.callBehaviour.bargeIn,
        rate: io.leg.rate,
        language: agent.languageMode === 'auto' ? null : (STT_LANG[agent.language] ?? null),
        speechLanguage: compiled.language,
        ...(realtime ? {} : { turn: (text: string) => this.chatTurn(text) }),
      });
    } catch (err) {
      io.logger.warn({ err, callId: io.callId }, 'ai session: open failed');
      return this.fallbackEnd(compiled.fallbacks.aiFailed, 'ai_failed');
    }
    if (this.finished) {
      await session.close();
      return;
    }
    this.session = session;
    this.listen(session);
    this.req.inputs.setAudio((frame) => {
      // barge-in off: the customer is not heard while the bot speaks
      if (!agent.callBehaviour.bargeIn && (this.stream || io.leg.playing)) return;
      session.sendAudio(frame);
    });
    this.req.inputs.setText((text) => {
      io.customerDone();
      session.sendText(text);
    });
    if (req.mode === 'flow') {
      const left = agent.callBehaviour.maxCallDurationSec * 1000 - io.elapsedMs();
      this.durationTimer = io.clock.setTimeout(() => io.end('max_duration'), Math.max(0, left));
    }
    if (req.mode === 'agent' && compiled.openingLine) session.say(compiled.openingLine);
    else this.armSilence();
  }

  private listen(session: AiVoiceSession): void {
    const io = this.req.io;
    session.on('speech_started', () => {
      this.clearSilence();
      // the reply may still be playing after the provider finished it (bot_done)
      if (this.req.agent.callBehaviour.bargeIn && io.leg.playing) io.interrupt();
    });
    session.on('speech_stopped', () => io.customerDone());
    session.on('customer_transcript', ({ text, final, language }) => {
      if (!final) {
        io.partial('customer', text);
        return;
      }
      this.language = language ?? languageOf(text);
      io.transcript('customer', text, { source: 'stt', language: this.language });
      this.customerTurns += 1;
      this.silenceRetries = 0;
      this.clearSilence();
      if (session.kind === 'realtime') void this.enqueue(() => this.realtimeTurnGate());
    });
    session.on('bot_audio', (pcm) => {
      this.clearSilence();
      if (this.finished) return;
      this.stream ??= io.stream('ai');
      this.stream.push(pcm);
    });
    session.on('bot_transcript', ({ text }) => {
      this.botText = this.botText ? `${this.botText} ${text}` : text;
    });
    session.on('tool_call', (call) => this.pendingTools.push(call));
    session.on('turn_done', (turn) => this.turnDone(turn));
    session.on('usage', (usage) => this.addUsage(usage));
    session.on('bot_done', () => void this.enqueue(() => this.botDone()));
    session.on('error', ({ code, fatal }) => {
      io.event('error', { code, where: 'ai_session' });
      if (fatal || code === 'ai_failed' || code === 'tts_failed') void this.fail();
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(work).catch((err: unknown) => {
      this.req.io.logger.error({ err, callId: this.req.io.callId }, 'ai session: step failed');
      void this.fail();
    });
    return this.chain;
  }

  /** The customer spoke (Realtime): caps and wallet before the model answers. */
  private async realtimeTurnGate(): Promise<void> {
    if (this.finished) return;
    await this.budgetOk();
  }

  /** False (and the session ended with the right fallback) when caps / wallet stop the AI. */
  private async budgetOk(): Promise<boolean> {
    if (this.deps.billing === 'none') return true;
    const { agent } = this.req;
    const budget = await assertAgentBudget({
      accountId: agent.accountId,
      agent,
      now: this.now(),
      timezone: this.req.timezone,
    });
    if (budget.ok) return true;
    const fallbacks = (this.compiled as CompiledAgent).fallbacks;
    if (budget.reason === 'wallet_empty') {
      await this.fallbackEnd(fallbacks.walletEmpty, 'wallet_empty');
    } else {
      await this.fallbackEnd(
        agent.limits.onCap === 'stop' ? '' : fallbacks.capReached,
        'ai_failed',
      );
    }
    return false;
  }

  private pendingEnd: [EndReason, CallEndReason] | null = null;

  private turnDone(turn: TurnDone): void {
    Object.assign(this.outcome, turn.outcome);
    if (Object.keys(turn.outcome).length)
      this.req.io.event('ai_outcome', outcomeEvent(turn.outcome));
    for (const call of turn.toolCalls) {
      this.req.io.event('ai_function_result', { name: call.name, ok: call.ok });
    }
    if (turn.fallback === 'walletEmpty') this.pendingEnd = ['fallback', 'wallet_empty'];
    else if (turn.fallback) this.pendingEnd = ['fallback', 'ai_failed'];
    else if (turn.ended) this.pendingEnd = ['end_call', 'agent_end_call'];
  }

  /** One agent turn for the chat pipeline (tools, knowledge, guardrails inside). */
  private async chatTurn(text: string): Promise<TurnDone> {
    const { agent, io } = this.req;
    this.turnSeq += 1;
    const seq = this.turnSeq;
    const compiled = this.compiled as CompiledAgent;
    try {
      const result = await runAgentTurn({
        accountId: agent.accountId,
        agent,
        session: { _id: this.req.sessionId, turns: this.history, variables: this.req.values },
        userText: text,
        clientTurnId: `${io.callId}:t${String(seq)}`,
        provider: this.deps.ai,
        now: this.now(),
        timezone: this.req.timezone,
        company: this.req.company,
        contact: this.req.contact,
        secretKey: this.deps.secretKey,
        http: this.deps.http,
        embeddingModel: this.deps.embeddingModel,
        budgetCheck: this.deps.billing !== 'none',
        source: 'call',
        channel: 'voice',
        billing: 'none',
        builtInMode: 'live',
        ...(this.req.goal ? { extraInstructions: this.req.goal } : {}),
      });
      await this.chargeEmbedding(result.embeddingTokens ?? 0, `emb:t${String(seq)}`);
      this.history.push(
        { role: 'user', text, clientTurnId: `${io.callId}:t${String(seq)}` },
        { role: 'assistant', text: result.turn.text, clientTurnId: `${io.callId}:t${String(seq)}` },
      );
      return {
        text: result.turn.text,
        outcome: result.outcome,
        ended: result.ended,
        fallback: result.turn.fallback,
        toolCalls: result.turn.toolCalls.map((c) => ({ name: c.name, ok: c.ok })),
      };
    } catch (err) {
      if (err instanceof AppError && err.code === 'AI_SPEND_CAP_REACHED') {
        return {
          text: '',
          outcome: {},
          ended: false,
          fallback: 'capReached',
          toolCalls: [],
        };
      }
      io.logger.warn({ err, callId: io.callId }, 'ai session: turn failed');
      return {
        text: compiled.fallbacks.aiFailed,
        outcome: {},
        ended: false,
        fallback: 'aiFailed',
        toolCalls: [],
      };
    }
  }

  private async chargeEmbedding(tokens: number, key: string): Promise<void> {
    if (tokens <= 0 || this.deps.billing === 'none') return;
    const card = await effectiveRateCard(this.req.agent.accountId);
    const amountMicros = embedCost(card, tokens);
    if (amountMicros <= 0) return;
    await chargeCallUsage({
      accountId: this.req.agent.accountId.toString(),
      callId: this.req.io.callId,
      key,
      amountMicros,
      embeddingTokens: tokens,
      model: this.deps.embeddingModel,
    }).catch(() => undefined); // an empty wallet ends the call through the hold check
  }

  /** The bot finished a reply: transcript, barge-in truncate, tools, end rules, silence. */
  private async botDone(): Promise<void> {
    if (this.finished) return;
    const io = this.req.io;
    const session = this.session as AiVoiceSession;
    const stream = this.stream;
    const text = this.botText;
    this.stream = null;
    this.botText = '';
    if (stream) {
      const played = await stream.finish(text, this.language);
      if (!played.completed) session.truncate(played.playedMs);
    } else if (text) {
      io.transcript('bot', text, { source: 'ai', language: this.language });
    }
    if (this.finished) return;
    if (session.kind === 'chat' && text) io.metrics.ttsChars += text.length;
    if (this.pendingTools.length) {
      const calls = this.pendingTools.splice(0);
      session.submitToolResults(await this.runTools(calls));
      return; // the model goes on with the results
    }
    if (this.pendingEnd) {
      const [reason, callEnd] = this.pendingEnd;
      this.callEnd = callEnd;
      if (callEnd === 'wallet_empty') io.end('wallet_empty');
      return this.finish(reason);
    }
    if (this.req.mode === 'flow') {
      if (this.outcome.endRequested) return this.finish('end_call');
      if (aiExitOf({ outcome: this.outcome, ended: false })) return this.finish('outcome');
    } else {
      if (this.outcome.endRequested) return this.finish('end_call');
      if (this.outcome.transferRequested && !this.transferTried) {
        this.transferTried = true;
        if (await this.transfer()) return this.finish('outcome');
      }
    }
    if (this.req.maxTurns !== null && this.customerTurns >= this.req.maxTurns) {
      return this.finish('max_turns');
    }
    this.armSilence();
  }

  /** Realtime tool calls: built-ins / functions via the shared runner, knowledge search here. */
  private async runTools(calls: VoiceToolCall[]): Promise<{ callId: string; output: string }[]> {
    const { agent, io } = this.req;
    const runner = createToolRunner({
      accountId: agent.accountId,
      agent,
      sessionId: this.req.sessionId,
      source: 'call',
      now: this.now(),
      timezone: this.req.timezone,
      company: this.req.company,
      contact: this.req.contact,
      secretKey: this.deps.secretKey,
      http: this.deps.http,
      builtInMode: 'live',
    });
    const results: { callId: string; output: string }[] = [];
    for (const [i, call] of calls.entries()) {
      io.event('ai_function_call', { name: call.name.slice(0, 60) });
      let output: string;
      if (i >= CALL_LIMITS.functionCallsPerTurn) {
        output = JSON.stringify({ ok: false, error: 'too_many_tool_calls' });
      } else if (call.name === SEARCH_KNOWLEDGE_TOOL.name) {
        output = await this.searchKnowledge(call.args);
      } else {
        output = await runner.run({ id: call.callId, name: call.name, arguments: call.args });
      }
      const ok = !output.startsWith('{"ok":false');
      io.event('ai_function_result', { name: call.name.slice(0, 60), ok });
      results.push({ callId: call.callId, output });
    }
    await runner.flush();
    if (Object.keys(runner.outcome).length) {
      Object.assign(this.outcome, runner.outcome);
      io.event('ai_outcome', outcomeEvent(runner.outcome));
    }
    return results;
  }

  private async searchKnowledge(args: string): Promise<string> {
    const { agent } = this.req;
    let query = '';
    try {
      const parsed = JSON.parse(args) as { query?: unknown };
      query = typeof parsed.query === 'string' ? parsed.query : '';
    } catch {
      return JSON.stringify({ ok: false, error: 'invalid_arguments' });
    }
    if (!query.trim()) return JSON.stringify({ ok: false, error: 'invalid_arguments' });
    const found = await searchKnowledgeBases(
      agent.accountId,
      agent.knowledge.knowledgeBaseIds,
      query.slice(0, 500),
      { topK: agent.knowledge.topK, minScore: agent.knowledge.minScoreHundredths / 100 },
      { provider: this.deps.ai, model: this.deps.embeddingModel },
    );
    this.turnSeq += 1;
    await this.chargeEmbedding(found.embeddingTokens, `emb:k${String(this.turnSeq)}`);
    return JSON.stringify({
      ok: true,
      results: found.hits.map((h) => ({ title: h.title, text: h.text })),
    });
  }

  /** Agent-only `transfer_to_human`: the tester answers in the browser. */
  private async transfer(): Promise<boolean> {
    const { io, agent } = this.req;
    const phone = agent.builtInTools.transferToHuman.phone ?? '';
    const last4 = phone.replace(/\D/g, '').slice(-4);
    io.event('transfer', { phoneLast4: last4 });
    const result = await io.leg.transfer(last4, CALL_LIMITS.transferAnswerSec);
    if (result !== 'connected') return false;
    this.callEnd = 'transferred';
    return true;
  }

  private addUsage(usage: RealtimeUsage): void {
    const m = this.req.io.metrics.realtime;
    m.inputAudioTokens += usage.inputAudioTokens;
    m.outputAudioTokens += usage.outputAudioTokens;
    m.inputTextTokens += usage.inputTextTokens;
    m.outputTextTokens += usage.outputTextTokens;
    m.cachedTokens += usage.cachedTokens;
  }

  private armSilence(): void {
    if (this.finished) return;
    this.clearSilence();
    const { io, agent } = this.req;
    this.silenceTimer = io.clock.setTimeout(() => {
      this.silenceTimer = null;
      if (this.finished) return;
      if (this.silenceRetries >= agent.callBehaviour.endCallAfterSilenceRetries) {
        void this.finish('no_response');
        return;
      }
      this.silenceRetries += 1;
      io.metrics.silencePrompts += 1;
      io.event('silence_prompt', { attempt: this.silenceRetries });
      this.session?.say(this.language === 'en' ? CALL_LINES.silenceEn : CALL_LINES.silenceHi);
      // re-armed here too: a prompt the provider never answers must not hang the step
      this.armSilence();
    }, agent.callBehaviour.silenceTimeoutSec * 1000);
  }

  private clearSilence(): void {
    if (this.silenceTimer !== null) this.req.io.clock.clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  /** Provider failure: the agent's "AI failed" line, then the session ends `fallback`. */
  private async fail(): Promise<void> {
    if (this.finished) return;
    const text = this.compiled?.fallbacks.aiFailed ?? '';
    await this.fallbackEnd(text, 'ai_failed');
  }

  private async fallbackEnd(text: string, callEnd: CallEndReason): Promise<void> {
    if (this.finished) return;
    const { io } = this.req;
    this.callEnd = callEnd;
    await this.closeSession();
    if (text && !io.ended) {
      if (io.leg.playing) io.interrupt();
      await io.say(text, { source: 'ai', interruptible: false }).catch(() => undefined);
    }
    if (callEnd === 'wallet_empty') io.end('wallet_empty');
    await this.finish('fallback');
  }

  private async closeSession(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.req.inputs.setAudio(null);
    this.req.inputs.setText(null);
    if (session) await session.close().catch(() => undefined);
  }

  private async finish(reason: EndReason): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const { io } = this.req;
    this.clearSilence();
    if (this.durationTimer !== null) io.clock.clearTimeout(this.durationTimer);
    const stream = this.stream;
    this.stream = null;
    if (stream) await stream.finish(this.botText, this.language);
    await this.closeSession();
    const aiSeconds = Math.round((io.clock.now() - this.startedAt) / 1000);
    io.event('ai_session_ended', { reason, turns: this.customerTurns, aiSeconds });
    this.resolve({
      outcome: { ...this.outcome },
      reason,
      turns: this.customerTurns,
      aiSeconds,
      language: this.language,
      callEnd: this.callEnd,
    });
  }
}

/** Outcome event data without free text (dates and amounts are not personal). */
const outcomeEvent = (o: BuiltInOutcome): Record<string, unknown> => ({
  ...(o.disposition ? { disposition: o.disposition } : {}),
  ...(o.promiseToPay ? { promiseToPay: true } : {}),
  ...(o.callback ? { callback: true } : {}),
  ...(o.transferRequested ? { transfer: true } : {}),
  ...(o.endRequested ? { end: true } : {}),
  ...(o.smsTemplate ? { smsTemplate: o.smsTemplate } : {}),
});
