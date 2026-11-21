# Prompt: calls over Meta Graph on a managed (Pinnacle) number (PMC)

> **Who runs this:** the coding agent working in `cell-ai-voicebot-backend` + `cell-ai-voicebot-frontend`.
> **Goal in one line:** a managed number keeps messages, templates, campaigns, media, profile
> and the credit line on **Pinnacle**. Only **WhatsApp calling** moves to the **Meta Graph API**,
> using our own Meta app's token. Calls webhooks come **straight from Meta to our URL**.
> In Number details → Calling there is one button, **"Calling on karo (Meta direct)"**.
>
> Work task by task (PMC-T0 … PMC-T11). Finish a task, run its tests, then move on. Don't skip
> anything listed under "Must do". Follow the repo rules: zod → OpenAPI, the error-code
> catalogue, audit docs, CHANGELOG, conventional commits (lowercase subject), and each test
> suite only once per phase (see memory "Fewer test runs").

---

## 0. Why (what's broken today)

- Meta logs our inbound calls (Allow voice calls = ON), but our webhook never receives a
  `calls` event. Pinnacle relays `messages`, `account_settings_update` and
  `phone_number_name_update`, but **not `calls`**.
- Our channel shows calling `unavailable / provider_unsupported`: Pinnacle refuses the
  calling-settings API, so `startInbound` rejects every call.
- All call control goes through `clientFor(ctx, channel)`. For `provider: 'pinnacle'` that
  returns the Pinnacle client, which can't do calling.
- The Meta webhook route **drops** every change for a managed number (`changesFor()` →
  `managedNumbers()` in `src/modules/whatsapp/webhooks.service.ts`). So even if Meta sent
  `calls` to us, we would throw it away.

## 1. Decisions (final, don't re-litigate)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Method A is the main path, open to anyone who can manage the number.** That means owner/admin with `whatsapp.manage`, and a superadmin in Full access. The flow: our Embedded Signup popup (same FB SDK launcher as Connect / Switch-to-Meta, `features/whatsapp/embedded-signup.ts`). The customer picks the **existing** WABA and number, and the server swaps the `code` for a business token of **our** app.                                    |
| D2  | **Method B is a superadmin-only fallback**, hidden under "Advanced" in the dialog and on the admin twin route: paste a System User access token. It's for the case where the popup can't share that WABA. B goes through the same checks as A (D7). An owner/admin never sees B.                                                                                                                                                                      |
| D3  | `provider` **stays `'pinnacle'`**. Nothing about messages changes. This is **not** `switchToMeta` (SAC-T11 stays as a separate, heavier option).                                                                                                                                                                                                                                                                                                      |
| D4  | New channel sub-document **`metaCalling`**. Its token `tokenSealed` uses `select: false`, is sealed with `sealSecret`, and never appears in an API response, export, log or audit (store last4 only).                                                                                                                                                                                                                                                 |
| D5  | New helper **`callingClientFor(ctx, channel)`** → `{ api: MetaClient, token: string, via: 'meta' \| 'pinnacle' \| 'meta_direct' }`. If the number is managed and `metaCalling.status === 'on'`, it returns `ctx.meta` plus the metaCalling token. Otherwise it returns today's `clientFor` plus the channel token. **Every** call API in `src/modules/whatsapp-calling/**` uses it, and `pinnacle-routing.test.ts` / the routing guard enforces that. |
| D6  | Through Graph (`meta_direct`): `startCall`, `preAcceptCall`, `acceptCall`, `rejectCall`, `terminateCall`, `getPhoneSettings`, `updateCallingSettings`, `getCallPermissions`, and the readiness `debugToken` check. Still through **Pinnacle**: the call-permission **request** message and template (it's a message), every send, receipts, media, templates and profile.                                                                             |
| D7  | **Token checks (A and B):** `debug_token` says valid; scopes include `whatsapp_business_messaging` **and** `whatsapp_business_management`; `granted WABA ids` includes `channel.wabaId`; and `listPhoneNumbers(token, wabaId)` contains `channel.phoneNumberId`. Any mismatch → `WHATSAPP_META_CALLING_MISMATCH`, and nothing is saved.                                                                                                               |
| D8  | **Webhook (automatic on enable, plus a Check/Fix button):** subscribe our app to the WABA (`POST /{waba}/subscribed_apps`), then make sure the app subscription has `calls` + `account_settings_update` (reuse `checkWebhook(..., { fix: true })` with the metaCalling token), then read it back. Result goes to `metaCalling.webhookCheck` (same shape as `WaWebhookState`).                                                                         |
| D9  | **Meta webhook ingest for managed numbers:** if the number has metaCalling `on`, keep **only** fields in `META_DIRECT_FIELDS = ['calls', 'account_settings_update']`. Drop everything else (messages and statuses arrive from Pinnacle; this prevents duplicates and double charges). If it's not `on`, drop everything as today. Log metric `meta_webhook_managed_kept` / `meta_webhook_foreign_provider`.                                           |
| D10 | **Pinnacle relay for a metaCalling `on` number:** drop `calls` changes coming from Pinnacle (Meta direct is the one source), metric `pinnacle_webhook_calls_dropped`. Keep everything else. Call claim dedup stays as the last safety net.                                                                                                                                                                                                            |
| D11 | **Money:** Meta bills calls to the WABA's payment method, which is Pinnacle's credit line; we don't touch `creditLine`. Our wallet charging for calls (billing engine) doesn't change. The dialog says so in one line.                                                                                                                                                                                                                                |
| D12 | **Enable sets calling ON at WhatsApp if it's OFF.** It calls `updateCallingSettings` with `status: ENABLED`, keeps existing hours/icon/callback, then runs `syncCalling`. `provider_unsupported` is never set while metaCalling is `on`.                                                                                                                                                                                                              |
| D13 | **Disable** (`DELETE`) does this: optional `turnOffAtWhatsApp` (default `false`); delete the token; set `status: 'off'`; unsubscribe our app from the WABA as best effort, **only** when no other channel of ours uses that WABA via Meta; then run `syncCalling` → it goes back to `provider_unsupported` as before.                                                                                                                                 |
| D14 | **Token health:** the daily calling sync plus a `check` call run `debugToken`. If the token is invalid or WABA access is lost: `status: 'error'`, `error.code = 'token_invalid'`, a bell notification `whatsapp.meta_calling_broken` (once per ok→error), healthwatch rule `wa-meta-calling-broken`, and calling becomes `unavailable / meta_calling_broken` until it's fixed.                                                                        |
| D15 | **Permissions:** `whatsapp.manage` (owner/admin). A Full-access superadmin is allowed with no step-up. A View login-as is refused (`blockWhenImpersonating`). Method B (`accessToken`) is accepted only from an admin route **or** an `imk: 'superadmin'` full session; otherwise 403 `WHATSAPP_META_CALLING_TOKEN_FORBIDDEN`.                                                                                                                        |
| D16 | Rate limit: 6 enable/check attempts per 10 minutes per number (same pattern as `fixWebhook`), error `RATE_LIMITED`.                                                                                                                                                                                                                                                                                                                                   |
| D17 | Env `WA_META_CALLING_ENABLED` (default `true`). When `false`, routes answer `WA_META_CALLING_DISABLED` (409) and the button is hidden (`/whatsapp/config` exposes the flag).                                                                                                                                                                                                                                                                          |
| D18 | `switchToMeta` on a number with metaCalling `on`: clear `metaCalling` (set off and delete the token) after a successful switch, because the main token now does everything. Deleting or disconnecting a channel also clears `metaCalling`.                                                                                                                                                                                                            |
| D19 | Readiness for a managed number with metaCalling `on`: the "calls webhook" check reads `metaCalling.webhookCheck.status === 'ok'` (not `pinnacle.webhookSetAt`). The "token" check runs `debugToken` on the metaCalling token. New readiness check key `meta_direct` ("Calls via Meta direct"): pass when `on`, fail with a CTA "Calling on karo" when `off` or `error`.                                                                               |
| D20 | Audits: `whatsapp.meta_calling_enabled`, `whatsapp.meta_calling_disabled`, `whatsapp.meta_calling_failed` (with `step`), `whatsapp.meta_calling_checked`. Metadata: `method` (`embedded_signup` \| `system_user_token`), `tokenLast4`, `steps`. Never the token itself.                                                                                                                                                                               |
| D21 | Migration **`0032-wa-meta-calling`**: additive. Set `metaCalling = { status: 'off', … }` where it's missing, and add a sparse index `{ 'metaCalling.status': 1 }`. Idempotent; `down` unsets it.                                                                                                                                                                                                                                                      |

### Before coding: Meta-side prerequisites (put them in the docs and in the dialog's help text)

1. Our Meta app has **advanced access** for `whatsapp_business_messaging` and
   `whatsapp_business_management` (App Review was submitted 2026-10-30; until it's approved,
   Method A works only for businesses/testers on our app).
2. The app webhook callback is `https://<api>/api/v1/webhooks/meta`, verified with
   `META_WEBHOOK_VERIFY_TOKEN`. The fix step adds the fields; the callback must already be verified.
3. Pinnacle is told that our app is also subscribed to the WABA. They must not answer or
   terminate calls (today they don't support calling at all).

---

## PMC-T0: groundwork (read and confirm, no behaviour change)

Must do:

- Read and list every call site (expected about 10):
  - `src/modules/whatsapp-calling/calls.service.ts`: startCall, preAcceptCall, acceptCall, rejectCall, terminateCall ×3,
  - `settings.service.ts`: getPhoneSettings, updateCallingSettings,
  - `permissions.service.ts`: getCallPermissions,
  - `readiness.ts`: debugToken + the `provider === 'pinnacle'` branches at about lines 138/161/312,
  - `deps.token` / `runtime.ts` `token()`.
- Read:
  - `changesFor` / `managedNumbers` / `resetManagedNumbersCache` in `webhooks.service.ts`,
  - `checkWebhook` in `webhook-check.ts`,
  - `connect()` token checks (`REQUIRED_META_SCOPES`, `resolveWaba`, `pickPhone`) in `whatsapp.service.ts`,
  - `switchToMeta`.
- Confirm the fake world: `FakePinnacle.seedManagedNumber` creates the WABA/number inside the
  fake Meta, so `codeFor(signup)` for the same business/phone yields a token that can see it.
  If it can't, extend the fake (T9).
- Write the call-site list in the PR description.

## PMC-T1: data model + migration

Must do:

- `src/db/models/whatsapp-channel.model.ts` gets:
  ```ts
  metaCalling: {
    status: 'off' | 'on' | 'error';            // default 'off'
    method: 'embedded_signup' | 'system_user_token' | null;
    tokenSealed: string | null;                // select: false
    tokenLast4: string | null;
    tokenExpiresAt: Date | null;               // from debug_token (null = never)
    scopes: string[];
    webhookCheck: WaWebhookState;              // reuse the type + defaultWebhookState()
    enabledAt: Date | null;
    enabledBy: ObjectId | null;
    checkedAt: Date | null;
    error: { code: string; step: string | null; message: string } | null;
  }
  ```
- Add `defaultMetaCalling()`. Add `'meta_calling_broken'` to the calling `unavailableReason` enum.
- Migration `src/db/migrations/0032-wa-meta-calling.ts`, registered in `index.ts`, with a migration test (up twice = same result, down).
- `channelListItem` / the channel DTO exposes `metaCalling` **without** `tokenSealed`:
  `{ status, method, tokenLast4, tokenExpiresAt, webhookCheck, enabledAt, checkedAt, error }`.
  Update the zod response schema + OpenAPI.
- Privacy:
  - `DATA_MAP` entry (token = secret, deleted on disconnect/erase),
  - account export excludes the token,
  - the account-delete path clears it.

## PMC-T2: `callingClientFor` + token source

Must do:

- `src/modules/whatsapp/context.ts`: export `callingClientFor(ctx, channel, tokens)`. Keep it
  pure: given the channel (with `+metaCalling.tokenSealed` selected) it returns
  `{ api, token, via }` per D5. Throws `WA_META_CALLING_BROKEN` when `status === 'error'`.
- `whatsapp.service.ts`: `getCallingToken(channelId)` → `{ token, via }`, server-side only, like `getChannelToken`.
- `runtime.ts` / calling `deps`: replace the `token()` used for **call APIs** with
  `callingToken()`. Keep `token()` for the permission-request **message** path.
- Replace every call site from T0 with `callingClientFor`. `clientFor` must no longer appear in
  `src/modules/whatsapp-calling/**` except the permission-request send.
- Update `tests/whatsapp/pinnacle-routing.test.ts` (routing guard): calling module →
  `callingClientFor`; a managed + `on` number hits the fake Meta, not fake Pinnacle.

## PMC-T3: enable / disable / check service

New file `src/modules/whatsapp/meta-calling.service.ts` (wired into the WhatsApp service factory):

- `enable(accountId, channelId, input: { code } | { accessToken }, actor, opts: { allowToken: boolean })`:
  1. Load the channel. If it's not `pinnacle` → `WHATSAPP_META_CALLING_NOT_MANAGED`. If the env flag is off → `WA_META_CALLING_DISABLED`. Check the rate limit (D16).
  2. **token:** `meta.exchangeCode(code)`, or the pasted token when `allowToken`; otherwise `WHATSAPP_META_CALLING_TOKEN_FORBIDDEN`.
  3. **verify:** D7 checks. Map errors through the existing `signupError` style into step `verify` / `waba` / `phone`.
  4. Save `tokenSealed`, `tokenLast4`, `scopes`, `tokenExpiresAt`, `method`. Status stays `off` until step 7.
  5. **webhook:** `meta.subscribeApp(token, wabaId)`, then `checkWebhook(ctx, { wabaId, webhookCheck }, token, { fix: true, now })`. Store it in `metaCalling.webhookCheck`. If it fails → status `error`, step `webhook` (the token stays, so Check/Fix can retry).
  6. **calling at WhatsApp:** `getPhoneSettings`. If it's not ENABLED → `updateCallingSettings({ status: 'ENABLED', … })` (D12). Failure → `error`, step `calling`.
  7. Set `status: 'on'`, `enabledAt`, `enabledBy`, `error: null`. Call `resetManagedNumbersCache()`, then `settings.syncCalling(channel, { throwOnError: false })`.
  8. Audit (D20), emit WS `whatsapp.channel_updated`, return `{ channel, steps: [{ key, ok, detail }] }`.
     Steps are `token`, `verify`, `app_subscribed`, `fields`, `calling_on`.
- `disable(accountId, channelId, { turnOffAtWhatsApp }, actor)` per D13. Audit, reset the cache, sync.
- `check(accountId, channelId, actor, { fix: true })`: debugToken + webhook check/fix + settings
  read. Updates `status` (`on` ↔ `error`) and fires the bell on ok→error (D14). Audit `checked`.
- `sweep()`: daily (hook into the existing calling daily sync job). Runs `check({ fix: false })`
  for every `metaCalling.status in ['on','error']`.
- Error codes to add to the catalogue + `docs/api/error-codes.md` (status, message, hint):
  - `WHATSAPP_META_CALLING_NOT_MANAGED` (409),
  - `WHATSAPP_META_CALLING_MISMATCH` (422, "The popup shared another WhatsApp account/number — pick <+91…last4>"),
  - `WHATSAPP_META_CALLING_SCOPES` (422),
  - `WHATSAPP_META_CALLING_TOKEN_FORBIDDEN` (403),
  - `WA_META_CALLING_DISABLED` (409),
  - `WA_META_CALLING_BROKEN` (409).

## PMC-T4: routes

- `src/modules/whatsapp/whatsapp.routes.ts` (`...manage`, `blockWhenImpersonating` for view):
  - `POST /whatsapp/channels/:id/meta-calling`. Body is `{ code: string, wabaId, phoneNumberId }` **or**
    `{ accessToken: string }`. For `accessToken`, `allowToken = isFullAccess(req) && req.auth.imk === 'superadmin'`.
  - `DELETE /whatsapp/channels/:id/meta-calling` with body `{ turnOffAtWhatsApp?: boolean }`.
  - `POST /whatsapp/channels/:id/meta-calling/check`.
- Admin twins under `/admin/accounts/:accountId/whatsapp/channels/:id/meta-calling` (+ `/check`, DELETE), with `allowToken: true`.
- zod schemas → OpenAPI (`npm run openapi`), then regenerate the frontend `schema.gen.ts`.
- `/whatsapp/config` adds `metaCallingEnabled`.
- Update `tests/security/full-access-matrix.test.ts` expectations: the new routes are reachable in full access and are **not** step-up, so the `STEP_UP` list stays the same. Add the routes to the phase15 route-matrix BODIES and snapshot.

## PMC-T5: webhook ingest (D9, D10)

- `webhooks.service.ts`:
  - `managedNumbers()` → a `Map<phoneNumberId, { metaDirect: boolean }>` (still cached; reset on enable/disable/check status flips).
  - `changesFor` with source `meta`: for a managed number, keep a change only when `metaDirect && META_DIRECT_FIELDS.includes(change.field)`.
    `account_settings_update` and other WABA-level changes with no `phoneNumberId` keep today's behaviour.
  - Source `pinnacle`: drop `change.field === 'calls'` when the channel is `metaDirect`.
- `fastPath` for `calls` must work for these numbers (the event processor already resolves the channel by `phoneNumberId`; confirm this and test it).
- Export `META_DIRECT_FIELDS` from `core/meta/schemas.ts`.

## PMC-T6: calling settings + readiness

- `settings.service.ts`:
  - `syncCalling` / `updateCalling` use `callingClientFor`.
  - `markPartnerUnsupported` only runs when `via === 'pinnacle'`.
  - When `via === 'meta_direct'`, errors are normal Meta errors (`lastError`), and `tokenInvalid` → `metaCalling.check` marks the number broken (D14).
- `callingUnavailableReason`: `meta_calling_broken` when `metaCalling.status === 'error'`.
- `readiness.ts` per D19 (new check `meta_direct`; webhook + token checks from metaCalling). Update the readiness labels (backend + frontend `features/whatsapp-calling/labels.ts`).
- Inbound route validation (`incoming-default.ts aiRouteProblems`, `settings.service` checks) works unchanged, because calling status now comes from Meta.

## PMC-T7: alerts + health

- Notification type `whatsapp.meta_calling_broken` in the notification catalogue, plus bell text and a deep link to Number details → Calling.
- Healthwatch rule `wa-meta-calling-broken` (count of channels with status `error` > 0).
- Admin → System: show the count of `metaCalling on / error`.
- Metrics/log keys: `meta_webhook_managed_kept`, `pinnacle_webhook_calls_dropped`, `meta_calling_enable` (`{ ok, step }`).

## PMC-T8: frontend

Files in `cell-ai-voicebot-frontend/src/features/whatsapp/numbers/`:

- **`MetaCallingSection.tsx`** (inside `ChannelDrawer.tsx` → Calling area, managed numbers only):
  - When `off` or `error`: a primary button **"Calling on karo (Meta direct)"**. If `error`, an alert shows the step + message, plus a **Retry check** button.
  - When `on`: chip **"Calls via Meta"** ✅, token last4 + expiry, webhook status (reuse the `WebhookCheck` chip pattern with `metaCalling.webhookCheck`), and buttons **Check / Fix** and **Calling off** (confirm dialog with a "Turn calling off at WhatsApp too" checkbox).
- **`MetaCallingDialog.tsx`**:
  1. An explainer: "Messages, templates, campaigns aur credit line Pinnacle par hi rahenge. Sirf calls Meta Graph se chalengi. Call ka Meta charge Pinnacle credit line se hi jayega." It shows the number `+91…last4` that must be chosen in the popup.
  2. **Continue with Facebook** opens Embedded Signup (reuse the `embedded-signup.ts` launcher and session-info listener, the same way `SwitchToMetaDialog.tsx` does). Then POST `{ code, wabaId, phoneNumberId }`.
  3. **Advanced (superadmin only)** accordion: shown only when `useIsFullAccess()` and the impersonator is a superadmin. It has a password-type field "System User token" → POST `{ accessToken }`.
  4. Progress list from `steps`: Token ✅ → Number verified ✅ → App subscribed ✅ → `calls` webhook ✅ → Calling ON at WhatsApp ✅. A failed step shows ❌ with its message and a Retry button.
  5. On success: invalidate the channel + calling queries; toast "Calling on — ab is number par call aayegi".
- `ChannelCard.tsx`: managed + `on` → chip **"Calls via Meta"**; managed + off → "Calls off (partner)" chip that links to the drawer. Replace the old "Calls via partner" text.
- API client `services/api/whatsapp.ts`: `enableMetaCalling`, `disableMetaCalling`, `checkMetaCalling`. Add query keys.
- Hide everything when `config.metaCallingEnabled === false`.
- Texts go in `texts.ts` (Hinglish, matching the existing tone). Keep `SwitchToMetaDialog` as it is, under a "More" menu.
- Lint rules: helpers in their own files (react-refresh), no `Date.now()` in render, import order.

## PMC-T9: tests (fake Meta + fake Pinnacle)

Backend: `tests/whatsapp/meta-calling.test.ts`, `tests/whatsapp/meta-calling-webhook.test.ts`, `tests/whatsapp-calling/meta-direct-calls.test.ts`:

1. Enable with the code of the same WABA/number → `on`, steps all ok, token sealed (not in the API response), audit `enabled`, `webhookCheck.ok`, calling status `enabled` (not `provider_unsupported`).
2. Code for another number → `MISMATCH`, nothing saved. Missing scope → `SCOPES`. Meta number → `NOT_MANAGED`.
3. `setAppSubscription` fails → status `error` step `webhook`; then `check` repairs → `on`.
4. Calling OFF at Meta → enable turns it ON (`updateCallingSettings` called on the **fake Meta**).
5. Routing: managed + `on`:
   - `startOutbound` / accept / reject / terminate hit fake Meta (ops list), never fake Pinnacle;
   - a text send still hits fake Pinnacle;
   - the permission-request message still goes via Pinnacle.
6. Meta webhook:
   - for a managed + `on` number, `messages` is dropped and `calls` is stored and fast-pathed → inbound call rings the team (presence ring);
   - for a managed + `off` number, everything is dropped;
   - Pinnacle relay `calls` for an `on` number is dropped and its `messages` are kept.
7. AI incoming (`waIncoming` = AI) on a managed + `on` number → the AI answers.
8. Token invalid (fake `debugToken` invalid) → `check` → `error`, bell once, calling `meta_calling_broken`, `callingClientFor` throws `WA_META_CALLING_BROKEN`.
9. Disable → token removed, status `off`, calling back to `provider_unsupported`, cache reset, audit.
10. HTTP:
    - viewer GET ok, POST 403;
    - owner POST with `accessToken` → 403 `TOKEN_FORBIDDEN`;
    - Full-access superadmin with `accessToken` → 200;
    - View login-as → `AUTH_IMPERSONATION_BLOCKED`;
    - admin twin works;
    - rate limit on the 7th call.
11. `switchToMeta` clears metaCalling; channel delete clears the token; the migration test.

Frontend: `meta-calling.test.tsx`:

- The button is shown only for managed numbers.
- The dialog explainer, the popup mock → POST body, and the progress steps rendering ok/failed.
- The Advanced token field is hidden for an owner and shown for a full-access superadmin.
- Calling off confirm sends `turnOffAtWhatsApp`.
- The card chip changes.

Run each suite **once** (backend changed files + routing/security matrices, then frontend). Before pushing, run the full backend + frontend once, plus lint and typecheck. Known failures that also happen on main (tts-cache purge, recurrence) are reported, not "fixed" here.

## PMC-T10: docs

- `docs/adr/0053-managed-number-meta-direct-calling.md`: context, D1–D21, alternatives (switchToMeta, waiting for Pinnacle).
- `docs/integrations/pinnacle.md`: a "Calls via Meta direct" section. `docs/setup/meta-whatsapp.md`: prerequisites (advanced access, callback, fields).
- Audit docs, error-code docs, notification catalogue doc, websocket doc (if a new event), DATA_MAP, env examples (`WA_META_CALLING_ENABLED`), backend + frontend CHANGELOG, `docs/phases/PMC_SIGNOFF.md` (checklist below).

## PMC-T11: ship + live test

1. Commit in small conventional commits (`feat(whatsapp): …`, lowercase). Push backend `main`, then frontend `main`.
2. Run `scripts/sync-client-repo.sh <be-ref> <fe-ref>` to create the release tag and push to Cell24x7/cell-ai-voicebot `phase13` folders (no force push, secret scan). Tell the client team: rebuild + migration `0032` + env `WA_META_CALLING_ENABLED=true`.
3. Live checklist (write the results in `PMC_SIGNOFF.md`):
   1. Number details → **Calling on karo** → popup → pick the same WABA/number → all steps ✅.
   2. Admin → webhook health: after a test call, a `calls` event appears with source `meta`.
   3. Call from another phone → the inbox rings → answer → audio both ways → hang up → call row `completed`, wallet charged once.
   4. AI incoming ON → call → the AI answers; OFF → the team rings.
   5. Inbox **Call myself** / **Call with AI** / **Schedule AI call** to a customer with permission → it connects.
   6. Send a message → it goes via Pinnacle; no duplicate message from the Meta webhook.
   7. Calling off → an inbound call no longer rings; calling on again works.
   8. If the popup can't show the WABA, use superadmin **Advanced → System User token** and repeat steps 1–3.

## Done means

- All of PMC-T1…T11 are done and there's no TODO left.
- Tests are green except the known main-branch failures.
- OpenAPI and the frontend schema are regenerated.
- Docs are updated.
- Both mains are pushed and the client repo is synced with a release tag.
- The live checklist is filled in.
