#!/usr/bin/env node
// Per-minute cost model calculator (T0.17). No dependencies: `node calc.mjs` prints the
// markdown tables used in docs/cost/cost-model.md. Edit INPUTS, re-run, paste the output.

export const INPUTS = {
  fxUsdInr: 96.83, // open.er-api.com, 2026-10-08
  // AI realtime per call minute — ESTIMATE until the T0.15 PoC measures it (docs/poc/voice-ai-poc-results.md).
  aiUsdPerMin: { 'gpt-realtime-2.1-mini': 0.035, 'gpt-realtime-2.1': 0.11 },
  // gpt-4o-mini-tts ≈ $0.015 per minute of generated speech (estimate; T0.15 tts-check measures it).
  ttsUsdPerMinSpeech: 0.015,
  // Telephony — CLIENT PENDING. Placeholder range, base value in the middle.
  telephonyInrPerMin: { low: 0.3, base: 0.6, high: 1.0 },
  pulseSec: 60, // billing pulse (15 / 30 / 60) — client pending
  // Recording: G.711 μ-law 8 kHz mono = 64 kbps = 0.48 MB/min; S3 ap-south-1 $0.025/GB-month; 90-day retention.
  recordingMbPerMin: 0.48,
  s3UsdPerGbMonth: 0.025,
  retentionMonths: 3,
  serverInrPerMin: 0, // client's EC2 — no direct cost to us (placeholder)
  gstPercent: 18, // on top-ups (confirm with CA)
};

const inr = (usd) => usd * INPUTS.fxUsdInr;
export const billableMinutes = (sec, pulse = INPUTS.pulseSec) =>
  (Math.ceil(sec / pulse) * pulse) / 60;
const recordingInrPerMin = () =>
  inr((INPUTS.recordingMbPerMin / 1024) * INPUTS.s3UsdPerGbMonth * INPUTS.retentionMonths);

/** Cost per answered call minute (INR) for each call type. */
export const perMinute = (
  telephony = INPUTS.telephonyInrPerMin.base,
  aiModel = 'gpt-realtime-2.1-mini',
  aiFactor = 1,
) => {
  const ai = inr(INPUTS.aiUsdPerMin[aiModel] * aiFactor);
  // IVR-only: bot speaks ~60% of the time (TTS, variable parts only; static prompts cached → upper bound).
  const ivr =
    telephony +
    inr(INPUTS.ttsUsdPerMinSpeech * 0.6) +
    recordingInrPerMin() +
    INPUTS.serverInrPerMin;
  const aiFull = telephony + ai + recordingInrPerMin() + INPUTS.serverInrPerMin;
  // Mixed: first 30 s TTS/IVR, rest AI → per-minute blend for a 1.5 min call.
  const mixed =
    telephony +
    (0.5 / 1.5) * inr(INPUTS.ttsUsdPerMinSpeech * 0.6) +
    (1 / 1.5) * ai +
    recordingInrPerMin();
  return { ivr, aiFull, mixed };
};

const r2 = (n) => n.toFixed(2);

export const campaign = ({
  contacts = 100,
  answerRate = 0.5,
  avgAnsweredSec = 90,
  retries = 2,
  retryAnswerRate = 0.3,
  type = 'mixed',
  telephony = INPUTS.telephonyInrPerMin.base,
  aiModel = 'gpt-realtime-2.1-mini',
  aiFactor = 1,
  pulse = INPUTS.pulseSec,
} = {}) => {
  // Unanswered attempts assumed free (most trunks bill answered calls only — confirm with client).
  let remaining = contacts;
  let answered = 0;
  let attempts = 0;
  for (let i = 0; i <= retries; i += 1) {
    const rate = i === 0 ? answerRate : retryAnswerRate;
    attempts += remaining;
    const a = remaining * rate;
    answered += a;
    remaining -= a;
  }
  const per = perMinute(telephony, aiModel, aiFactor)[type];
  const minutes = answered * billableMinutes(avgAnsweredSec, pulse);
  return { answered, attempts, minutes, cost: minutes * per, per };
};

const lines = [];
const out = (s = '') => lines.push(s);

const base = perMinute();
out('### Cost per answered minute (INR, base inputs)');
out();
out('| Call type | gpt-realtime-2.1-mini | gpt-realtime-2.1 |');
out('| --- | --- | --- |');
const full = perMinute(INPUTS.telephonyInrPerMin.base, 'gpt-realtime-2.1');
for (const [k, label] of [
  ['ivr', 'IVR only (TTS + DTMF)'],
  ['mixed', 'Mixed (30 s IVR + AI)'],
  ['aiFull', 'AI agent full call'],
]) {
  out(`| ${label} | ₹${r2(base[k])} | ₹${r2(full[k])} |`);
}
out();
out('### Suggested selling rate per minute (mini model)');
out();
out('| Call type | Our cost | +30% | +50% | +100% |');
out('| --- | --- | --- | --- | --- |');
for (const [k, label] of [
  ['ivr', 'IVR only'],
  ['mixed', 'Mixed'],
  ['aiFull', 'AI full'],
]) {
  const c = base[k];
  out(`| ${label} | ₹${r2(c)} | ₹${r2(c * 1.3)} | ₹${r2(c * 1.5)} | ₹${r2(c * 2)} |`);
}
out();
const ex = campaign();
out('### 100-contact loan-recovery campaign (mixed flow, mini model)');
out();
out(
  'Assumptions: 50% answer on first attempt, 2 retries on no-answer with 30% answer each, avg answered call 1.5 min, 60 s pulse, unanswered attempts free.',
);
out();
out('| Item | Value |');
out('| --- | --- |');
out(`| Dial attempts | ${ex.attempts.toFixed(0)} |`);
out(`| Answered calls | ${ex.answered.toFixed(1)} |`);
out(`| Billable minutes | ${ex.minutes.toFixed(1)} |`);
out(`| Our cost | ₹${r2(ex.cost)} (₹${r2(ex.per)}/min) |`);
for (const m of [1.3, 1.5, 2])
  out(
    `| Price at +${Math.round((m - 1) * 100)}% margin | ₹${r2(ex.cost * m)} (profit ₹${r2(ex.cost * (m - 1))}) |`,
  );
out();
out('### Sensitivity (100-contact campaign cost, INR)');
out();
out('| Scenario | Cost | vs base |');
out('| --- | --- | --- |');
const sens = [
  ['Base', {}],
  ['Avg answered call 3 min', { avgAnsweredSec: 180 }],
  ['AI price +50%', { aiFactor: 1.5 }],
  ['Telephony 2× (₹1.20/min)', { telephony: 1.2 }],
  ['Telephony low (₹0.30/min)', { telephony: INPUTS.telephonyInrPerMin.low }],
  ['Answer rate 30%', { answerRate: 0.3 }],
  ['Answer rate 70%', { answerRate: 0.7 }],
  ['15 s pulse (vs 60 s)', { pulse: 15 }],
  ['Full model gpt-realtime-2.1', { aiModel: 'gpt-realtime-2.1' }],
  ['AI full call type (no IVR part)', { type: 'aiFull' }],
  ['IVR only (no AI)', { type: 'ivr' }],
];
for (const [label, opts] of sens) {
  const c = campaign(opts).cost;
  out(
    `| ${label} | ₹${r2(c)} | ${c >= ex.cost ? '+' : ''}${r2(((c - ex.cost) / ex.cost) * 100)}% |`,
  );
}
out();
out(
  `_Recording storage adds ₹${recordingInrPerMin().toFixed(4)}/min (${INPUTS.retentionMonths} months, S3 Mumbai). Billable minutes use ${INPUTS.pulseSec} s pulse unless stated: 90 s → ${billableMinutes(90)} min._`,
);

if (process.argv[1] && process.argv[1].endsWith('calc.mjs')) console.info(lines.join('\n'));
