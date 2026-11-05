# Phase 19 — Open signup, reseller panel, bulk WhatsApp campaigns (detailed plan)

**Status:** Locked (2026-11-04) — defaults D1–D12 in use · **Branches:** `feature/phase-19-reseller-campaigns` (both repos) · **Size:** L (≈ 6–8 working days) · **Roadmap:** BUILD_PLAN_V2 Phase 20 (bulk campaigns) moves up and is joined by signup + resellers; Inbound phone calls (old Phase 19) becomes Phase 20.

**Owner amendment — 5 Nov 2026:** Remaining work and added scope are specified in
[PHASE_19_CONTINUATION_PROMPT.md](../prompts/PHASE_19_CONTINUATION_PROMPT.md), which
supersedes conflicting historical requirements here. Three campaign types: **SIP / Normal
call**, **WhatsApp message**, **WhatsApp call**. Bulk messaging caps per sender: **18 msg/sec**
for Business App/coexistence; **75 msg/sec** for confirmed regular WhatsApp Cloud API,
subject to lower limits. WhatsApp incoming and outgoing AI use active agents or published
flows. Templates/approval/send and call actions must respect the selected connected
number and its capabilities. The continuation includes unfinished T19.13/T19.15/T19.16,
frontend role checks, recurrence/media/estimate gaps, testing and sign-off. No completion
claim is made by adding these requirements; see the continuation tracker.

---

## 0. Goal

1. **Signup without e-mail:** anyone fills a simple form (business name, name, e-mail, phone, password, account type **Business** or **Reseller**) and is logged in immediately. No e-mail, no OTP.
2. **Three levels, one platform:**
   - **Superadmin** (platform) → creates resellers and business users, sees everyone, **logs in as** any reseller or business.
   - **Reseller** → creates its own **customers** (business accounts under it), gives them wallet credit, **logs in as** them, suspends / enables them.
   - **Business** (normal user, direct or under a reseller) → uses the product as today.
3. **Bulk WhatsApp campaigns:** a template sent to thousands (lists / segments / tags / CSV), cost preview + wallet check, tier pacing, pause / resume / stop, live stats (sent / delivered / read / replied / failed by reason), retry failed, export, reports.
4. **Bulk WhatsApp calling campaign:** the existing Phase 8 campaign engine on the WhatsApp line, only for contacts that allowed calls.

### Kya NAHI hoga (is phase mein)

- White-label (reseller's own logo / domain / brand colours) — open item for a later phase; the data model leaves room (`account.reseller.brand`).
- Reseller-of-reseller (only one level: platform → reseller → customer).
- Automatic revenue share / commission engine (resellers sell credit at their own price outside the platform — §2 D4).
- URL-button click tracking (needs a redirect domain) — later.
- SMS / e-mail campaigns.

---

## 1. What was checked (4 Nov 2026)

### 1a. Already built — reuse

| Area                      | Exists                                                                                                                                | Where                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Signup                    | `POST /auth/signup` → account + owner, **e-mail code** (`verify-email`), login refuses unverified (`AUTH_EMAIL_NOT_VERIFIED`)         | `modules/auth/auth.service.ts`, `login.service.ts` |
| Superadmin create account | Owner name + e-mail + **password** (no mail)                                                                                          | `admin.service.ts` `createAccount`                 |
| Login as                  | Superadmin **view-as** (impersonation token, 1 h, no refresh, audited both sides, banner, `blockWhenImpersonating` on 31 route files) | `admin.service.ts` `impersonate`                   |
| Roles                     | owner / admin / manager / agent / viewer + custom roles; `platformRole: superadmin`                                                   | `modules/rbac`                                     |
| Wallet                    | per account, Razorpay top-up, holds, ledger, low-balance bells                                                                        | `modules/wallet`, `billing`                        |
| Voice campaigns           | Phase 8 engine: audience snapshot, claims, restart safety, pacing, windows, retries, results, export                                  | `modules/campaigns`                                |
| Templates                 | builder, sync, statuses, variables with contact sources, price preview                                                                | `modules/templates`, `whatsapp-billing`            |
| Template send             | priced + held, idempotent `clientId`, statuses → message                                                                              | `inbox/outbound.service.ts`                        |
| Audience                  | lists, segments (filter compile), DND, suppression, marketing stop                                                                    | `contacts`, `segments`, `privacy`                  |
| Bulk permission run       | job + cursor + skip reasons pattern (Phase 18B)                                                                                       | `whatsapp-calling/bulk-permissions.ts`             |
| WhatsApp calls            | business-initiated calls, dial guard, billing                                                                                         | `whatsapp-calling/calls.service.ts`                |

### 1b. Gaps

| #   | Gap                                                                | Task         |
| --- | ------------------------------------------------------------------ | ------------ |
| G1  | Signup needs the e-mail code; no account type                      | T19.2        |
| G2  | Accounts are flat: no `kind`, no parent                            | T19.1        |
| G3  | No reseller panel / API; nobody but superadmin can create accounts | T19.5, T19.8 |
| G4  | Login-as is superadmin-only and view-only                          | T19.3        |
| G5  | No wallet credit transfer between accounts                         | T19.6        |
| G6  | No bulk WhatsApp template campaign                                 | T19.9–T19.14 |
| G7  | Campaign engine can't dial over WhatsApp                           | T19.15       |

---

## 2. Decisions (recommended default first — owner confirms before the run prompt)

| #   | Question                                      | Default                                                                                                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | E-mail verification removed for **everyone**? | **Yes.** Signup = logged in. Protection instead: IP limit 5 signups / hour, honeypot field, password rules (existing), superadmin switch **Signup open / closed** and **Reseller signup open / closed**.                                                                                                                                                |
| D2  | Reseller signup active at once?               | **Yes** (as asked). Platform setting `resellerSignup: 'open' \| 'approval' \| 'closed'`, default `open`; `approval` = the reseller can log in but can't create customers until a superadmin approves.                                                                                                                                                   |
| D3  | Login-as: view only or act?                   | **Act** (`mode: 'act'`): the reseller / superadmin can work in the customer's account. Still **blocked** while logged in as: password / MFA / sessions of the owner, API keys, team role of the owner, account delete / export, wallet top-up / refund, payment settings. Superadmin keeps today's **view** mode too (button "View as" vs "Log in as"). |
| D4  | Money between reseller and customer?          | **Credit transfer.** The reseller tops up its own wallet (Razorpay, platform prices) and **transfers** credit to a customer (ledger pair, atomic); it can take back unused credit. Customers are charged at the platform price from their own wallet. What the reseller charges its customer is outside the platform.                                   |
| D5  | Can a reseller's customer top up by Razorpay? | **No** by default (reseller setting `customersCanTopUp`, default off): the money goes to the platform, not the reseller.                                                                                                                                                                                                                                |
| D6  | Does the reseller see its customers' data?    | Only the **summary** in the panel (name, status, owner, wallet, usage 30 d, last active). Data (contacts, chats, calls) only through **Log in as** (audited).                                                                                                                                                                                           |
| D7  | Suspend a reseller → its customers?           | Customers keep working; the reseller can't log in. Superadmin can suspend customers one by one or "suspend all customers" (confirm).                                                                                                                                                                                                                    |
| D8  | Existing unverified signups                   | Migration marks them verified (the rule changed), so they can log in.                                                                                                                                                                                                                                                                                   |
| D9  | Existing accounts                             | `kind: 'business'`, no parent; the platform account `kind: 'platform'`.                                                                                                                                                                                                                                                                                 |
| D10 | Same e-mail in two accounts?                  | No (unchanged: one user = one account, e-mail unique). A reseller's staff are users of the reseller account.                                                                                                                                                                                                                                            |
| D11 | Bulk campaign scope                           | WhatsApp **template** campaigns (full) + WhatsApp **call** campaigns (Phase 8 engine, allowed contacts only). Voice (phone) campaigns already exist.                                                                                                                                                                                                    |
| D12 | Marketing template opt-out                    | Contacts with `whatsapp.marketing.stopped` are skipped for MARKETING templates (Meta rule); UTILITY still allowed.                                                                                                                                                                                                                                      |

---

## 3. Data model

- `accounts.kind`: `platform` \| `reseller` \| `business` (index). `accounts.parentAccountId`: reseller id or null (index `{ parentAccountId: 1, createdAt: -1 }`). `accounts.reseller`: `{ status: 'active' \| 'pending_approval', customersCanTopUp: false, approvedAt, approvedBy, brand: null }` (only on resellers).
- `platformSettings.signup`: `{ open: true, resellerSignup: 'open' }`.
- Impersonation token claims: `impersonatorId`, `impersonatorKind: 'superadmin' \| 'reseller'`, `mode: 'view' \| 'act'`, `returnTo` (reseller panel / admin).
- Ledger types +2: `credit_transfer_out`, `credit_transfer_in` (pair shares `transferId`, both in one Mongo transaction under the Redis wallet lock of both accounts, fixed lock order by id).
- `whatsappCampaigns`: account, channel, name, template(s) (+ variant split), variables mapping (contact field / static per variable), header media, audience (listIds / segmentId / tags / contactIds / csv upload id), exclusions (`excludeRecentDays`), schedule (`now` / `at` / recurrence), status (`draft` → `scheduled` → `running` ⇄ `paused` → `completed` / `stopped` / `failed`), counters (total, skipped by reason, queued, sent, delivered, read, replied, failed by Meta code), cost (estimate, held, charged), createdBy, timestamps.
- `whatsappCampaignRecipients`: campaignId, contactId, variant, status (`pending` → `sent` → `delivered` → `read` / `failed` / `skipped`), skipReason, messageId, errorCode, repliedAt, attempts; unique `{ campaignId, contactId }`; index `{ campaignId, status }`.
- Calling campaigns: Phase 8 `campaigns.line: 'phone' \| 'whatsapp'` + `channelId`.
- Migrations: `0021-accounts-resellers` (kind / parent backfill, unverified → verified, settings default), `0022-whatsapp-campaigns` (collections + indexes, `campaigns.line: 'phone'` backfill). Additive only.

---

## 4. Tasks (step by step)

Batch column: **B1** accounts + signup + login-as, **B2** reseller panel + credit, **B3** WhatsApp campaigns, **B4** call campaigns + finish.

### T19.1 — Account kinds and parent (backend) · B1

1. Model fields §3, migration 0021 (+ test: idempotent, previous release reads accounts).
2. `tenantRules`: a reseller account never reads a child's collections through normal routes (only `/reseller/*` summary queries and login-as).
3. Helpers `isReseller(account)`, `childOf(resellerId, accountId)`.
4. Admin list filters `kind`, `parentAccountId`; account view shows parent.

### T19.2 — Signup without e-mail (both) · B1

1. `SignupBody` + `accountType: 'business' \| 'reseller'`, `website` honeypot (must be empty). Creates account (`kind`) + owner role + owner (`emailVerifiedAt = now`), wallet, default settings → **returns a session** (same as login: access + refresh cookie). No e-mail sent.
2. Checks: platform `signup.open` (else `SIGNUP_CLOSED` 403), reseller signup setting, duplicate e-mail → 409 `AUTH_EMAIL_TAKEN` (clear text, "log in instead"), IP limiter `signup` 5 / h, existing password policy + common passwords.
3. Login no longer requires `emailVerifiedAt`; `verify-email` routes answer 410 `GONE` with "Log in" (old links). Password reset by e-mail stays (it's not signup) — **open question to the owner** whether reset must also work without e-mail (default: superadmin / reseller can set a new password for an owner).
4. Audit `account.signed_up` (`kind`); bell to superadmins `account.reseller_signed_up` for resellers.
5. Frontend: `/signup` form (type cards Business / Reseller, fields, password strength, terms checkbox), on success → dashboard (business) or reseller panel (reseller); login page link "Create an account"; remove the verify-code page (route redirects to login).

### T19.3 — Log in as v2 (both) · B1

1. `POST /admin/accounts/:id/impersonate` gains `mode: 'view' \| 'act'`; new `POST /reseller/customers/:id/login-as` (`mode: 'act'`, only children, reseller `active`).
2. `blockWhenImpersonating` → blocks **view** sessions as today; new `blockSensitiveWhenImpersonating` on the sensitive list (D3) for both modes. Go through the 31 route files once and classify each guarded route (table in the PR / docs).
3. Nested login-as refused (`CONFLICT_INVALID_STATE`); TTL 1 h; audit both sides (`admin.impersonation_started` / new `reseller.login_as_started` / `_stopped`), every action while logged in as carries `impersonatorId` in audit (existing).
4. Frontend banner: "Logged in as <account> · Back to reseller panel / admin" (stops the session, restores the original refresh).

### T19.4 — Superadmin: resellers and users (both) · B1

1. Admin → Accounts: create **Reseller** or **Business** (reuse `createAccount` + `kind`, optional `parentAccountId` for a business under a reseller); move a business to / from a reseller (audit, both resellers' panels update); approve pending resellers; suspend / enable (D7).
2. Filters (kind, reseller), columns (kind, parent, customers count for resellers).
3. Platform settings card: signup open / closed, reseller signup open / approval / closed.

### T19.5 — Reseller API (backend) · B2

1. Routes `/reseller/*` (reseller account, permission `reseller.manage` = owner + admin; `reseller.read` = + manager): customers list (search, status, page; wallet balance, usage 30 d, last active — one aggregate, no N+1), create customer (business name, owner name, e-mail, phone, password, timezone; optional starting credit), customer detail, update name / status (suspend / enable), reset owner password, login-as (T19.3).
2. Every route checks `parentAccountId === reseller` (else 404). Limits: 50 customer creates / day, reseller status `active` for creates.
3. Audit actions `reseller.customer_created`, `reseller.customer_suspended`, `reseller.customer_enabled`, `reseller.customer_password_reset`, `reseller.credit_transferred`, `reseller.credit_reclaimed`, `reseller.login_as_started` (exact count locked in the run prompt).

### T19.6 — Credit transfer (backend) · B2

1. `POST /reseller/customers/:id/credit` `{ amountMicros, note }` (Idempotency-Key) and `POST …/credit/reclaim` (≤ customer's available balance): ledger pair (D4), both wallets updated, realtime `wallet.updated` to both, bells (customer: "Credit added by <reseller>").
2. Refuses: reseller balance short (`WALLET_INSUFFICIENT_BALANCE`), customer suspended, amount ≤ 0 or > limit.
3. Customer top-up: hidden / 403 `TOPUP_NOT_ALLOWED` when the parent has `customersCanTopUp: false`; low-balance bells of a customer also go to the reseller's owners.
4. Reseller statement: transfers in / out, CSV.

### T19.7 — Reseller dashboard numbers (backend) · B2

Customers (active / suspended), credit given this month, customers' spend 30 d by product (calls, WhatsApp, AI), low-balance customers — cached 5 min.

### T19.8 — Reseller panel (frontend) · B2

1. Nav section **Reseller** (only for reseller accounts): Dashboard, Customers, Statement, Settings (`customersCanTopUp`).
2. Customers: table + "Add customer" dialog (password field + generate), detail drawer (wallet, add / take back credit, usage, suspend / enable, reset password, **Log in as**).
3. Pending approval banner when the reseller isn't approved.

### T19.9 — WhatsApp campaign model + audience (backend) · B3

1. Models §3, migration 0022, DATA_MAP / erase map (recipients deleted with the contact), tenant rules.
2. Audience resolver (reuse contacts / segments compile; tags; contactIds; CSV phones → contacts upsert as source `import`), snapshot into recipients in batches of 1,000, cap 100,000 per campaign.
3. Skip at snapshot: DND, opted out, suppressed, no WhatsApp (blocked), marketing stopped (MARKETING templates, D12), sent the same template in the last N days (`excludeRecentDays`, default 0), missing required variable values.

### T19.10 — Cost preview + wallet (backend) · B3

1. `POST /whatsapp-campaigns/:id/estimate`: per-market Meta price + markup (existing pricing) × recipients by market; compare with available wallet; returns `{ recipients, skipped, byMarket, totalMicros, walletAvailableMicros, enough }`.
2. Start refuses when not enough (`WALLET_INSUFFICIENT_BALANCE` with the shortfall); each message holds + charges through the existing template send path (no new money code).

### T19.11 — Sender job (backend) · B3

1. Job `whatsapp-campaign.dispatch` (queue `whatsapp`): claims recipients in batches (findOneAndUpdate `pending → sending` with `claimedAt`), sends via `sendMessage` with `clientId = uuid(campaignId, contactId)` (retry never sends twice), saves after each batch.
2. Pacing: messaging tier (unique recipients / 24 h: 50 / 250 / 1k / 2k / 10k / 100k / unlimited, the channel's tier minus what it already sent today) + Meta throughput (default 80 msg/s, `WA_CAMPAIGN_MPS`); spreads over days when the tier is lower than the audience (status `waiting_for_limit` with "next batch at").
3. Pause / resume / stop (stop = the rest `skipped: stopped`), restart safe (stale `sending` claims released after 10 min), wallet empty → pause + bell; template paused / disabled by Meta → pause + bell; quality RED → pause.
4. Schedule `at` / recurrence (reuse Phase 8 recurrence helpers).

### T19.12 — Stats, retry, export, reports (backend) · B3

1. Status webhooks (existing) update the recipient (`sent → delivered → read`, `failed` with Meta code); inbound reply within 72 h of the send → `repliedAt` (one query per inbound, indexed).
2. Counters by `$inc` (no recount), realtime `whatsapp_campaign.progress` (throttled 1 / s).
3. Retry failed (only retryable codes, once per click), export CSV (recipient, status, error, times — phone masked unless `contacts.export`), report: funnel, cost, replies, by error code, per-day trend, template comparison.
4. A/B (optional variants 2–3, split %, winner by read or reply after N hours → rest goes with the winner).

### T19.13 — Campaign wizard + dashboard (frontend) · B3

1. Campaigns page: tabs **Phone** (existing) / **WhatsApp**; "New WhatsApp campaign" wizard: Number → Template (approved only, preview) + variables (contact field / static) + header media → Audience (lists / segments / tags / CSV / selected contacts from Contacts bulk action) + exclusions → Schedule → **Cost + wallet** → Review & start.
2. Campaign page: live counters, progress bar, pace ("next batch at" when the tier waits), pause / resume / stop, failed by reason, retry failed, export, report tab.
3. Entry points: Contacts selection / list / segment → "Send WhatsApp campaign".

### T19.14 — Roles, limits, catalogue (both) · B3

Permissions `whatsapp.campaigns.read` / `.write` (owner, admin, manager write; agent, viewer read); limiter creates 30 / h; error codes, audit (`whatsapp_campaign.created` / `started` / `paused` / `stopped` / `completed`), notifications (`whatsapp_campaign.completed` / `paused`), OpenAPI, counts locked in the run prompt.

### T19.15 — WhatsApp call campaigns (both) · B4

1. Phase 8 campaign `line: 'whatsapp'` + `channelId`: dispatcher calls `startOutbound` (whatsapp-calling) instead of the SIP / dry-run line; audience filter **only `waCallPermission: allowed`** on that number (others skipped `no_call_permission`); Meta limits respected (one live call per contact, unanswered streak protection: stop calling a contact after 2 unanswered in a campaign).
2. Optional chain: "Ask for permission first" → a bulk permission run; contacts who allow join the call campaign automatically (within its window).
3. Wizard: line picker Phone / WhatsApp; results same as Phase 8.

### T19.16 — E2E, perf, docs, sign-off · B4

1. Playwright new specs (one per area): signup business + reseller, reseller creates customer + credit + log in as + back, superadmin creates reseller + log in as, WhatsApp campaign 50 contacts (fake Meta) start → pause → resume → stats, call campaign 5 contacts (dry-run).
2. Perf: `perf:wa-campaign` 1,000 recipients on fake Meta (time, no double send after a kill), 100-contact WhatsApp call campaign on the dry-run line.
3. Docs: `security.md` + `api.md` (signup without e-mail, login as), `resellers.md` (new), `api.md` WhatsApp campaigns, `data-model.md`, `audit.md`, `error-codes.md`, `DATA_MAP.md`, `api.md`, CHANGELOGs, BUILD_PLAN_V2 reorder, `src/README.md` both, sign-off.

---

## 5. Tests (owner rule — fast)

- While working: **only the test files of the task** (new + the ones the change touches).
- **Each full suite once per batch end is NOT done** — full backend + frontend suites run **once, at the end of B2** (accounts / auth touch many routes) and **once at sign-off**; no coverage re-run.
- Playwright: only the new + affected specs (auth, admin, contacts, campaigns, templates); the full 170+ only if a shared piece (auth / session / layout) changed in a way the targeted specs can't show — decided at sign-off, noted honestly.
- A known flake fails → re-run **that file** once. Never 5× runs.
- New tests per task (minimum): T19.1 migration; T19.2 signup cases (type, closed, duplicate, honeypot, limiter, logged in); T19.3 modes + blocked list + nested + child-only; T19.5 ownership 404s + limits; T19.6 transfer atomic + idempotent + insufficient + reclaim; T19.9 skips each reason; T19.10 estimate + refuse; T19.11 pacing + claims + kill/restart no double send + pause / stop; T19.12 status → counters, replies, retry; T19.15 allowed-only + streak stop.

---

## 6. Risks

| Risk                                        | Mitigation                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Fake signups / spam without e-mail          | IP limiter, honeypot, signup switch, superadmin list "new today", suspend in one click                                          |
| A reseller sees another reseller's customer | every `/reseller/*` query scoped by `parentAccountId`; tests for 404 on others                                                  |
| Login-as abuse                              | audit both sides, banner, TTL 1 h, sensitive actions blocked, customer owner sees "Logged in by your reseller at …" in Activity |
| Money mismatch in transfers                 | one transaction, both wallet locks in fixed order, idempotency key, reconcile check (sum of pairs = 0)                          |
| Campaign blocks the WhatsApp queue          | own job name, small batches, pacing; inbox sends keep priority                                                                  |
| Meta tier exceeded → quality drop           | tier-aware pacing + pause on quality RED / template paused                                                                      |
| Double sends after a crash                  | claims + stable `clientId` + idempotent send (test with a kill)                                                                 |

---

## 7. What we need from the owner / client

1. OK on §2 decisions (especially D1 no e-mail anywhere, D3 act mode, D4 credit transfer, D5 customer top-up off).
2. Whether password **reset** should also avoid e-mail (§4 T19.2 step 3).
3. For live campaigns: an approved MARKETING / UTILITY template and the number's tier (real sends only to the owner's numbers in tests).

---

## Changelog

- 2026-11-05: Owner expanded remaining Phase 19 scope. Added continuation prompt and P19R-T1–T8 tracker for three campaign types, shared 18/75 per-sender pacing, WhatsApp incoming/outgoing AI, number-scoped templates/approval and shared call-method choices. Preserve existing uncommitted frontend work; final verification remains pending.
- 2026-11-04: Draft — checked signup, impersonation, accounts, wallet, campaigns, templates; gaps G1–G7; decisions D1–D12 with defaults; 16 tasks in 4 batches; test rule (targeted per task, full suites twice, targeted Playwright).
- 2026-11-04: Run prompt written ([PHASE_19_PROMPT.md](../prompts/PHASE_19_PROMPT.md)) — defaults D1–D12 locked; literals: errors +7 → 115, audit +20 → 194, notifications +6 → 45, permissions +4 → 49, ledger +2 → 12, WS +1 → 41, migrations 0021 / 0022.
- 2026-11-04: Locked. Defaults D1–D12 in use. Owner: a bulk campaign sends **any** approved template, incl. the consent (call permission) template, charged from the wallet — consent variants go through the permission request path (prompt §1).
- 2026-11-04: P19-B2-DONE — backend 3,935 passed / 3 failed (DATA_MAP row fixed; `calls/flow-call` load flake passes alone; audit-usage check waits for the campaign actions of T19.11); frontend 1,503 passed / 9 failed (signup legal test fixed; 8 load flakes pass alone, 113 / 113); both builds OK. Deviation: campaign permissions are `whatsapp.campaigns.read` / `.write` (the key pattern has no `_` in the domain).

- 2026-11-05: Continuation local implementation/sign-off completed; three campaign types, shared sender pacing, WhatsApp agent/flow programs, scoped templates and call choices verified. Original full checkpoint failures and targeted fixes/reruns remain in [sign-off](PHASE_19_SIGNOFF.md); live Meta/SIP and production rollout are separate open checks.
