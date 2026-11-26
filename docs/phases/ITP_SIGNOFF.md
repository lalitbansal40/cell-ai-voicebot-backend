# Templates API, Pinnacle partner API, IVR — sign-off (ITP)

Prompt: `docs/prompts/IVR_TEMPLATE_API_PINNACLE_PROMPT.md`. Plan: `docs/plans/IVR_TEMPLATE_API_PINNACLE_PLAN.md`.
26 Nov 2026. **Implemented and verified locally on `main` (both repos); live checks not run** (they need
the owner, a real Meta template review and a Cell24x7 call — tables below).

No env change. No migration (all new fields are additive). No secret in code, tests, docs or audit.

## Before ITP

- The WCF fix (incoming call on the active number, Test calling API `send` step, Meta code 10 hint)
  shipped first, alone: `fix(whatsapp-calling): … [WCF]` in both repos.
- Provider documents: no `Cell24x7_Voice_API.pdf` and no Pinnacle partner API document in the repo →
  decision D1(a): only what the existing clients already use is catalogued; IVR-T5 / IVR-T6 balance skipped.

## Tasks

| Task      | Result        | Notes                                                                                                                                                                              |
| --------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TPL-T1    | ✅            | Scope `templates:write` (`templates.read` + `templates.manage`); `access()` takes a scope list.                                                                                    |
| TPL-T2    | ✅            | Create / detail / edit / delete / submit / media / variables open to keys; list + detail to `templates:read` or `:write`; sync + call-permission template stay dashboard-only.     |
| TPL-T3    | ✅            | API-key actor (`api_key`), `createdByApiKeyId`; per-key rate limit; optional `Idempotency-Key`; Meta-refused submit → `201 DRAFT` + `submitError`.                                 |
| TPL-T4    | ✅            | Webhook event `template.status_changed` (once per status change; sample + docs).                                                                                                   |
| TPL-T5    | ✅            | Public spec + docs with examples, guide "WhatsApp templates by API", template error codes in the public error table.                                                               |
| TPL-T6    | ✅            | Frontend: scope in the key dialog, "Created by API key" chip, webhook event list.                                                                                                  |
| TPL-T7/T8 | ✅            | `tests/templates/api-key-templates.test.ts` (9), access / phase15 matrix / public-docs / catalogue tests.                                                                          |
| PIN-T1    | ✅            | `PARTNER_API_ENDPOINTS` catalogue (groups, examples, curl; calling marked unsupported; Try it on safe GETs only).                                                                  |
| PIN-T2    | ✅            | `GET /admin/accounts/:id/partner-api` and `GET /whatsapp/partner-api` (superadmin full access only) — never the key.                                                               |
| PIN-T3    | ✅            | Reveal: own password + code, lockout 5 / 15 min, 5 / h, 60 s, `no-store`, audit `whatsapp.managed_key_revealed`.                                                                   |
| PIN-T4    | ✅            | Try it: allowlisted GETs from our server, masked answer, 20 / 10 min, audit `whatsapp.partner_api_called`.                                                                         |
| PIN-T5    | ✅            | Error `PARTNER_API_OP_NOT_ALLOWED`, audit rows, `pinnacle.md` section; never in the public spec.                                                                                   |
| PIN-T6    | ✅            | Admin managed number → **Partner API** dialog; Settings → API keys card only in a superadmin full-access login-as.                                                                 |
| PIN-T7/T8 | ✅            | `tests/whatsapp/partner-api.test.ts` (9: refused for owner / admin / view login-as; 404 for another account; not in the public spec), catalogue counts; frontend tests.            |
| IVR-T1    | ✅            | Test connection → `voiceApi.lastCheck` (reason ok / auth / no_credits / timeout / dns / tls / refused / network / error), audit `voice_api.connection_tested`.                     |
| IVR-T2    | ✅ \*         | Send test call (owner OK, 10-digit mobile, 3 / h) + Refresh result from `/details`; audit `voice_api.test_call_sent`. \*See deviation 4.                                           |
| IVR-T3    | ✅            | Last provider answer (keys, statuses, masked sample; details/poll + webhook; Redis 7 days); unknown statuses kept non-final, logged and belled once a day.                         |
| IVR-T4    | ✅            | `voiceApi.ivrDigits`, results filter `digit`, CSV **Key pressed**, `call.completed.voiceApi { status, keyPressed, ivrDisposition }`; frontend bars + filter.                       |
| IVR-T5    | skipped       | No provider PDF naming `/report`.                                                                                                                                                  |
| IVR-T6    | ✅ (402 only) | No balance endpoint known → the card shows "no credits" answers in 24 h.                                                                                                           |
| IVR-T7    | ✅            | `GET/POST /flow-audio` open to keys (`campaigns:read`/`:write`; upload `campaigns:write`), per-key upload limit, public docs with curl; rename / delete / URL stay dashboard-only. |
| IVR-T8    | ✅            | Admin → System → Recorded voice; rules `voice-api-unreachable`, `voice-api-uncertain` (bell + `incidents.md` rows).                                                                |
| IVR-T9    | ✅            | "Incoming calls: not available on Cell24x7" on the card, in the wizard and in `cell24x7-voice.md`. No code path.                                                                   |
| IVR-T10   | ✅            | `cell24x7-voice.md`, `VOICE_API_SIGNOFF.md` live-check table, CHANGELOGs.                                                                                                          |
| IVR-T11   | not run       | Needs the owner present (table below).                                                                                                                                             |

## Deviations

1. **Reveal step-up:** the password + code are sent inline with the reveal request (no separate step-up session).
2. **Admin paths:** `POST /admin/whatsapp/channels/:id/partner-api/reveal|try` (channel-scoped, like the other managed-number actions).
3. **Template drawer:** shows the "Created by API key" chip without the key name (the template keeps only the key id).
4. **Test call (IVR-T2):** a direct one-number provider submit, not a 1-number `isTest` campaign. It is **not
   charged to the wallet** (Cell24x7 credits only) and leaves no campaign row; the result is read from
   `/details` with **Refresh result**. Answers `{ requestId, phoneLast4, content, at }`. Reason: no customer-visible
   test campaigns and no wallet movement for a superadmin check.
5. **IVR-T3 route / bell:** one `GET …/voice-api/diagnostics` (last check, last test call, last shape, unknown
   statuses, 402 count, the account's audio for the picker) instead of `…/last-shape`. The unknown-status bell
   reuses the type `voice_api.provider_error` (once a day per status).
6. **IVR-T4 counts:** computed by an aggregation on read (no cache, final rows only) — no double counting on repeat polls.
7. **IVR-T5** skipped (no PDF). **IVR-T6** is the 402 count only.

## Checks

- **Backend:** prettier ✅, eslint `--max-warnings=0` ✅, `tsc` ✅, `gen:openapi` / `gen:postman` / `gen:guides` committed, `docs:audit` 86 operations, 0 problems.
- **Backend suite** (348 files, groups of 8, `--maxWorkers=4`): 3,177 passed, 4 failed →
  - fixed in this work: `meta-graph-messaging` "never logs tokens" (Meta's error text quoting the request token reached the warn log — now redacted, from WCF) and `sync-indexes` (the `meta-call-error` model was not registered for the production index step, so its 7-day TTL index was never built — from WCF); both pass;
  - known before ITP, clock-dependent, untouched: `tts-cache` 30-day purge, `whatsapp-campaigns` recurrence.
- **Frontend:** `gen:api`, eslint ✅, `tsc -b` ✅, full suite 170 files / 1,661 tests ✅.
- **Secret grep** on both diffs (`mongodb+srv`, `sk-proj`, `sk-…`, `Bearer <token>`, `pin_…`, `CELL24X7_VOICE_API_TOKEN=`, `META_APP_SECRET=`): only the prompt's own checklist text.

## Live checks (owner present, panel only — not run)

| #   | Check                                                            | Expected                                                                             | Result |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ |
| 1   | API key with `templates:write` → curl create with `submit: true` | PENDING                                                                              |        |
| 2   | Approve at Meta / wait                                           | `template.status_changed` webhook received                                           |        |
| 3   | Superadmin → account → managed number → **Partner API**          | endpoints listed; Reveal with step-up shows the key 60 s; Try it `getuserdetails` ✅ |        |
| 4   | The same account's owner → Settings → API keys                   | no Partner API card                                                                  |        |
| 5   | Full-access superadmin → Settings → API keys                     | the Partner API card shows                                                           |        |
| 6   | Cell24x7 live checks                                             | the table in `VOICE_API_SIGNOFF.md` (IVR-T11)                                        |        |

## Still open (not code)

- WhatsApp calls on managed (Pinnacle) numbers: Meta code 10 / 2593180 needs Meta App Review (Advanced
  `whatsapp_business_messaging`) and a Multi-Partner Solution with Pinnacle — the Diagnose `send` step shows it.
- Rotate the secrets that were pasted in chat (MongoDB password, OpenAI key, Meta app secret, JWT secrets,
  encryption key) — none of them is in the repo.
