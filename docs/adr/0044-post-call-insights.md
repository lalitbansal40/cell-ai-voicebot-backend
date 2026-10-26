# 0044 — Post-call AI insights: a sweep finds reviewed-never calls, one structured model call per version, AI never overrides a flow / agent / person outcome

- **Status:** accepted
- **Date:** 2026-10-27

## Context

Phase 14 adds a summary, an outcome (disposition), the customer's sentiment and key facts (promise date / amount, callback time, dispute, wrong number) to every answered call — AI voice calls, browser test calls, WhatsApp AI calls and recorded WhatsApp calls answered by a team member. Calls end in several code paths (Phase 7 sessions, WhatsApp AI and human calls, the dry-run dialer). The transcript is customer speech: it may contain anything, including text that looks like instructions. AI usage is prepaid and charged to the account. Flows and AI agents already set outcomes; people must be able to correct them.

## Options considered

1. **Hook in every place a call ends** — immediate, but every path (and every future one) must remember it, and recording uploads / last transcript lines may still be in flight.
2. **A sweep over calls nobody has reviewed** — `insights: null` + ended ≥ 15 s ago, index `insights_due` (partial on `insights: null`), every minute on the AI queue. One place, every path, ≤ ~1 minute delay.
3. **Free-text answer parsed by us** vs **structured output** (`response_format: json_schema`, strict) validated with zod.
4. **The AI outcome replaces the call's outcome** vs **the AI only fills an empty outcome**.

## Decision

Options 2, structured output, and "AI only fills".

- **Sweep** `insights.sweep` decides once per call: `skipped` with a reason (`not_answered`, `disabled`, `too_short` (< 2 customer lines), `no_transcript` (human call without one)) or `pending` version 1 + an `insights.run` job (`insights-<callId>-v1`). Calls that ended before the release are `skipped: before_insights` (migration 0016) — never charged retroactively.
- **Run** `insights.run`: prepaid check (balance − holds > 0, else `skipped: low_balance`) → prompt (`core/ai/prompts/insights.ts`, versioned): system instructions with the account's active outcome keys, the call date for relative dates, the flow / agent name, whitelisted loan facts (`loan_amount`, `emi_amount`, `due_date`, `days_past_due`, `branch` — never phone, e-mail or name), the transcript inside `<<<TRANSCRIPT … TRANSCRIPT>>>` declared as data, cut from the middle at 24,000 chars → `chat` with `responseFormat` (strict JSON schema, every property required, temperature 0.2, ≤ 800 output tokens) → zod (`ModelInsightsSchema`: long text cut, numbers clamped, bad dates dropped; extra keys / wrong shapes rejected) with one retry → stored in `callInsights` (amounts: the model answers rupees, code stores whole-paise micros) → `chargeUsage` (`ai_charge`, ref the call, usage kind `insights`, the account's AI text rate, idempotency `insights-<callId>-v<n>`; tokens of failed attempts are charged too) → denormalised `call.insights` (status, sentiment, promise, no text) → `call.insights` event (ids only). Provider errors retry through the queue (3 attempts), then `failed: provider_error`; invalid output twice → `failed: invalid_output`.
- **Outcome precedence:** a flow node / AI agent tool / a person (`PATCH /calls/:id/disposition`) set `dispositionSource` `flow` / `agent` / `user` and always win; the AI's suggestion is stored in the insight and fills `call.disposition` only when it is empty (`dispositionSource: ai`). Outcomes are account-defined keys (`settings.dispositions`, 8 defaults, labels editable, keys used by calls can't be removed).
- **Regenerate** adds a version (all kept), charged again; one at a time per call.
- **Fake provider** (`core/ai/fake-structured.ts`, dev / tests / E2E): deterministic outcome from the Phase 8 `FAKE_RULES` on the customer lines (wrong number → refusal → callback → payment claim → promise), the first number ≥ 100 as the amount, "kal / tomorrow" = call date + 1, abusive words → negative.
- **Never logged:** transcript, prompt, summary, key facts. Logs carry call ids and error names only.

## Consequences

- Every call kind gets insights without touching the call paths; the delay is the settle time + one sweep.
- Insights cost money per call; the switch is per account and the cost shows on the call and in reports.
- AI facts are suggestions: the UI labels them "AI" with a low-confidence hint, and people can change the outcome.
- Changing the prompt bumps `INSIGHTS_PROMPT_VERSION`; old versions stay as they were made.
