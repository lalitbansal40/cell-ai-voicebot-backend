# Prompt: WhatsApp calls fail on Meta: show the real error and make calls resilient (WCF)

> **Who runs this:** the coding agent working in `cell-ai-voicebot-backend` + `cell-ai-voicebot-frontend`.
> **Goal in one line:** Meta refuses our call actions (pre_accept / connect) on the managed
> number with calls over Meta direct. We can't see why, because the error only reaches the
> server log and we have **no server access**. Bring Meta's exact error into the app (call
> record, popup, Call details, a superadmin list, a "Test calling API" button). Ring the team
> / AI even when `pre_accept` fails. Never leave a caller ringing. Bring our SDP to Meta's
> format.
>
> Work task by task (WCF-T0 … WCF-T10). Finish a task, run its tests, then move on. Follow the
> repo rules:
>
> - zod → OpenAPI, then regenerate the frontend schema;
> - error-code / audit / notification catalogues and their docs, CHANGELOG;
> - conventional commits (lowercase subject, `[WCF]`);
> - each test suite once per phase, and the full suite in small groups (in-memory Mongo
>   crashes on the full parallel run).

---

## 0. Facts (from the live screenshots, 21 Nov 2026)

- **Number:** Cell, +91 87797 21034, `provider: pinnacle`, **Calls via Meta = on**.
- **Number details:**
  - token …b8ZD ✅, Webhook ✅, Calling on ✅;
  - readiness all ✅: Cloud API, business verified, `calls` events direct, access valid,
    calling enabled, no restrictions, **call audio ready on this server**;
  - prices are placeholder (⚠, not blocking);
  - **messaging limit "Not reported yet"** (card: "Limit Not set").
- **Webhook health:** `calls: 4` in 24 h, so Meta's call events reach us.
- **Inbound call:** the caller's phone only rings. With the AI on or off, nobody can pick it
  up on the panel. The inbox shows "Incoming · Missed call".
  - **Code cause:** in `calls.service.ts startInbound`, `preAcceptCall` throws → the outer
    `catch {}` → `rejectInbound(call, 'meta_failed')`. The team is never rung, and the AI
    never answers.
  - `rejectInbound` swallows `rejectCall` errors, so the caller keeps ringing.
- **Outbound call:** popup "Call failed · Meta returned an error."
  - The call row stores only `error: { code: 'META_API_ERROR' }`.
- **Where Meta's details go today:** only the server log `meta: request failed` (`op`,
  `status`, `code`, `subcode`, `type`, `fbtraceId`). Meta's **message** is never kept.
- The Graph request bodies already match Meta's docs (`connect` / `pre_accept` / `accept` /
  `reject` / `terminate` on `POST /{phone}/calls`). The response schemas are loose.

## 1. Hard constraints

| #   | Constraint                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **No new env variables.** The live `.env` can't be changed. Every new switch is a constant in `src/config/limits.ts` (`WHATSAPP_CALL_LIMITS` or a new `META_CALL_DIAG` block), changed only by a release. Existing env flags keep their defaults.                    |
| C2  | **No server access.** Everything needed to diagnose must be visible in the panel: the call popup, Call details, Admin, Number details. Never rely on `docker logs`.                                                                                                  |
| C3  | **Secrets.** The env the user pasted in chat (Mongo URI, OpenAI key, Meta app secret, JWT, encryption key) must **never** go into code, tests, docs, fixtures or commits. Nothing in this task needs them.                                                           |
| C4  | **Deploy path.** `main` in both repos, then `scripts/sync-client-repo.sh <be> <fe>` (release tag, secret scan, no force push). The client team only pulls and rebuilds. Any migration must be additive, and the code must also work if the migration hasn't run yet. |
| C5  | **No customer data in errors.** Meta's error **message** may be stored and shown, but it is cut to 300 chars and phone-like digit runs (≥ 8 digits) are masked to `…last4`. SDP is never stored or logged (ICE credentials, fingerprint).                            |

## 2. Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | A shared helper `metaCallErrorOf(err, op)` in `src/modules/whatsapp-calling/errors.ts` turns a raw / mapped Meta error into `{ op, httpStatus, metaCode, metaSubcode, type, message, fbtraceId, at }`. `op` is one of `calls.connect`, `calls.pre_accept`, `calls.accept`, `calls.reject`, `calls.terminate`, `settings.get`, `settings.update`, `permissions.get`. A non-Meta error gives `metaCode: null` and `message` = the error name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D2  | **Keep Meta's message in the error object.** `graphError` / `MetaApiError` already parse `error.message`, `error.error_data.details` and `error.error_user_msg`. Make sure they are kept on the error (a new `detail` field if needed) and passed through `callError`, so `metaApiError()` `details[0].message` carries it. The message is masked per C5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D3  | **Call row.** `calls.error` stays `{ code }`, plus optional `meta?: { op, metaCode, metaSubcode, type, message, fbtraceId, at }`. A new timeline event `meta_error` with `{ op, metaCode }`. Every failed call action writes it, including **pre_accept, accept, reject and terminate**, which are swallowed today. `calls.error` is `Mixed` in the model, so no migration is needed for it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D4  | **Collection `metaCallErrors`** (superadmin list). One row per failed calling Graph request: `{ accountId, channelId, callId?, op, metaCode, metaSubcode, type, message, fbtraceId, httpStatus, via: 'meta' \| 'meta_direct' \| 'pinnacle', at }`, TTL `META_CALL_DIAG.errorTtlDays = 7`. Writes are best-effort and never break a call. At most 1 row per (channel, op, metaCode) per 10 s (Redis `SET NX`) so a storm doesn't flood it. Migration `0033-meta-call-errors` creates the TTL + `{ at: -1 }` indexes. The model also declares them (works before the migration).                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D5  | **Admin → WhatsApp → "Meta call errors"** (superadmin): `GET /admin/whatsapp/meta-call-errors?accountId&channelId&limit` lists the latest `META_CALL_DIAG.listLimit = 50`, newest first. Each row shows the account, number (last 4), op, code / subcode, message, fbtraceId, call link and time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D6  | **"Test calling API"** on a number (`POST /whatsapp/channels/:id/calling/diagnose`, `whatsapp.manage`; admin twin; 6 / 10 min / number). It uses `callingClientFor` (so Meta direct with its token) and runs safe read-only checks, each reported `{ key, ok, detail, metaCode }`. **No call is placed.** Audit `whatsapp.calling_diagnosed`. The checks: (1) `debug_token` of the calling token (valid, scopes, WABA); (2) `GET /{phone}?fields=…` — `messaging_limit_tier`, `quality_rating`, `platform_type`, `name_status` (also saved to the channel); (3) `GET /{phone}/settings` calling status + restrictions; (4) our app subscribed + `calls` field; (5) **optional** `GET /{phone}/call_permissions?user_wa_id=` for a contact phone the user types.                                                                                                                                                                                                                                                                   |
| D7  | **pre_accept is not required** (`WHATSAPP_CALL_LIMITS.preAcceptRequired = false`). On a pre_accept failure: save the error (D3 / D4), then carry on. AI route → `acceptInbound` (sends `accept` with the SDP answer). Team route → `ringTeam`, then `accept` on answer. Only an **accept** failure fails the call (`meta_failed`, with the error). `true` brings back today's behaviour.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D8  | **A caller is never left ringing.** `rejectInbound`: try `reject`; if that fails, save the error and try `terminate`; if that fails too, save it as well. The same for an outbound failure after `connect` returned an id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D9  | **Meta SDP format** (`WHATSAPP_CALL_LIMITS.metaSdpStrict = true`). New `src/core/telephony/whatsapp/meta-sdp.ts` with `forMeta(sdp, kind: 'offer' \| 'answer')`. It runs after ICE gathering is complete (non-trickle) and before any Graph call: (a) one audio m-line; (b) codecs **OPUS 48000/2** (+ `telephone-event/8000` when the offer has it); other codecs and their `a=fmtp/rtcp-fb` lines are dropped and the m-line payload list is rewritten; (c) the answer has `a=setup:active`, the offer `a=setup:actpass`; (d) `a=rtcp-mux`, `a=ice-ufrag/pwd`, `a=fingerprint:sha-256` are kept; (e) host candidates on private addresses are dropped when `WA_MEDIA_PUBLIC_IP` is set, and a host candidate with the public IP is kept or added (same port); (f) `a=extmap` lines Meta doesn't use are dropped (keep only `urn:ietf:params:rtp-hdrext:ssrc-audio-level`); (g) `\r\n` line endings, ending with `\r\n`. `describeSdp` before / after goes to the timeline as a shape only (C5). `false` sends the SDP as today. |
| D10 | **Better texts.** The frontend shows `META_API_ERROR` / `WHATSAPP_CALL_FAILED` as `Meta <code>[/<subcode>] (<op>): <message>`. Known codes get a plain hint (table in WCF-T7), e.g. a messaging-limit code → "Is number ki messaging limit kam hai — Meta 2,000/din par calling deta hai."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D11 | **Permissions.** Viewers see errors on calls they can see. The superadmin list is admin only. Diagnose needs `whatsapp.manage` (Full access allowed, view login-as refused).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D12 | **Health.** Admin → System gets `metaCallErrors1h` (count). A new healthwatch rule `wa-meta-call-errors` fires when it is ≥ 5 in 1 h.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

---

## WCF-T0: groundwork (read, no change)

- **Read:**
  - `calls.service.ts`: `startOutbound` connect catch (≈ L945–1010), `rejectInbound`, `acceptInbound`, `startInbound` pre_accept block (≈ L1525–1575), terminate paths (late terminate, signaling.terminate ×2), `callApi`;
  - `errors.ts` (calling): `callError`, `withCallErrors`;
  - `core/meta/errors.ts`: `graphError`, `MetaApiError`, `metaErrorMeta`;
  - `graph.client.ts`: `once`, `call`, `callAction`, `startCall`;
  - `core/telephony/whatsapp/peer.ts`: `createOffer`, `answer`, ICE gathering;
  - `sdp.ts`: `describeSdp`, `scrubSdp`;
  - frontend:
    - the call popup / Call details that print "Meta returned an error";
    - `features/whatsapp/labels.ts` (`whatsappErrorMessage`);
    - `features/whatsapp-calling/labels.ts`;
    - `pages/admin/AdminWhatsAppPage.tsx`.
- **Confirm** where `error.message` / `error_data.details` of Meta's JSON lands in `MetaApiError` (and whether it is scrubbed). List the gaps in the PR description.
- **Confirm** whether production runs migrations at start (`src/server.ts` / `scripts`) or the client team runs them. Write the answer in the sign-off.

## WCF-T1: keep Meta's error (backend core)

- `core/meta/errors.ts`: `MetaApiError` gets `detail: string | null`. Fill it in `graphError`, in this order: `error_data.details` → `error_user_msg` → `message`. Then mask it per C5, cut it to 300 chars, and add it to `metaErrorMeta` (so the log has it too).
- `whatsapp/errors.ts metaApiError`: `details[0].message` = the masked detail. Keep `metaCode`, `metaSubcode`, `fbtraceId`, and add `op` when known.
- `whatsapp-calling/errors.ts`:
  - `metaCallErrorOf(err, op)` (D1);
  - `callError` keeps the Meta details for every mapped code, including `WHATSAPP_CALL_FAILED` and `WHATSAPP_CALLING_*`. Today the specific mappings only carry our reason.
- **Tests:** `graphError` with real Meta error JSON fixtures (add `tests/fixtures/meta/graph-error-call-*.json`):
  - a 138xxx calling error;
  - a 131009 parameter error;
  - a 100 invalid parameter error;
  - a 190 token error.

  Check that a phone number in the message is masked and the detail is kept.

## WCF-T2: `metaCallErrors` model + migration + recorder

- `src/db/models/meta-call-error.model.ts`:
  - fields per D4;
  - indexes `{ at: 1 }` TTL (`expireAfterSeconds = errorTtlDays × 86400`), `{ channelId: 1, at: -1 }`, `{ accountId: 1, at: -1 }`.
- Migration `0033-meta-call-errors`: idempotent `createIndexes`; `down` drops the collection. Register it and add the down step to `tests/db/phase2-migrations.test.ts`. Add `tests/db/wcf-migration.test.ts`.
- `src/modules/whatsapp-calling/meta-errors.ts`:
  - `recordMetaCallError(ctx, { channel, callId?, op, err, via })`;
  - Redis throttle `wa:metaerr:<channel>:<op>:<code>` 10 s;
  - never throws (it logs a warn on failure).
- Privacy:
  - `DATA_MAP` row (7 days, no customer data except a masked message);
  - account purge / erase-map deletes rows by `accountId`;
  - the account export includes them (no secrets).
- Constants in `src/config/limits.ts`:
  ```ts
  export const META_CALL_DIAG = {
    errorTtlDays: 7,
    listLimit: 50,
    throttleSec: 10,
    diagnosePer10Min: 6,
    healthErrorsPerHour: 5,
  } as const;
  // in WHATSAPP_CALL_LIMITS:
  preAcceptRequired: false,
  metaSdpStrict: true,
  ```

## WCF-T3: every call action records its error (calls.service)

- `startOutbound` connect catch:
  - save `error: { code, meta }` (D3) and push timeline `meta_error`;
  - `recordMetaCallError(op 'calls.connect')`;
  - the `call.ended` WS payload gains `error: { code, metaCode, message }`.
- `startInbound` pre_accept (D7):
  - on failure: record + timeline;
  - if `WHATSAPP_CALL_LIMITS.preAcceptRequired` → today's reject;
  - else continue: AI → `acceptInbound`; team → `ringTeam` (as after a successful pre_accept).
- `acceptInbound` / the team answer path: an `accept` failure → record + `rejectInbound(call, 'meta_failed')`, and `calls.error.meta` is set.
- `rejectInbound` (D8): reject → on failure record + `terminateCall` → on failure record. Never throws.
- Terminate paths (late terminate, `signaling.terminate` ×2, busy refusal, unidentified offer): record on failure.
- `noteProviderError` stays as it is (Pinnacle balance).
- **Tests** (`tests/calls-wa/meta-errors.test.ts`, fake Meta `failNext`):
  1. connect fails with a 138xxx error → the call row `error.meta` has the code + masked message; the timeline has `meta_error`; a `metaCallErrors` row exists; the WS `call.ended` carries it.
  2. pre_accept fails, team route, agent online → **the team is rung**, the agent answers → `accept` is sent → the call connects.
  3. pre_accept fails, AI route → the AI answers (`acceptCall` seen).
  4. accept fails → the call ends `meta_failed` with the error; reject is attempted.
  5. reject fails → terminate is attempted; both are recorded; no throw.
  6. `preAcceptRequired = true` (spy the constant) → the old behaviour.
  7. The throttle: 20 connect failures within 10 s → 1 row.
  8. Meta direct: `via: 'meta_direct'` is recorded.

## WCF-T4: Meta SDP format (D9)

- `src/core/telephony/whatsapp/meta-sdp.ts` `forMeta(sdp, kind, { publicIp })`, a pure function.
- `peer.ts` (or the calls service just before `startCall` / `preAcceptCall` / `acceptCall`): apply it when `metaSdpStrict`. Push a timeline `sdp_shape` with `describeSdp` before / after (shape only).
- Make sure ICE gathering completes before the SDP is sent (non-trickle). If gathering times out, send what we have and record it in the timeline.
- **Unit tests** `meta-sdp.test.ts`:
  - fixtures = a real Meta offer (existing `tests/fixtures/meta/calls-sdp-offer.txt`) + a werift answer + a werift offer;
  - OPUS only (+ telephone-event), setup active / actpass, rtcp-mux, fingerprint kept, private candidates dropped, a public-IP candidate present, extmap filtered, CRLF;
  - running it twice changes nothing (idempotent).
- **Loopback test:** the existing `leg-media.test.ts` / `loopback.ts` still passes with `forMeta` applied on both sides (audio flows).

## WCF-T5: "Test calling API" (D6)

- Service `src/modules/whatsapp-calling/diagnose.service.ts` `diagnose(accountId, channelId, actor, { contactPhone? })`:
  - rate limit;
  - checks run in order, each one caught and turned into a step;
  - Meta errors go into the step's `detail` / `metaCode` **and** are recorded (D4);
  - updates `messagingLimitTier` / `qualityRating` / `platformType` from the phone read.
- Meta client: add `getPhoneCallingFacts(token, phoneNumberId)` → `GET /{phone}?fields=messaging_limit_tier,quality_rating,platform_type,name_status,throughput,code_verification_status` (meta + fake + pinnacle stub `unsupported`).
- **Routes:**
  - `POST /whatsapp/channels/:id/calling/diagnose`, body `{ contactPhone?: E.164 }`;
  - admin twin `/admin/whatsapp/channels/:id/calling/diagnose`.

  Plus zod, OpenAPI, and audit `whatsapp.calling_diagnosed` (`{ ok, failedKeys }`).

- **Tests:** a happy path (fake); a token revoked → step 1 ❌ with code 190; a low tier → step 2 ❌ with a messaging-limit hint; a Pinnacle-only number (Meta calling off) → steps use the partner and report `provider_unsupported`; the rate limit; view login-as refused.

## WCF-T6: admin list + health (D5, D12)

- `GET /admin/whatsapp/meta-call-errors` (superadmin; query `accountId?`, `channelId?`, `limit ≤ 50`): rows with the account name, number last 4, op, code, subcode, message, fbtraceId, callId and `at`. Plus zod and OpenAPI.
- `wa-calls-status.ts`: `metaCallErrors1h`. `health-rules.ts`: `wa-meta-call-errors` (≥ `healthErrorsPerHour`). Add its `health-check.ts` text, `incidents.md` row and test.
- `admin.schema.ts` gets the new field. `tests/calls-wa/media-readiness.test.ts` expectations are updated.

## WCF-T7: frontend

- **Error text helper** `features/whatsapp-calling/meta-error.ts`:
  - `metaErrorText(err)` → `Meta <code>[/<subcode>] (<op>): <message>` + a hint per code;
  - **hint table** (fill in with Meta's current calling error list during T0):

    | Code                           | Hint                                                             |
    | ------------------------------ | ---------------------------------------------------------------- |
    | messaging limit / not eligible | Is number ki messaging limit kam hai (Meta 2,000/din chahta hai) |
    | 131009 / 100                   | Call audio ka format Meta ne mana kiya — support ko bhejein      |
    | 190 / 200 / 10                 | Meta access band — Calls via Meta direct → Check / Fix           |
    | 138xxx calling restricted      | WhatsApp ne is number par calling rok rakhi hai                  |
    | default                        | Meta ka message as is                                            |
- **Call popup** (the "Call failed" card): show `metaErrorText` from the WS `call.ended.error` or the API error `details`.
- **Call details page:** a "Meta error" box (op, code, message, fbtraceId with copy) and the timeline label `meta_error` / `sdp_shape`.
- **Number details → Calls via Meta direct:**
  - a **Test calling API** button → a dialog with an optional "Customer number to check permission" field → ✅/❌ steps with code + detail;
  - the button is also shown on managed numbers with Meta calling off (partner checks).
- **Admin → WhatsApp:** a new tab / section **Meta call errors** (a table, filters by account / number, refresh, fbtraceId copy).
- **Admin → System:** "Meta call errors (1 h)".
- API client + hooks + types + `npm run gen:api`.
- **Tests:** the popup shows the code + message; Call details shows the box; the diagnose dialog sends `contactPhone` and renders the steps; the admin table renders rows; the hint mapping.

## WCF-T8: catalogues + docs

- **Catalogues:** audit action `whatsapp.calling_diagnosed`; timeline event labels; healthwatch rule. No new error codes are needed; if one is added, add it to `error-codes.ts` + `docs/conventions/error-codes.md`.
- **Catalogue tests** (`tests/calls-wa/catalogue.test.ts` counts, `full-access-matrix` STEP_UP unchanged, phase15 route matrix BODIES + snapshot for the new routes).
- **Docs:**
  - ADR `0054-meta-call-errors-and-resilient-calls.md`;
  - `docs/setup/meta-whatsapp.md`: "When a call fails" (Test calling API, Meta call errors, codes);
  - `docs/integrations/pinnacle.md` (Meta direct troubleshooting);
  - `docs/ops/incidents.md`; DATA_MAP;
  - CHANGELOGs; `docs/phases/WCF_SIGNOFF.md`.

## WCF-T9: checks

- Backend: `prettier --check`, `eslint --max-warnings=0`, `tsc --noEmit`, `npm run gen:openapi` + `gen:postman` committed.
- Backend tests: the new files first, then the full suite in groups of ≤ 8 files with `--maxWorkers=4`. Known failures on main (tts-cache purge, recurrence) are reported, not fixed.
- Frontend: `gen:api`, eslint, `tsc -b`, the new tests, then the full suite with `--maxWorkers=4` (rerun timeouts alone).
- `git diff` holds no secret from the pasted env (grep for `mongodb+srv`, `sk-proj`, the app secret, `JWT_`).

## WCF-T10: ship + live check (panel only)

1. Commit (`feat(whatsapp-calling): meta call errors in the app and resilient call setup [WCF]`) + push `main` in both repos.
2. `scripts/sync-client-repo.sh <be> <fe> --dry-run`, then the real run. Tell the client team: pull + rebuild (+ migration `0033` if they run migrations by hand). **No env change.**
3. User checklist (`WCF_SIGNOFF.md`):

   | #   | Check                                                       | Expected                                               |
   | --- | ----------------------------------------------------------- | ------------------------------------------------------ |
   | 1   | Number details → **Test calling API** (with the test phone) | ✅/❌ per step with Meta's code — screenshot           |
   | 2   | Call the number from another phone (AI off)                 | the panel rings, answer → audio; or a Meta error shown |
   | 3   | AI on, call again                                           | the AI answers                                         |
   | 4   | Outgoing **Call myself**                                    | connects; or the popup shows `Meta <code>: …`          |
   | 5   | Admin → WhatsApp → **Meta call errors**                     | every failure listed with code + message + fbtraceId   |

4. Send the codes back. The last fix (messaging limit outreach / SDP tweak / token) follows the D10 table.

## Done means

- All of WCF-T1…T10 are done and there's no TODO left.
- No env change.
- No secret committed.
- Tests are green except the known main failures.
- Both mains are pushed and the client repo is released.
- The user can read Meta's exact reason for any failed call from the panel.
