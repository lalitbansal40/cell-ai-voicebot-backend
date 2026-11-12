# Pinnacle managed numbers — sign-off

Plan: `docs/prompts/PINNACLE_PROVIDER_PROMPT.md`. Runbook: `docs/integrations/pinnacle.md`. Branch `feature/pinnacle-provider` in both repos.

Baseline (PN-T0): backend lint ✅ typecheck ✅; frontend lint ✅ typecheck ✅.

## Tasks

| Task   | Result | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PN-T0  | ✅     | Branches, baseline, sign-off started.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| PN-T1  | ✅     | Provider `pinnacle`; credit line `partner_pending` / `partner_active`; calling reason `provider_unsupported`; channel `pinnacle` subdoc (webhook secret sealed + registered for `keys:reseal`, hidden in JSON); webhook event `source`; migration `0028-pinnacle-provider`; env `PINNACLE_ENABLED`, `PINNACLE_BASE_URL`, `PINNACLE_VOICE_BASE_URL`, `PINNACLE_TIMEOUT_MS` (+ `.env.example`, README, env tests).                                              |
| PN-T2  | ✅     | `createPinnacleClient`: Graph transport shared with the Meta client (`apikey` header, Pinnacle error mapper, HTTP 200 `status: failed`). Every `MetaClient` method is relayed, remapped (`business/…`, voice host, `downloadMedia`, `app/uploads`) or `provider_unsupported` (a test enumerates them). Extras: `getUserDetails`, `setWebhook`, `getWebhook`. Fake Pinnacle (`pin_test_` / `pin_bad_` / `pin_low_`). 8 error codes.                            |
| PN-T3  | ✅     | `clientFor(ctx, channel)` at every channel-bound call: inbox send / receipts / block / media, templates, profile, calling settings / permissions / calls, setup / sync / register. Guard test fails on any direct `meta.<method>(` without `// meta-only`. Reconcile skips managed numbers; coexistence and our credit line never run for them.                                                                                                               |
| PN-T4  | ✅     | `POST /api/v1/webhooks/pinnacle/:channelId` (raw body, timing-safe `x-cell-webhook-secret`, 404 / 403, foreign numbers dropped) and `GET` → `ok`. Shared `ingestEnvelope`. Meta route drops managed numbers' changes (30 s cached id set; the idempotency key covers any overlap). Fake events route by provider (`receiveSimulatedWebhook`).                                                                                                                 |
| PN-T5  | ✅     | Superadmin add / replace key / reset webhook / credit line: routes, service, OpenAPI. Webhook is read back; if it's wrong, nothing is saved. Disconnect clears the partner webhook. PIN / coexistence refused; retry setup = partner sync. Admin views: `provider`, `managed`, `pinnacle {…}`, status `pinnacle {enabled, baseUrl, voiceBaseUrl}`. 4 audit actions.                                                                                           |
| PN-T6  | ✅     | Pending credit line → `action_needed`. "Insufficient Balance": message / call fails with our reason and is not retried; holds are released; a superadmin bell (`whatsapp.provider_balance_low`) once an hour; `lastBalanceErrorAt` is set; the channel stays connected. Key rejected → `provider_key_invalid` (not Meta's text).                                                                                                                              |
| PN-T7  | ✅     | Calls over Pinnacle: inbound AI, team → AI, outbound AI, settings; partner refuses calling → `unavailable` / `provider_unsupported` (422 to the user). Readiness uses partner webhook / key facts. Balance errors on connect / pre-accept / accept are recorded.                                                                                                                                                                                              |
| PN-T8  | ✅     | Health / sync branch: key → number on key → webhook (re-set once, system audit) → details → status. Health job and event resync read the secret; `syncManaged` re-reads sealed fields when a caller didn't.                                                                                                                                                                                                                                                   |
| PN-T9  | ✅     | Dev route `POST /api/v1/dev/meta/managed-number`; runbook `docs/integrations/pinnacle.md`; README pointer; OpenAPI regenerated; docs:audit 0 problems.                                                                                                                                                                                                                                                                                                        |
| PN-T10 | ✅     | Superadmin: "Add managed number (Pinnacle)" (shown only when on), dialog (validation, show / hide key, credit line, error texts; the key is not kept), row with "Managed", key last 4, webhook time, balance warning, Replace API key / Reset webhook / Credit line (Active asks for confirmation). Owner: "Managed" badge, partner billing line, owner wording for partner reasons, no Reconnect / PIN for managed numbers. Calling reason label; bell icon. |
| PN-T11 | ✅     | Checks below.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Deviations

1. **Error codes:** a number already active elsewhere answers the existing `WHATSAPP_NUMBER_IN_USE` (409), not a new `WA_CHANNEL_EXISTS`.
2. **Calling status at add time:** after a managed number is added, its calling settings are read by the same calling-settings job as any connect (`onConnected` hook), not inline in the request.
3. **Webhook read-back:** the URL must match. Our secret header must match only when `getwebhook` echoes headers; Pinnacle may leave them out. Confirm with Pinnacle (open item 6).
4. **Rate limiting:** the Pinnacle webhook route uses the same global rate limiter as Meta's webhook, not a separate per-channel limiter.
5. **File locations:**
   - `fake-pinnacle.test.ts` lives in `tests/whatsapp/` because it needs Redis.
   - The runbook is `docs/integrations/pinnacle.md`; there is no `docs/whatsapp/` folder.
6. **Test helpers:** the inbox / template test helpers now deliver through `receiveSimulatedWebhook`, the same path the fake's own events use.
7. **Base plugin:** the base JSON plugin can now hide nested fields (`a.b`); needed for `pinnacle.webhookSecretSealed`.
8. **Public API:** customers see managed numbers like any other, so there is no public changelog entry. Admin and webhook routes are in the internal OpenAPI only.

## Checks

**Backend:**

- lint ✅, typecheck ✅, build ✅, openapi:check ✅, docs:audit 0 problems ✅.
- Full suite once, serial: 4141 passed, 3 failed.
  - `keys-reseal`: its seed lacked the new sealed field (`pinnacle.webhookSecretSealed`). Fixed; it now passes.
  - The other 2 failed before this work and are not touched here: WhatsApp campaign recurrence, and the `tts-cache` purge (an old entry left in the shared test DB).
- New tests (all green):
  - `pinnacle.client.test.ts` (30)
  - `fake-pinnacle.test.ts` (7)
  - `routing.guard.test.ts` (1)
  - `pinnacle-routing.test.ts` (4)
  - `pinnacle-webhook.test.ts` (10)
  - `managed-numbers.test.ts` (17)
  - `pinnacle-billing.test.ts` (3)
  - `pinnacle-calls.test.ts` (6)
  - `pinnacle-health.test.ts` (8)
  - env, migration, plugin, catalogue updates

**Frontend:**

- lint ✅, typecheck ✅, build ✅.
- Full suite once: 1609 passed, 2 failed. Both also failed on `main`: they were misses of the call-modes run that went unnoticed under load. Fixed in this run: the calls "Talked by" filter test, and the inbox Retry scoped to the message list. Both now pass.
- New tests: `managed-number.test.tsx` (7), `managed.test.tsx` (4).

## Open items (Pinnacle)

1. Production host of the WhatsApp Voice API (`PINNACLE_VOICE_BASE_URL`); their doc shows only a test load balancer.
2. Are `calls` webhooks (connect with SDP answer, terminate) relayed by `setwebhook` unchanged and quickly?
3. SDP passthrough for business-initiated `connect` and user-initiated `pre_accept` / `accept`.
4. Exact paths for phone number / profile (`/v3/business/{id}`), block users, media delete.
5. Rate limits per key / number.
6. Does `setwebhook` override the panel's Multiple Callback? Is it allowed for numbers from their ES? Does `getwebhook` echo headers?
7. Callback source IPs.
8. Pricing / conversation analytics for reconciliation.

## Live checks still open (owner's permission needed)

1. Add one real managed number (credit line Active). Send one template and one session message, receive a reply, and see the statuses arrive.
2. One inbound WhatsApp call answered by AI, and one outbound AI call to the owner's own number.
3. Wrong key → `provider_key_invalid`; restore it → connected.
4. Change the webhook in Pinnacle's panel → the next health pass sets ours again.
