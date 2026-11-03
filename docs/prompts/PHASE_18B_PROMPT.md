# P18B RUN — WhatsApp Calling Go-Live (T18B.1 → T18B.9) — One-Paste Autonomous Run Prompt

> **HOW TO RUN — ek hi paste, poora phase. Beech mein kahin nahi rukna.**
>
> **Ek paste = STEP 0 → Batch 1 → Batch 2 → sign-off.** Checkpoint (`P18B-B1-DONE`) pe sirf commit + 2 line progress note, aur **usi turn mein agla task**.
>
> **Paste this (working directory `/Users/lalitbansal/Documents/cell-ai-voicebot`):**
>
> `cell-ai-voicebot-backend/docs/prompts/PHASE_18B_PROMPT.md padho aur STEP 0 se P18B-B2-DONE tak POORA Phase 18B step by step autonomously implement karo. Kahin mat ruko — saare decisions is prompt + PHASE_18B_WA_CALLING_PLAN.md me pre-made hain (§1). Har task ke baad sirf us task ke tests (§2 rule 5) + commit [P18B-T18B.x]. Full suite sirf checkpoint pe EK baar. Real number / server ke inputs na hon to sirf wo sub-step skip, open item, aage badho. End me final report Hinglish me.`
>
> **Claude Code "auto / accept edits" mode me chalao.** **Docker Desktop chalu** (`cav-mongo`, `cav-redis`, `cav-mailpit`). **Mac charger par** — lambi runs `caffeinate -dims` ke saath, background mein. Doosre projects ke containers / processes **kabhi mat chhoona** (port 3100 aur Supabase containers doosre project ke hain).

---

## 0. CONTEXT (verified facts on 4 Nov 2026 — dobara derive mat karna)

**Branches:** `main` = backend **`b2c040f`**, frontend **`8bc59ab`** (Phase 18 done, pushed to `origin/main`; client repo still at Phase 17 tag `release-20261103-6b656bd`, **production runs Phase 15**). `docs/phases/PHASE_18B_WA_CALLING_PLAN.md` and this prompt are **uncommitted on backend `main`** — STEP 0 moves them to the branch. Create **`feature/phase-18b-wa-calling`** from `main` in both repos. **Never commit to `main`.**

**Numbers at start:** backend **3,893 tests (+1 skipped) / 369 files**, gate 95 / 85 / 95 / 95, coverage 95.95 / 87.17 / 95.34 / 97.51; frontend **1,481 tests / 138 files**, gate 95 / 90 / 90 / 95, coverage 95.84 / 92.04 / 93.03 / 96.53; **170 Playwright tests**. Catalogue (`tests/calls-wa/catalogue.test.ts`): error codes **107**, audit actions **173**, notifications **38**. Migrations `0001` … `0019`. Known load flakes (pass alone): frontend `templates-page`, `functions-knowledge`, `reports`, `campaigns-pages`, `contact-detail`; backend `calls-wa/leg-media` (10 legs), `calls/flow-call` (max duration).

**Meta Calling prerequisites (docs re-read 4 Nov 2026):** daily messaging limit **≥ 2,000 unique recipients** (sandbox / public test numbers exempt); number on **Cloud API** (not the WhatsApp Business app); app subscribed to the **`calls`** webhook field and to the number's WABA; **`whatsapp_business_messaging`** permission; calling switched on in the number's call settings (off by default on test numbers). Business-initiated calls not available for business numbers in **US, CA, EG, VN, NG**. Permission requests: **1 per 24 h, 2 per 7 days** per user (Meta codes **138009** asked too often, **138017** permanent permission exists, **138006** no permission).

**Pehle padho (STEP 0 and after every compaction):**

- [PHASE_18B_WA_CALLING_PLAN.md](../phases/PHASE_18B_WA_CALLING_PLAN.md) — **source of truth**: goal + Done-when §0, what exists §1a, gaps G1–G10 §1b, tasks §2, tests §3, risks §4, client inputs §5.
- [PHASE_12_SIGNOFF.md](../phases/PHASE_12_SIGNOFF.md) §8–§9; [PHASE_12_PLAN.md](../phases/PHASE_12_PLAN.md) §1d (availability); ADR 0040 (WhatsApp call media), ADR 0041 if present.
- [meta-whatsapp.md §15](../setup/meta-whatsapp.md) (enable, webhooks, media network, prices, **real-device checklist**), [APP_REVIEW.md](../meta/APP_REVIEW.md) (video 2b calling).
- AutoChatix reference (read only, never copy secrets / tokens): `~/Documents/Autochatix/AutoChatix-backend/src/services/callingSettings.service.ts` (write + read-back), `callPermission.service.ts` (limits, template vs interactive, 138009 / 138017 handling), `controllers/calls.controller.ts` (`requestCallPermissionBulk`), frontend `src/components/calls/BulkCallPermissionDialog.tsx`.
- Conventions: [secrets.md](../conventions/secrets.md), [security.md](../conventions/security.md), [definition-of-done.md](../conventions/definition-of-done.md), [audit.md](../conventions/audit.md), [error-codes.md](../conventions/error-codes.md).

**What exists (use it, don't rebuild) — exact entry points:**

| Area             | Use                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings         | `src/modules/whatsapp-calling/settings.service.ts`: `createCallingSettings(deps)` → `getCalling`, `syncCalling(channel, { throwOnError })`, `syncNow`, `updateCalling` (validates, maps to `MetaCallingSettingsUpdate`, calls `ctx.meta.updateCallingSettings(token, phoneNumberId, forMeta)`, **no read-back today**), `notifyRestricted`                                       |
| Meta client      | `src/core/meta/types.ts`: `getPhoneSettings(token, phoneNumberId): MetaCallingSettings`, `updateCallingSettings(token, phoneNumberId, calling)`, `debugToken(token)`, `subscribeApp` / `unsubscribeApp(token, wabaId)`; fake in `src/core/meta/fake-calling.ts`                                                                                                                  |
| Availability     | `availability.ts`: `callingUnavailableReason` (`coexistence`, `not_cloud_api`, `messaging_limit` for `TIER_50` / `TIER_250` / `TIER_1K`), `bicCountryBlocked`, `activeRestrictions`                                                                                                                                                                                              |
| Routes           | `calling.routes.ts`: `GET` / `PATCH /whatsapp/channels/:id/calling` (`whatsapp.calling.manage`), `POST …/calling/sync`, `GET /whatsapp/call-permissions` (`calls.read`), `POST /whatsapp/call-permissions/request` (`inbox.reply`, limiter `wa-call-perm` 20 / h), `POST /whatsapp/calls` (`calls.trigger`), hold / transfer / media ticket, `PATCH /users/me/call-availability` |
| Permissions      | `permissions.service.ts` (Meta `call_permissions` actions + limits, request: interactive inside 24 h else approved template, reply webhook); model `whatsapp-call-permission.model.ts`: statuses `none, requested, temporary, permanent, declined, expired, revoked`; `CALLABLE_PERMISSION_STATUSES`; unique `{accountId, channelId, contactId}`                                 |
| Channel          | `whatsapp-channel.model.ts`: `mode`, `isOnBizApp`, `platformType`, `messagingLimitTier`, `businessVerificationStatus`, `calling` (`status`, `callIconVisibility`, `iconCountries`, `callHours`, `callbackPermission`, `restrictions`, `unavailableReason`, `syncedAt`, `lastError`, `inbound`)                                                                                   |
| Templates        | `modules/templates/components.ts` (`CALL_PERMISSION_REQUEST` component, `purpose: 'call_permission'`); frontend `features/templates/builder/model.ts` `callPermissionState()`, `CALL_PERMISSION_BODY`; `TemplatesPanel.tsx` "Create call permission template"                                                                                                                    |
| Contact filter   | `modules/contacts/filter/filter.schema.ts`: `CALL_FILTER_OPERATORS` (`lastDisposition`, `lastCalledAt`), `compile.ts`                                                                                                                                                                                                                                                            |
| Bulk contacts    | `modules/contacts/bulk.service.ts`, `bulk.schema.ts` (bulk actions pattern)                                                                                                                                                                                                                                                                                                      |
| Frontend calling | `features/whatsapp-calling/settings/CallingSection.tsx` (in `features/whatsapp/numbers/ChannelDrawer.tsx`), `panel/CallingPanelSection.tsx` + `RequestPermissionDialog.tsx` (inbox `ContactPanel.tsx`, `ChatView.tsx`), `live/CallButton.tsx`, `queries.ts` (`useRequestCallPermission`, `useCallingSettings`), `services/api/whatsapp-calling.ts`                               |
| Ops              | `modules/admin/system.service.ts` (System page), `src/ops/health-rules.ts`, `health-check.ts`; env `WA_MEDIA_ENABLED`, `WA_MEDIA_PUBLIC_IP`, `WA_MEDIA_PORT_MIN/MAX` (40000–40999), `WA_MEDIA_MAX_CALLS`                                                                                                                                                                         |
| Release          | `scripts/sync-client-repo.sh <be-ref> <fe-ref> [--dry-run]`                                                                                                                                                                                                                                                                                                                      |

**Bugs to avoid:** trusting Meta's `success` without the read-back; storing our wish instead of Meta's state; sending a bulk permission request without a template (it silently reaches only the 24 h window); asking a contact who already allowed, declined in the last 7 days, is DND / opted out / suppressed; counting a 138009 / 138017 answer as a failure (it is an answer — record it); calling Meta's app subscription API with a user token (needs the **app** token); a readiness check that makes outbound network calls from tests; phone numbers or tokens in logs / audit (last 4 only); a contacts-list column that queries permissions per row (N+1).

---

## 1. LOCKED DECISIONS (exact literals)

**Owner defaults (plan §4–§5) are in force.** Record "Defaults in use; client inputs (§5): <present / none>" in the plan changelog at STEP 0.

**Read-back (T18B.1):** after `updateCallingSettings` succeeds → `getPhoneSettings`; compare `status` (and `call_icon_visibility`, `call_hours.status` when sent). Mismatch → error **`CALLING_SETTINGS_NOT_APPLIED`** (502, "WhatsApp did not apply the change. Refresh and check the number before trying again."); the channel stores **Meta's** read-back + `calling.lastError`. Meta error codes mapped in one table `CALLING_META_ERRORS` (`config/limits.ts` or `whatsapp-calling/errors.ts`): not eligible / tier / coexistence / rate limit → plain text; the code goes to the log only.

**Readiness (T18B.2):** `GET /whatsapp/channels/:id/calling/readiness` (`whatsapp.read`) → `{ ready: boolean, items: { key, ok: boolean | null, detail, fix }[] }`, keys in this order: `cloud_api`, `messaging_limit`, `business_verified`, `calls_webhook`, `app_permission`, `meta_status`, `restrictions`, `last_calls_webhook`, `media`, `prices`. `ok: null` = could not tell (shown as "Unknown", never blocks). Must-haves that block the switch: `cloud_api`, `messaging_limit`, `calls_webhook` (when known false), `media`. `calls_webhook` = `GET /{META_APP_ID}/subscriptions` with the app token `${META_APP_ID}|${META_APP_SECRET}`, field `calls` on object `whatsapp_business_account`; cached **1 h** in Redis `wa:readiness:calls-webhook`. `last_calls_webhook` = new channel field `calling.lastCallsWebhookAt` (set by the `calls` webhook handler). `media` = `WA_MEDIA_ENABLED` and (production) `WA_MEDIA_PUBLIC_IP` set and one port of the range bindable on this process. `prices` = calling rate card not the placeholder (`IN` ₹0.3885 / min placeholder flag).

**Contacts (T18B.3):** filter key **`whatsappCallPermission`** in `CALL_FILTER_OPERATORS` with ops `eq` / `neq`, values `allowed` (temporary | permanent and not expired) | `asked` (requested) | `declined` (declined | revoked | expired) | `none`; compiled as a `$lookup`-free query using a per-contact summary field **`contacts.waCallPermission`** (`allowed` | `asked` | `declined` | `none`, default `none`) kept in sync by the permission service on every state change (any channel; `allowed` wins). Contacts list column "WhatsApp calls" reads that field (no N+1). Contact page card reuses `CallingPanelSection`.

**Bulk (T18B.4):** `POST /whatsapp/call-permissions/bulk` (`inbox.reply` + `contacts.read`, `Idempotency-Key`, limiter `wa-call-perm-bulk` 5 / h) body `{ channelId, target: { contactIds?: string[] (≤ 5,000) | listId?: string | segmentId?: string } (exactly one), templateId, variables?: Record<string, string> }` → 202 `{ runId }`; `GET /whatsapp/call-permissions/bulk/:runId` → `{ status: 'queued' | 'running' | 'done' | 'stopped', total, sent, skipped: Record<reason, n>, failed, startedAt, finishedAt }`. Skip reasons (fixed set): `dnd`, `opted_out`, `suppressed`, `no_whatsapp`, `already_allowed`, `meta_limit`, `declined_recently`, `wallet_empty`. Job name `call-permission-bulk` on queue `whatsapp`; one job per run, batches of 50, paced by the channel tier (Phase 11 send pacing); per contact idempotency key `cpb:<runId>:<contactId>`. New model **`callPermissionRuns`** (`accountId`, `channelId`, `templateId`, `target`, `status`, counters, `createdBy`, timestamps; index `{accountId:1, createdAt:-1}`), migration **`0020-call-permission-runs`** (indexes + `contacts.waCallPermission: 'none'` default backfilled from existing permission rows).

**Template (T18B.5):** presets `callPermissionState('en')` and `callPermissionState('hi')` (Hinglish body = current `CALL_PERMISSION_BODY`; English: "Can we call you on WhatsApp about your account?"); the permission dialog lists templates with `purpose: 'call_permission'` and their status (`APPROVED` / `PENDING` / `REJECTED` + `rejectedReason`); outside the window only `APPROVED` selectable.

**Media readiness (T18B.6):** System status gains `whatsappCalls: { mediaEnabled, publicIpSet, portRange: '40000-40999', liveCalls, lastSetupMs, lastError } | null`; health rules **`wa-media-no-public-ip`** (production, media on, no IP) and **`wa-call-setup-failing`** (≥ 3 failed setups in 15 min, from call events).

**Catalogue (append; update count tests in the same commit):**

- Error codes **+1 → 108:** `CALLING_SETTINGS_NOT_APPLIED` (502).
- Audit actions **+1 → 174:** `whatsapp.call_permission_bulk_requested` (meta: `runId`, `total`, `channelId`).
- Notifications **+1 → 39:** `whatsapp.call_permission_bulk_done` (to the requester: sent / skipped / failed).
- Migration **0020**. No new permissions.

---

## 2. RULES OF ENGAGEMENT

1. **NEVER STOP, NEVER WAIT, NEVER ASK.** Checkpoints are commits, not pauses. Only a 2-line progress note at the checkpoint, same turn.
2. **Blocked? Unblock yourself:** plan default → safest convention-consistent choice → deviation note. Missing client input (number tier, server, phones) → skip only that sub-step, open item, continue.
3. **Safety:**
   - No real Meta calls from code or tests (fake Meta only). Real-device steps (T18B.7) only on the owner's phones, only if §0 inputs exist; never a customer.
   - Never print / log / commit tokens, app secret, phone numbers (last 4 only), names or message texts. Never read `~/Downloads/*.env*`.
   - Never connect to `45.114.245.71` or `13.232.191.62`; live site: public GET / HEAD only.
   - Mac Docker: only `cav-*` containers and one-off `docker run --rm`.
4. **Git:** branch `feature/phase-18b-wa-calling` in both repos; never on `main`; one commit per task per repo; hooks must pass (no `--no-verify`, no `--force`); **no push / merge / client sync** unless the owner asks. Footer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; lines ≤ 100; message in a scratchpad file + `git commit -F`; tag `[P18B-T18B.x]`. **Commit only after the checks of that task passed** (check first, then commit — never chained with `;`).
5. **Test policy (owner rule, binding):**
   - While writing: only the changed files' tests (`npx vitest run <files>`).
   - Before each commit: backend `npm run lint` · `npm run typecheck` · the task's tests; `npm run gen:openapi` + stage + `npm run openapi:check` when routes / schemas changed; frontend `npm run lint` · `npm run typecheck` · changed tests; `npm run gen:api` after backend schema changes.
   - **Checkpoint B1** (after T18B.6): backend `npx vitest run --maxWorkers=2` **once** (no coverage); frontend `npx vitest run` **once**; both builds. Real exit codes written to a file (`code=$?` right after the command, never the exit of `echo` / `grep`).
   - **Sign-off B2:** backend `--coverage --coverage.reportOnFailure --maxWorkers=2` **once**; frontend `--coverage --coverage.reportOnFailure` **once**; builds; `openapi:check`; Playwright whole suite **once** with `E2E_BACKEND_LOGS=1` + log grep (patterns below), `E2E_FRONTEND_PORT=3150`.
   - **Flake:** a failure in a known flake file → re-run **only that file** once; passes → record; fails again → real failure. Never re-run a whole suite for a flake.
   - Full runs in the background with `caffeinate -dims`; **no code edits while a full run is going**.
   - Before a full run: `docker ps` shows `cav-mongo` and `cav-redis` up (Docker Desktop can stop; if so `open -a Docker`, wait, `npm run infra:up`).
6. **Coverage gates stay green; never lower thresholds or raise timeouts; no dynamic `import()` in backend tests.** New code ≥ 95 % lines.
7. **No external network in tests** (fake Meta, stub servers).
8. **Docs + catalogue counts in the same commit** as the code.
9. **Real bugs:** failing regression test first → `fix(<area>)` commit → plan changelog.
10. **Progress note** at the checkpoint: "P18B-B1-DONE ✅ — <n> backend / <m> frontend tests; next: T18B.7" — nothing more.

---

## 3. RESUME SAFETY

1. `git branch --show-current` → `feature/phase-18b-wa-calling` in both; `git log --oneline -12`.
2. Last `[P18B-…]` tag = position; tracker ticks must agree.
3. Uncommitted work → read `git diff`, finish that task, run its tests, commit.
4. A full run may still be going (check background tasks / output file) — never two at once.
5. Infra up → lint + typecheck → last task's tests → continue with the next task.

---

## STEP 0 — P18B-SETUP

1. Backend: `git status` shows only the plan + this prompt untracked on `main` (`b2c040f`); `git switch -c feature/phase-18b-wa-calling`. Frontend: same branch from `8bc59ab`.
2. `git fetch origin` both; if `origin/main` moved, merge `main` in, lint + typecheck.
3. Write `docs/phases/PHASE_18B_TASKS.md` (tracker, 9 rows, batch column: B1 = T18B.1–T18B.6, B2 = T18B.7–T18B.9).
4. Plan status → **Locked**; changelog line: "Run prompt prepared — literals locked: errors +1 → 108, audit +1 → 174, notifications +1 → 39, migration 0020, readiness keys, bulk skip reasons; client inputs: <present / none>."
5. Commit → `docs(plans): add and lock phase 18b plan and run prompt [P18B-PLAN]`.
6. `npm run infra:up`; lint + typecheck both. **No full test run here.** Continue into T18B.1.

---

# ═══════════ BATCH 1 — Make calling ready and visible (T18B.1 → T18B.6) ═══════════

## T18B.1 — Enable with read-back → `fix(calls): confirm calling settings with whatsapp read-back [P18B-T18B.1]` (both repos)

1. Regression test first (`tests/calls-wa/settings-readback.test.ts`): fake Meta accepts `updateCallingSettings` but keeps the old status → today the stored state says ENABLED (failing test).
2. `updateCalling`: after the write → `getPhoneSettings` → compare per §1; store Meta's state (`syncCalling` path), set / clear `calling.lastError`; mismatch → `CALLING_SETTINGS_NOT_APPLIED`. Same for `callIconVisibility` and `callHours.status` when they were in the patch.
3. `CALLING_META_ERRORS` map; `meta` client errors on the settings calls go through it (plain message to the client, code + `fbtrace_id` to the log only).
4. Fake Meta: a switch `setCallingApplyMode('ignore' | 'apply')` for tests.
5. Frontend `CallingSection`: pending state "Turning on…" / "Turning off…" until the response; on error the switch shows Meta's state (refetch) + the message; tests.
6. Catalogue: error +1 (108), `error-codes.md` row.
7. Verify: the new test + `tests/calls-wa/settings*.test.ts` + `routes.test.ts`; frontend `settings` tests; lint / typecheck; `gen:openapi` / `openapi:check` if the error appears in the spec; `gen:api`.

## T18B.2 — Readiness checklist → `feat(calls): show why whatsapp calling is or isn't ready [P18B-T18B.2]` (both repos)

1. Backend `whatsapp-calling/readiness.ts` (pure item builders + one `readCallingReadiness(channel, deps)`), route per §1, schema `CallingReadinessSchema` registered in OpenAPI (`src/openapi.ts` import if a new schema file — the docs test checks it).
2. `calls` webhook check: Meta client method `getAppSubscriptions(appToken)` (real + fake), Redis cache 1 h; failure → `ok: null`.
3. Channel field `calling.lastCallsWebhookAt` (schema default null) set in the `calls` webhook handler (`webhooks.ts`), with no migration needed (absent = null) — note it in `data-model.md`.
4. `app_permission`: from `debugToken` scopes cached on the channel at connect / sync (`whatsapp_business_messaging`); unknown → `null`.
5. `messaging_limit`: detail shows the tier (`TIER_250` → "250 a day"); fix text: "Meta allows calling from 2,000 a day. The limit grows with good-quality messages to more unique customers and with business verification (WhatsApp Manager → Insights)".
6. `media`: production requires `WA_MEDIA_PUBLIC_IP`; bindable port check via `dgram` bind / close on 127.0.0.1 (no external probe).
7. `PATCH …/calling` refuses `status: enabled` when a must-have item is false (422 with that item's fix) — reuse `VALIDATION_FAILED` details, no new code.
8. Frontend: `CallingReadiness.tsx` in `CallingSection` above the switch (✓ / ✗ / ? per item with fix text), switch disabled with the first blocking fix; numbers list chip "Calling: not ready (n)".
9. Tests: every item true / false / unknown on the fake Meta; cache; route permission; the 422; frontend checklist + chip.
10. Docs: `meta-whatsapp.md` §15 "Readiness" subsection.

## T18B.3 — Permission from contacts → `feat(contacts): ask and see whatsapp call permission from contacts [P18B-T18B.3]` (both repos)

1. Contact field `waCallPermission` (model default `none`) + permission service keeps it in sync on request / reply / expiry / revoke (one helper `summarizePermission(accountId, contactId)` taking the best state over channels).
2. Expiry: the existing permission sweep (or a new tick in the calling jobs) flips expired temporaries → updates the summary.
3. Filter key `whatsappCallPermission` per §1 in `filter.schema.ts` + `compile.ts` (+ OpenAPI description text); segments accept it; frontend filter builder option.
4. Contacts list: column "WhatsApp calls" (chip) from the field; contact page: `CallingPanelSection` card (channel picker when > 1 calling-enabled channel); calls page: "New WhatsApp call" → contact picker → same card.
5. Tests: summary sync on each transition, filter compile + segment preview, list column, contact page card per role, calls page entry.

## T18B.4 — Bulk permission request → `feat(calls): ask many customers for whatsapp call permission [P18B-T18B.4]` (both repos)

1. Migration `0020-call-permission-runs` per §1 (+ test: idempotent, backfill from permission rows, previous release unaffected); model + `all.ts`; `DATA_MAP.md` row + erase map entry (`callPermissionRuns`: keep — no personal data, ids only) + tenant check (has required `accountId`).
2. Route + schema per §1 (OpenAPI import in `src/openapi.ts`); body validation: exactly one target, template must be the account's, `APPROVED`, `purpose: 'call_permission'`, on that channel; channel calling not `unavailable`.
3. Job `call-permission-bulk`: resolves the target to contact ids (list / segment through the existing audience code, cap 5,000), per contact applies the skip rules in this order: `suppressed`, `dnd`, `opted_out`, `no_whatsapp`, `already_allowed`, `declined_recently` (declined in the last 7 days), `meta_limit` (Meta's action limit), then sends via the existing template send path (wallet hold + charge as a template message), `wallet_empty` stops the run (`status: 'stopped'`, the rest counted as skipped `wallet_empty`). 138009 / 138017 answers recorded as `meta_limit` / `already_allowed`, not failures.
4. Progress in the run doc every batch; realtime event `call_permission_bulk.progress` to the account (existing notify bus); notification `whatsapp.call_permission_bulk_done` at the end; audit `whatsapp.call_permission_bulk_requested` at start.
5. Frontend: bulk action "Ask for WhatsApp call permission" in the contacts list selection, the list page and the segment page → `BulkCallPermissionDialog` (channel, approved permission templates with variables, estimate = recipients × template price, explanation of the limits) → progress + result table by reason.
6. Catalogue: audit +1 (174), notification +1 (39) — count tests, `audit.md`, notification docs.
7. Tests: every skip reason, Meta answers, wallet stop, idempotent re-run of the job, counts, permission checks, 5,000 cap; frontend dialog validation, progress, results.

## T18B.5 — Permission template, guided → `feat(templates): guide the call permission template [P18B-T18B.5]` (frontend; backend only if the list API lacks `purpose` / `rejectedReason`)

1. Presets `en` + `hi` per §1; entry points: Templates panel (exists), Calling section ("No approved permission template — create one"), the permission dialog empty state.
2. Permission dialog + bulk dialog list permission templates with status chips and rejection reason; only approved selectable outside the window; link "Edit and resubmit".
3. Category picker with Meta's note.
4. Tests: entry points, states, selection rules.

## T18B.6 — Media readiness on System + healthwatch → `feat(ops): watch whatsapp call media readiness [P18B-T18B.6]` (both repos)

1. System status `whatsappCalls` per §1 (live calls from the call registry / owner bus, last setup from the latest call event, last error).
2. Health rules per §1 in `health-rules.ts`, facts from the system status in `health-check.ts`; bell to superadmins reuses `bellSuperadmins` with new issue keys + texts.
3. Frontend System page card "WhatsApp calls".
4. Tests: rules table, status block, card.

## P18B-B1-DONE — checkpoint → `docs: mark phase 18b batch 1 complete [P18B-B1-DONE]` (both repos)

Backend full suite **once** (no coverage), frontend **once**, both builds (real exit codes in a file). Real failures → fix + that file again; known flakes → that file once. Tracker ticks T18B.1–T18B.6; plan changelog with numbers; progress note; **continue to T18B.7**.

---

# ═══════════ BATCH 2 — Live check, release, sign-off (T18B.7 → T18B.9) ═══════════

## T18B.7 — Real-device checklist → `docs(meta): record the whatsapp calling live check [P18B-T18B.7]`

- **If** §0 inputs exist (number on Cloud API with limit ≥ 2,000 or Meta's public test number, app subscribed to `calls`, the release of this branch on a reachable server with UDP 40000–40999 and `WA_MEDIA_PUBLIC_IP`, two owner phones): run the 9 steps of `meta-whatsapp.md` §15 + the readiness checklist all green; write `docs/meta/CALLING_LIVE_CHECK.md` (date, step, pass / fail, latency, Meta durations vs our pulses; last-4 numbers only); every failure → fix task now.
- **If not:** `CALLING_LIVE_CHECK.md` lists each step as "not run" with exactly which input is missing; the readiness checklist output from the fake Meta is the evidence that the platform explains it. Commit either way.

## T18B.8 — Release → `docs(ops): prepare the phase 16-18b release [P18B-T18B.8]`

- Only if the owner asked for the client sync in this run: `scripts/sync-client-repo.sh main main --dry-run`, then the real sync (after merge, which needs the owner). Otherwise: `docs/ops/releases.md` entry "pending: Phases 16–18B, steps", and the post-deploy checks (health commit, readiness green on the production number, a permission request to the owner's phone) — open item for the client team.

## T18B.9 — Docs, sign-off → `docs: add phase 18b sign-off [P18B-T18B.9]` (both repos)

1. Docs: `meta-whatsapp.md` §15 (readiness, bulk permission, template guide), `audit.md`, `error-codes.md`, notifications list, `data-model.md` (`callPermissionRuns`, `contacts.waCallPermission`, `calling.lastCallsWebhookAt`), `DATA_MAP.md`, both CHANGELOGs, `src/README.md`, BUILD_PLAN_V2 line ("Phase 18B … Next: Phase 19").
2. Gap audit: each G1–G10 → its commit or open item with owner.
3. `PHASE_18B_SIGNOFF.md`: verdict, task table, Done-when table, numbers before → after, deviations, bugs, flakes, open items.

## P18B-B2-DONE — sign-off run → `docs: mark phase 18b complete [P18B-B2-DONE]` (both repos)

1. One script in the scratchpad, background, `caffeinate -dims`, real exit codes: backend coverage (report on failure), backend build, `openapi:check`, frontend coverage (report on failure), frontend build, Playwright once with `E2E_BACKEND_LOGS=1` → grep the clean log for `cav_(live|test)_[0-9A-Za-z]{32}`, `whsec_`, `v1=[0-9a-f]{64}`, `\+91[0-9]{10}`, `Bearer [A-Za-z0-9._-]{20,}`, `"password"`, `otpauth`, `\$enc`, `mongodb(\+srv)?://[^ ]*@`, `AKIA[0-9A-Z]{16}`, `Basic [A-Za-z0-9+/=]{16,}`, `EAA[A-Za-z0-9]{20,}` (Meta tokens), `SECRET-16` → all 0.
2. Fill the numbers (honest: a flake is a flake, a frontend run with timeouts is not "green").
3. `npm audit --omit=dev` both; secret scan of `git diff main...HEAD` both (patterns above + `META_APP_SECRET=` with a value); `git status` clean; `git log --oneline main..HEAD` in the report.
4. Final report (Hinglish).

---

## 4. FINAL CHECKLIST

- [ ] Plan locked + tracker + this prompt committed `[P18B-PLAN]`
- [ ] Read-back after every calling write; `CALLING_SETTINGS_NOT_APPLIED`; Meta error map; UI pending / error states
- [ ] Readiness route + 10 items + cache; switch blocked with the fix; numbers chip; docs §15
- [ ] `calling.lastCallsWebhookAt` set by the `calls` webhook
- [ ] `contacts.waCallPermission` kept in sync; filter key `whatsappCallPermission`; segment; list column; contact page card; calls page entry
- [ ] Bulk request: route, run model, migration 0020, job with all skip reasons, wallet stop, idempotency, progress, notification, audit; dialog from contacts list / list / segment
- [ ] Permission template presets en + hi; status + rejection in dialogs; entry points
- [ ] System "WhatsApp calls" card; health rules `wa-media-no-public-ip`, `wa-call-setup-failing`
- [ ] Catalogue: errors 108, audit 174, notifications 39 — count tests; DATA_MAP + erase map + tenant rules for `callPermissionRuns`; OpenAPI imports
- [ ] Real-device checklist result or the exact missing inputs
- [ ] Release notes / open item
- [ ] Sign-off; CHANGELOGs; BUILD_PLAN_V2; `src/README.md`; tracker
- [ ] Each suite once; Playwright once; log grep 0; `npm audit` 0; secret scan clean; `git status` clean
- [ ] No push / merge / client sync unless the owner asked

## 5. FINAL REPORT (Hinglish, short)

1. Ek line: WhatsApp calling ab kis haal mein hai (platform se enable + read-back, readiness, consent template, bulk permission).
2. Real-device check: hua (nateeje) ya kya input chahiye (number tier, `calls` webhook, server, phones).
3. Numbers: tests before → after, coverage, Playwright.
4. Bugs found + fixed; flakes (honest).
5. Client / owner ke liye open items.
6. Commits list; kuch push nahi hua (unless asked).
