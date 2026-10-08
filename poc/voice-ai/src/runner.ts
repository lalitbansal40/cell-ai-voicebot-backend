/**
 * Automated Voice AI PoC runner (T0.15).
 *
 *   npm run run -- --scenarios all|01,05,07 --modes pcm24k,g711_ulaw \
 *                  --models gpt-realtime-2.1-mini,gpt-realtime-2.1 --voices marin [--resume <runId>]
 *
 * Customer speech is synthesised with TTS and streamed in real time (20 ms frames),
 * so server VAD, latency and barge-in behave like a live call.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  concat,
  durationMs,
  frames,
  isSilent,
  mixNoise,
  resample,
  rms,
  SAMPLE_RATE_REALTIME,
  silence,
  wavFromPcm16,
  whiteNoise,
  type Pcm16,
} from './audio.ts';
import { assertBudget, BudgetExceededError, recordSpend, spentUsd } from './budget.ts';
import type { CheckResult } from './checks.ts';
import { config, OUTPUT_DIR, requireApiKey, TRANSCRIBE_MODEL } from './config.ts';
import { ServerEvent } from './events.ts';
import { checkPaymentStatus, type PaymentState } from './mock-tools.ts';
import { buildInstructions, DEFAULT_VARIABLES, tools } from './persona.ts';
import { transcriptionCostUsd } from './pricing.ts';
import {
  modeRate,
  RealtimeSession,
  type AudioMode,
  type ResponseRecord,
} from './realtime-client.ts';
import {
  findScenarios,
  type RunContext,
  type Scenario,
  type Turn,
  type TurnResult,
} from './scenarios.ts';
import { synthesize } from './tts.ts';

// ── CLI ───────────────────────────────────────────────────────────────────
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const list = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const CUSTOMER_VOICE = 'ash';
const CUSTOMER_GAP_MS = 600; // pause after the bot finishes before the customer speaks
const TRAILING_SILENCE_MS = 1500; // lets server VAD detect end of speech
const TURN_TIMEOUT_MS = 60_000;

interface Placement {
  t: number;
  pcm: Pcm16;
}

// ── Helpers ───────────────────────────────────────────────────────────────
const playbackEnd = (r: ResponseRecord, rate: number): number =>
  r.firstAudioAt === undefined ? r.createdAt : r.firstAudioAt + durationMs(r.audioSamples, rate);

/** Streams audio in real time. Returns when the last non-silent frame was sent. */
const streamAudio = async (
  session: RealtimeSession,
  pcm: Pcm16,
  rate: number,
  placements: Placement[],
): Promise<{ startedAt: number; lastVoicedAt: number }> => {
  const startedAt = session.now();
  placements.push({ t: startedAt, pcm });
  let lastVoicedAt = startedAt;
  const chunks = frames(pcm, rate);
  for (let i = 0; i < chunks.length; i += 1) {
    const due = startedAt + i * 20;
    const wait = due - session.now();
    if (wait > 0) await sleep(wait);
    const frame = chunks[i] as Pcm16;
    session.appendAudio(frame);
    if (!isSilent(frame)) lastVoicedAt = session.now();
  }
  return { startedAt, lastVoicedAt };
};

/**
 * Waits until every response created after `afterT` is done, answering
 * function calls with the mock payment API along the way.
 */
const waitForBotTurn = async (
  session: RealtimeSession,
  payment: PaymentState,
  afterT: number,
  timeoutMs = TURN_TIMEOUT_MS,
): Promise<ResponseRecord[]> => {
  const handled = new Set<string>();
  const deadline = session.now() + timeoutMs;
  while (session.now() < deadline) {
    const turn = [...session.responses.values()]
      .filter((r) => r.createdAt >= afterT)
      .sort((a, b) => a.createdAt - b.createdAt);
    const last = turn.at(-1);
    let answeredTool = false;
    for (const r of turn) {
      if (r.status && r.functionCalls.length && !handled.has(r.id)) {
        handled.add(r.id);
        for (const fc of r.functionCalls) {
          let customerId = DEFAULT_VARIABLES.customerId;
          try {
            customerId =
              (JSON.parse(fc.arguments) as { customerId?: string }).customerId ?? customerId;
          } catch {
            /* keep default */
          }
          session.sendFunctionOutput(fc.callId, checkPaymentStatus(customerId, payment));
        }
        session.requestResponse();
        answeredTool = true;
      }
    }
    if (
      !answeredTool &&
      last?.status &&
      turn.every((r) => r.status) &&
      !last.functionCalls.length
    ) {
      return turn;
    }
    await sleep(50);
  }
  throw new Error(`Bot turn did not finish within ${timeoutMs} ms`);
};

const prepareCustomerAudio = async (
  turn: Turn,
  rate: number,
): Promise<{ preRoll?: Pcm16; speech: Pcm16 }> => {
  let speech = await synthesize({
    text: turn.text,
    voice: CUSTOMER_VOICE,
    instructions: turn.voiceInstructions,
  });
  let preRoll: Pcm16 | undefined;
  if (turn.noiseSnrDb !== undefined) {
    speech = mixNoise(speech, SAMPLE_RATE_REALTIME, turn.noiseSnrDb);
    const noiseRms = rms(speech) / 10 ** (turn.noiseSnrDb / 20);
    preRoll = resample(
      whiteNoise(2000, SAMPLE_RATE_REALTIME, noiseRms, 7),
      SAMPLE_RATE_REALTIME,
      rate,
    );
  }
  return { preRoll, speech: resample(speech, SAMPLE_RATE_REALTIME, rate) };
};

const mixTimeline = (placements: Placement[], rate: number, totalMs: number): Pcm16 => {
  const out = new Float32Array(Math.ceil((totalMs / 1000) * rate) + rate);
  for (const p of placements) {
    const start = Math.max(0, Math.round((p.t / 1000) * rate));
    for (let i = 0; i < p.pcm.length && start + i < out.length; i += 1) {
      out[start + i] = (out[start + i] ?? 0) + (p.pcm[i] ?? 0);
    }
  }
  const pcm = new Int16Array(out.length);
  for (let i = 0; i < out.length; i += 1)
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(out[i] ?? 0)));
  return pcm;
};

const percentile = (values: number[], p: number): number | undefined => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

// ── One scenario run ──────────────────────────────────────────────────────
const runScenario = async (
  scenario: Scenario,
  mode: AudioMode,
  model: string,
  voice: string,
  outDir: string,
): Promise<void> => {
  const rate = modeRate(mode);
  const variables = { ...DEFAULT_VARIABLES, ...scenario.variables };
  const customerAudio = await Promise.all(scenario.turns.map((t) => prepareCustomerAudio(t, rate)));

  const session = await RealtimeSession.connect({
    model,
    voice,
    mode,
    instructions: buildInstructions(variables),
    tools,
    vad: scenario.idleTimeoutMs ? { idleTimeoutMs: scenario.idleTimeoutMs } : undefined,
  });

  const placements: Placement[] = [];
  const ctx: RunContext = { session, turns: [], silenceResponses: [], falseTriggers: 0 };
  let customerAudioMs = 0;
  let aborted: string | undefined;

  try {
    session.startGreeting();
    const firstTurn = scenario.turns[0];
    const bargeIn = firstTurn?.bargeInAfterMs !== undefined;
    let cursor: number;

    if (bargeIn) {
      // Wait only until the greeting audio starts, then interrupt it.
      const deadline = session.now() + TURN_TIMEOUT_MS;
      while (session.now() < deadline) {
        const g = [...session.responses.values()][0];
        if (g?.firstAudioAt !== undefined) break;
        await sleep(20);
      }
      ctx.greeting = [...session.responses.values()][0];
      cursor = (ctx.greeting?.firstAudioAt ?? session.now()) + (firstTurn?.bargeInAfterMs ?? 0);
    } else {
      const greetingTurn = await waitForBotTurn(session, scenario.payment, 0);
      ctx.greeting = greetingTurn[0];
      cursor = Math.max(...greetingTurn.map((r) => playbackEnd(r, rate))) + CUSTOMER_GAP_MS;
    }

    if (scenario.silenceAfterGreetingMs) {
      const wait = cursor - session.now();
      if (wait > 0) await sleep(wait);
      const silenceStart = session.now();
      await streamAudio(session, silence(scenario.silenceAfterGreetingMs, rate), rate, placements);
      const later = [...session.responses.values()].filter((r) => r.createdAt >= silenceStart);
      if (later.length)
        await waitForBotTurn(session, scenario.payment, silenceStart).catch(() => undefined);
      ctx.silenceResponses = [...session.responses.values()].filter(
        (r) => r.createdAt >= silenceStart,
      );
    }

    for (let i = 0; i < scenario.turns.length; i += 1) {
      const turn = scenario.turns[i] as Turn;
      const audio = customerAudio[i] as { preRoll?: Pcm16; speech: Pcm16 };
      const wait = cursor - session.now();
      if (wait > 0) await sleep(wait);

      if (audio.preRoll) {
        const before = session.speechStarted.length;
        await streamAudio(session, audio.preRoll, rate, placements);
        ctx.falseTriggers += session.speechStarted.length - before;
      }

      // Barge-in: truncate the bot's playing item when the customer starts talking.
      const onSpeech = (e: { type: string }) => {
        if (e.type !== ServerEvent.SpeechStarted) return;
        const playing = [...session.responses.values()].find(
          (r) => r.firstAudioAt !== undefined && r.itemId && session.now() < playbackEnd(r, rate),
        );
        if (playing?.itemId && playing.firstAudioAt !== undefined) {
          session.truncate(playing.itemId, session.now() - playing.firstAudioAt);
        }
      };
      session.on('event', onSpeech);

      const { startedAt, lastVoicedAt } = await streamAudio(
        session,
        audio.speech,
        rate,
        placements,
      );
      await streamAudio(session, silence(TRAILING_SILENCE_MS, rate), rate, placements);
      session.off('event', onSpeech);
      customerAudioMs += durationMs(audio.speech.length + (audio.preRoll?.length ?? 0), rate);

      const responses = await waitForBotTurn(session, scenario.payment, startedAt);
      const firstAudio = responses.map((r) => r.firstAudioAt).find((t) => t !== undefined);
      const lastStop = session.speechStopped.filter((t) => t >= startedAt).at(-1);
      const result: TurnResult = {
        turn,
        startedAt,
        customerEndAt: lastVoicedAt,
        responses,
        botText: responses
          .map((r) => r.transcript)
          .filter(Boolean)
          .join(' '),
        latencyMs: firstAudio !== undefined ? Math.round(firstAudio - lastVoicedAt) : undefined,
        vadLatencyMs:
          firstAudio !== undefined && lastStop !== undefined
            ? Math.round(firstAudio - lastStop)
            : undefined,
      };
      ctx.turns.push(result);
      cursor = Math.max(...responses.map((r) => playbackEnd(r, rate))) + CUSTOMER_GAP_MS;

      assertBudget(session.costUsd + transcriptionCostUsd(TRANSCRIBE_MODEL, customerAudioMs));
    }
  } catch (err) {
    aborted = err instanceof Error ? err.message : String(err);
    if (err instanceof BudgetExceededError) console.error(`⛔ ${aborted}`);
  } finally {
    session.close();
  }

  // ── Results ──
  const transcribeUsd = transcriptionCostUsd(TRANSCRIBE_MODEL, customerAudioMs);
  const totalUsd = session.costUsd + transcribeUsd;
  recordSpend(`${scenario.id}/${mode}/${model}/${voice}`, totalUsd);

  let checks: CheckResult[] = [];
  try {
    checks = scenario.checks(ctx);
  } catch (err) {
    checks = [{ name: 'checks crashed', pass: false, detail: String(err) }];
  }

  const botPlacements: Placement[] = [...session.responses.values()]
    .filter((r) => r.firstAudioAt !== undefined)
    .map((r) => ({ t: r.firstAudioAt as number, pcm: concat(...r.audio) }));
  const callMs = session.now();

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, 'customer.wav'),
    wavFromPcm16(mixTimeline(placements, rate, callMs), rate),
  );
  writeFileSync(
    path.join(outDir, 'bot.wav'),
    wavFromPcm16(concat(...botPlacements.map((p) => p.pcm)), rate),
  );
  writeFileSync(
    path.join(outDir, 'conversation.wav'),
    wavFromPcm16(mixTimeline([...placements, ...botPlacements], rate, callMs), rate),
  );
  writeFileSync(
    path.join(outDir, 'events.jsonl'),
    session.log.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );

  const lines = [`# ${scenario.title}`, '', `mode=${mode} model=${model} voice=${voice}`, ''];
  if (ctx.greeting)
    lines.push(`**Bot:** ${ctx.greeting.transcript} _(status: ${ctx.greeting.status})_`, '');
  for (const r of ctx.silenceResponses) lines.push(`**Bot (silence):** ${r.transcript}`, '');
  for (const t of ctx.turns) {
    lines.push(`**Customer (${t.turn.lang}):** ${t.turn.text}`, '');
    for (const r of t.responses) {
      for (const f of r.functionCalls) lines.push(`_tool:_ \`${f.name}(${f.arguments})\``, '');
      if (r.transcript) lines.push(`**Bot:** ${r.transcript}`, '');
    }
    lines.push(
      `_latency: ${t.latencyMs ?? 'n/a'} ms (after VAD stop: ${t.vadLatencyMs ?? 'n/a'} ms)_`,
      '',
    );
  }
  writeFileSync(path.join(outDir, 'transcript.md'), lines.join('\n'));

  const latencies = ctx.turns.map((t) => t.latencyMs).filter((x): x is number => x !== undefined);
  const summary = {
    scenarioId: scenario.id,
    title: scenario.title,
    mode,
    model,
    voice,
    finishedAt: new Date().toISOString(),
    callMs: Math.round(callMs),
    aborted,
    errors: session.errors,
    costUsd: { realtime: session.costUsd, transcription: transcribeUsd, total: totalUsd },
    costPerMinUsd: callMs > 0 ? totalUsd / (callMs / 60_000) : 0,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), all: latencies },
    greeting: ctx.greeting
      ? { status: ctx.greeting.status, transcript: ctx.greeting.transcript }
      : undefined,
    turns: ctx.turns.map((t) => ({
      customer: t.turn.text,
      lang: t.turn.lang,
      bot: t.botText,
      latencyMs: t.latencyMs,
      vadLatencyMs: t.vadLatencyMs,
      functionCalls: t.responses.flatMap((r) => r.functionCalls),
    })),
    checks,
    passed: checks.filter((c) => c.pass).length,
    total: checks.length,
  };
  writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.info(
    `${aborted ? '⚠️' : '✅'} ${scenario.id} [${mode}/${model}/${voice}] checks ${summary.passed}/${summary.total}, ` +
      `p50 ${summary.latencyMs.p50 ?? '-'} ms, $${totalUsd.toFixed(4)} (total spent $${spentUsd().toFixed(4)})`,
  );
  if (aborted) console.info(`   aborted: ${aborted}`);
};

// ── Main ──────────────────────────────────────────────────────────────────
const main = async (): Promise<void> => {
  requireApiKey();
  const scenarios = findScenarios(arg('scenarios', 'all'));
  const modes = list(arg('modes', 'pcm24k,g711_ulaw')) as AudioMode[];
  const models = list(arg('models', config.model));
  const voices = list(arg('voices', 'marin'));
  const runId = arg('resume', new Date().toISOString().replace(/[:.]/g, '-'));
  const runDir = path.join(OUTPUT_DIR, runId);
  console.info(
    `Run ${runId}: ${scenarios.length} scenarios × ${modes.length} modes × ${models.length} models × ${voices.length} voices`,
  );
  console.info(`Budget: spent $${spentUsd().toFixed(4)} of $${config.maxUsd}`);

  for (const model of models) {
    for (const voice of voices) {
      for (const mode of modes) {
        for (const scenario of scenarios) {
          const outDir = path.join(runDir, `${scenario.id}__${mode}__${model}__${voice}`);
          if (existsSync(path.join(outDir, 'summary.json'))) {
            console.info(`↷ skip ${path.basename(outDir)} (already done)`);
            continue;
          }
          try {
            assertBudget();
          } catch (err) {
            console.error(`⛔ ${(err as Error).message}`);
            return;
          }
          await runScenario(scenario, mode, model, voice, outDir);
        }
      }
    }
  }
  console.info(
    `Done. Results in ${path.relative(process.cwd(), runDir)} — run \`npm run report -- --run ${runId}\``,
  );
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
