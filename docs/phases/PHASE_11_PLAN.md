# Phase 11 — WhatsApp Templates + WhatsApp Billing (Detailed Plan)

**Status:** Draft — 2026-10-23 · **Branch:** `feature/phase-11-templates-billing` (both repos, from `main` = Phase 10) · **Overview:** [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) · **Previous:** [PHASE_10_SIGNOFF.md](PHASE_10_SIGNOFF.md) · **Tracker:** [PHASE_11_TASKS.md](PHASE_11_TASKS.md)

---

## 0. Is phase ka goal

Phase 11 ke end tak:

- Account apne WhatsApp **message templates** app se bana sake, Meta ko review ke liye bhej sake, status (approved / rejected + reason / paused / disabled) live dekh sake, sync / edit / delete kar sake.
- Approved template kisi bhi contact ko bheja ja sake — **24-hour window band hone par bhi** (inbox, contact page, aur internal API se). Variables contact ke fields se bharein.
- **Har WhatsApp charge wallet se kate**: Meta price + markup — templates (marketing / utility / authentication) aur, 1 Oct 2026 se, **service replies** bhi (Meta ke 1,000 free / number / month ke baad). Hold → capture → release, ledger lines, budgets, low-balance block, cost preview, superadmin rate card + markup + margin report.

Ye Meta App Review ke `whatsapp_business_management` screencast ka base hai (Phase 13).

1. **Templates data** — `whatsappTemplates` (per WABA × name × language): category, components, parameter format, status timeline, rejection reason, quality, sync info, usage counters; ready-made **call permission request** template (Phase 12 use karega).
2. **Template management via Meta** — create / edit / delete / sync (`/{waba}/message_templates`), media header example via **Resumable Upload API**, limits (name, lengths, buttons, rate, per-WABA count), edit rules.
3. **Template webhooks** — `message_template_status_update`, `message_template_quality_update`, `template_category_update`, `message_template_components_update` (Phase 9 stores the first three deferred; Phase 11 consumes them + backfill; adds the 4th to the subscription).
4. **Template send** — outbound type `template` in the Phase 10 pipeline: window bypass, variable resolution (contact fields / static / per-send input), header media / location, button parameters (URL suffix, copy code, quick reply payloads), template-specific Meta errors.
5. **Marketing preferences** — `user_preferences` webhook (customer stops / resumes marketing from WhatsApp) + error 131050 → contact marketing opt-out; marketing templates blocked to opted-out / marketing-stopped contacts.
6. **WhatsApp rate card** — Meta's per-market × category price list (INR, effective dated, CSV import + edit by superadmin), markup (global + per account), selling price per message.
7. **WhatsApp billing engine** — hold at send (templates + service replies, platform credit line accounts), capture when Meta reports the message **billable** (delivered), release when free / failed / never delivered, late deliveries, reaper, monthly WhatsApp budget, money-writes rule.
8. **Cost preview + low balance** — "Ye message ₹0.13 ka hai"; wallet empty / budget reached → send refused with a clear error; inbox / composer banners.
9. **Superadmin** — rate card page, global / per-account markup, **margin report** (Meta cost vs billed), **reconciliation** with Meta's `pricing_analytics` (platform credit line WABAs).
10. **Realtime + notifications** — template status / quality events live, bell for approved / rejected / paused / disabled / recategorised, wallet events reused.
11. **Dev tools** — fake Meta: template review (auto approve / reject knobs), quality / category events, resumable upload, pricing in statuses (billable / free tier / FEP knobs), `pricing_analytics`; simulator kinds; seed; `dev:templates`.
12. **UI** — WhatsApp → **Templates** tab (list, builder with live phone preview, detail drawer), **Send template** dialog (inbox + contact page, variables, cost), inbox composer Templates button live + window-closed banner action, wallet labels / prices / budget, superadmin billing pages, notifications, dashboard spend line.

**Done when:** Playwright on the fake Meta provider proves the whole flow.

- **Template lifecycle:** an owner creates a template with a header, variables, footer and buttons → submits it → it is **Pending** → the fake review **approves** it live (bell) → it is sent to a contact whose window is closed → ticks reach Read. A rejected template shows its reason; edit and resubmit works.
- **Exact charge:** the hold equals the rate-card price + markup at send. On delivered + billable it is captured, and the ledger line reads "WhatsApp · Utility · India". A failed or free message releases the hold. A per-account markup override changes the price.
- **Service replies:** a reply billable after the free tier is charged; a free one isn't.
- **Wallet empty:** the send is refused with the message and nothing is held.
- **Marketing blocks:** a marketing template to a contact who stopped marketing is refused.
- **Call permission template:** created ready-made.
- **Superadmin:** imports the rate card and sees the margin report.

All of the above is also proven by a **money-writes test** (all WhatsApp money through the billing engine) and unit / integration tests. The real-WABA checklist (template approved on a real test WABA, real charge reconciled) is written now and runs in Phase 13.

### Phase 11 mein kya NAHI hoga

| Kaam                                                                                       | Kaunse phase mein                                                                                        |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Bulk WhatsApp campaigns (template broadcast to lists / segments, pacing by messaging tier) | Phase 20                                                                                                 |
| WhatsApp calling, sending the call permission request, call buttons behaviour              | Phase 12 (Phase 11 only **creates** the call permission template + builder supports `VOICE_CALL` button) |
| Authentication templates (OTP copy-code / one-tap / zero-tap) **creation**                 | Later (open question §7 #8) — synced ones are shown read-only                                            |
| Carousel, limited-time-offer, catalog / multi-product, Flows templates **creation**        | Later — synced ones shown read-only with "Edit in WhatsApp Manager"                                      |
| Meta's template library (pre-written utility templates)                                    | Later                                                                                                    |
| Marketing Messages API (MM Lite)                                                           | Later                                                                                                    |
| Public API / webhooks for templates and sends                                              | Phase 15 (Phase 11 adds the **internal** send endpoint only)                                             |
| GST invoices per WhatsApp charge                                                           | Never — wallet top-ups carry GST (Phase 4); usage is deducted from the prepaid balance                   |
| Real Meta WABA + credit line manual check                                                  | Phase 13 (checklist written now)                                                                         |
| Changing a WABA's billing currency (Meta Currency Migration API)                           | Superadmin manual / later; plan records the INR deadline (§1h)                                           |

### Conventions to follow

Same as earlier phases: [api.md](../conventions/api.md), [security.md](../conventions/security.md), [secrets.md](../conventions/secrets.md), [data.md](../conventions/data.md), [data-model.md](../conventions/data-model.md) (new §2.9 Templates + WhatsApp billing), [websocket.md](../conventions/websocket.md), [audit.md](../conventions/audit.md), [error-codes.md](../conventions/error-codes.md), [definition-of-done.md](../conventions/definition-of-done.md), ADR 0005 (queues), ADR 0016 (money in integer micros, INR), ADR 0037 (WhatsApp), ADR 0038 (inbox).

- **Money:** integer **micros** only, INR, every wallet write through `src/core/billing/engine.ts` (money-writes test), idempotency key per message.
- **Customer data:** template **variable values**, message texts, customer phones and names are customer data → never in logs, audit meta, notification bodies, error texts or job data.
- **Template definitions** (name, body text with placeholders, sample values) are **business content, not customer data**. They may appear in audit meta as field names / template name, but never the full body or samples in logs.
- **Tests:** no network calls (Graph against the local stub server, fake Meta in integration / E2E).
- **Meta facts:** re-checked 23 Oct 2026 (§1h); T11.2 rebuilds fixtures from Meta's documented samples.

---

## 1. Locked decisions (implementation me dobara debate nahi)

### 1a. Architecture

```
UI (Templates tab / Send template) ─► /api/v1/whatsapp/templates/* ─► template.service ─► MetaClient (Graph | fake)
                                                                         │  create / edit / delete / list / resumable upload
Meta ──► POST /webhooks/meta (Phase 9) ─► queue whatsapp: webhook.process
            ├─ message_template_status_update / _quality_update / template_category_update / _components_update
            │        └─► template webhook handlers ─► whatsappTemplates (status timeline) ─► WS + bell + audit
            ├─ user_preferences ─► contact.whatsapp.marketing (stopped / resumed)
            └─ messages.statuses[].pricing (Phase 10 stores it) ─► billing.capture / release (Phase 11)

Send (inbox / contact page / internal API) ─► outbound.service (Phase 10) type `template` | service types
            ├─ rules: template APPROVED, channel ready, not blocked, marketing opt-out, window (service only)
            ├─ price = rateCard(market, category) + markup  ─► billing engine: holdForWhatsApp (platform payer)
            ├─ message queued ─► send job ─► Graph POST /{phone}/messages
            └─ statuses[] ─► delivered + billable ─► captureWhatsApp │ failed / billable:false ─► releaseWhatsApp
Daily jobs: template sync (per WABA), stale WhatsApp hold reaper, pricing_analytics reconciliation (platform WABAs)
```

- Templates belong to a **WABA**, not to a phone number. One WABA can carry several of our channels. The row keys are `accountId + wabaId + metaTemplateId`, unique on `wabaId + name + language`. Channel → WABA via `whatsappChannels.wabaId`.
- **Meta is the source of truth for templates.** We keep a cache with history. A sync (`GET /{waba}/message_templates`, paged) runs on connect, daily, by a manual button and after webhooks. Templates made in WhatsApp Manager appear too.
- **Meta is also the source of truth for charges**, through the `pricing` object on the status webhooks. We never decide "free vs billable" ourselves:
  - **hold** at send = our estimate;
  - **capture** only when Meta reports `billable: true` (Meta charges on delivery);
  - **release** on `billable: false`, `failed`, or a delivery that never comes.
- **Who pays Meta:**
  - **Platform credit line** (`metaPayer = platform`, Phase 9) → the wallet is charged the Meta price + markup.
  - **Customer pays Meta** (`customer`) → no Meta charge in the wallet; only the optional platform fee per message (default ₹0, §7 #4).

### 1b. Data model

**`whatsappTemplates`** (tenant plugin, soft delete for our side only; Meta delete is separate):

| Field                 | Type                                                                                                                                       | Notes                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| accountId             | ObjectId                                                                                                                                   | tenant                                                                                                                      |
| wabaId                | string                                                                                                                                     | Meta WABA id                                                                                                                |
| channelIds            | ObjectId[]                                                                                                                                 | our numbers on this WABA (for filters / sending)                                                                            |
| metaTemplateId        | string \| null                                                                                                                             | `null` while a local draft                                                                                                  |
| name                  | string                                                                                                                                     | `^[a-z0-9_]{1,512}$`                                                                                                        |
| language              | string                                                                                                                                     | Meta code (`en`, `en_US`, `hi`, …)                                                                                          |
| category              | `MARKETING \| UTILITY \| AUTHENTICATION`                                                                                                   |                                                                                                                             |
| subCategory           | string \| null                                                                                                                             | Meta's (e.g. `ORDER_DETAILS`), read-only                                                                                    |
| parameterFormat       | `positional \| named`                                                                                                                      |                                                                                                                             |
| components            | object[]                                                                                                                                   | Meta JSON as sent / synced (header / body / footer / buttons / call_permission_request)                                     |
| variables             | `{ key, component, index, example, defaultSource }[]`                                                                                      | derived from components; `defaultSource` = `contact.name` / `contact.phone` / `field:<key>` / `static:<text>` / `ask` (§1e) |
| status                | `DRAFT \| PENDING \| APPROVED \| REJECTED \| PAUSED \| DISABLED \| IN_APPEAL \| PENDING_DELETION \| DELETED \| ARCHIVED \| LIMIT_EXCEEDED` | `DRAFT` = ours only; others Meta's                                                                                          |
| statusReason          | `{ reason, title, description } \| null`                                                                                                   | rejection / pause reason (Meta `reason`, `other_info`)                                                                      |
| statusHistory         | `{ status, reason, at, source: user \| webhook \| sync }[]`                                                                                | capped 30                                                                                                                   |
| quality               | `{ score: GREEN \| YELLOW \| RED \| UNKNOWN, at } \| null`                                                                                 | from webhook / sync                                                                                                         |
| pausedUntil           | Date \| null                                                                                                                               | Meta pause (3 h / 6 h / disabled after 3rd)                                                                                 |
| previousCategory      | string \| null                                                                                                                             | set by `template_category_update`                                                                                           |
| ttlSeconds            | number \| null                                                                                                                             | message TTL (Meta `message_send_ttl_seconds`)                                                                               |
| editsLog              | `{ at }[]`                                                                                                                                 | approved-template edits (10 / 30 days, 1 / 24 h rule)                                                                       |
| headerMedia           | `{ storageKey, mimeType, size, fileName, handle, handleAt } \| null`                                                                       | example asset (our storage) + Meta handle                                                                                   |
| purpose               | `general \| call_permission`                                                                                                               | `call_permission` = ready-made Phase 12 template                                                                            |
| usage                 | `{ sent, delivered, read, failed, lastSentAt }`                                                                                            | counters from our messages                                                                                                  |
| createdBy / updatedBy | ObjectId \| null                                                                                                                           |                                                                                                                             |
| syncedAt              | Date \| null                                                                                                                               |                                                                                                                             |

- Indexes: `{ accountId, wabaId, name, language }` unique (live rows), `{ accountId, status }`, `{ wabaId, metaTemplateId }` unique sparse, `{ accountId, purpose }`.

**`whatsappRateCards`** (platform-wide, insert-only history; **no** `accountId`):

```
{ effectiveFrom, currency: 'INR', source: 'meta_csv' | 'manual', note, createdBy,
  markets: [ { market: 'IN' | 'REST_OF_ASIA_PACIFIC' | …, label, callingCodes: ['91'],
               marketingMicros, utilityMicros, authenticationMicros, authenticationInternationalMicros | null,
               serviceMicros,
               utilityTiers?: [{ fromMessages, micros }], authenticationTiers?: [...] } ] }
```

- Market lookup: E.164 → calling code → the longest matching `callingCodes` → market. Unknown → `OTHER` row (required).

**Markup:**

- **`platformSettings`** (new collection, one document per `key`) — key `whatsappBilling`: `{ markupBps, roundTo: 'paise', platformFeeMicros, holdMaxAgeHours, freeServiceTierPerNumber: 1000 }`.
- **Account `whatsappBilling` override:** `{ markupBps | null, fixedPrices: { marketing?, utility?, authentication?, service? } | null, platformFeeMicros | null }`. The effective price is the override, else the global.

**`messages` additions (Phase 10 model):**

- `type: 'template'` added to `MESSAGE_TYPES`.
- `template: { templateId, name, language, category, parameters: <resolved, customer data>, renderedPreview }` — the rendered text is used for bubbles and search.
- `billing: { payer: platform | customer, market, category, estimateMicros, priceMicros, metaCostMicros, holdId, status: none | held | captured | released | late_charged | waived, billable, pricingType, at }`.

**Ledger (Phase 4 `ledgerEntries`):**

- `LEDGER_TYPES` + `whatsapp_charge`; `LEDGER_REF_TYPES` + `whatsapp_message`.
- `breakdown` adds `{ waCategory, waMarket, metaCostMicros, markupMicros, platformFeeMicros, waPricingType }`.
- `LEDGER_USAGE_KINDS` + `whatsapp`.

**Wallet:**

- `budgets.monthlyWhatsappMicros` (0 = no budget) + `spend[month].whatsappMicros`.
- Low-balance alerts reused; "WhatsApp paused — add money" banner reuses the wallet status.

**Contact (Phase 3 + Phase 10 `whatsapp`):**

- `whatsapp.marketing: { stopped: boolean, at, source: user_preferences | error_131050 | manual }`.

**Account:**

- `settings.templates: { defaultLanguage: 'en' }`.
- Inbox settings unchanged.

### 1c. Template limits (`TEMPLATE_LIMITS`, Meta, re-checked 23 Oct 2026)

| Limit                | Value                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Name                 | 1–512 chars, `[a-z0-9_]`                                                                                           |
| Header text          | 60 chars, ≤ 1 variable                                                                                             |
| Body                 | 1,024 chars, variables need examples                                                                               |
| Footer               | 60 chars, no variables                                                                                             |
| Buttons total        | ≤ 10                                                                                                               |
| Quick reply          | ≤ 10                                                                                                               |
| URL                  | ≤ 2, URL ≤ 2,000 chars, ≤ 1 variable (end of URL, example required)                                                |
| Phone number         | ≤ 1, number ≤ 20 chars                                                                                             |
| Copy code            | ≤ 1, example ≤ 20 chars                                                                                            |
| Voice call           | ≤ 1 (Phase 12 behaviour)                                                                                           |
| Button label         | 25 chars                                                                                                           |
| Button grouping      | quick replies grouped together, before or after all other buttons                                                  |
| Location header      | utility / marketing only                                                                                           |
| Media header example | image / video / document via Resumable Upload; GIF = MM API only (not supported)                                   |
| Templates per WABA   | 250 (unverified portfolio) / 6,000 (verified + approved display name)                                              |
| Creation rate        | 100 / WABA / hour                                                                                                  |
| Edits                | only `APPROVED` / `REJECTED` / `PAUSED`; approved: 1 / 24 h and 10 / 30 days; approved category can't change       |
| Delete               | by name (all languages) or by id + name; deleted approved name reusable after 30 days; `DISABLED` can't be deleted |
| Variables            | positional `{{1}}…` (default) or named `{{first_name}}` (lowercase, `_`); our cap 20 per template                  |

Our own limits:

- Send rate as the inbox (`rl:inbox-send:` 60 / min / user).
- Template create / edit 20 / hour / user (`rl:templates:`).
- Sync 1 / min / WABA.
- Variable value ≤ 1,024 chars (Meta's body cap).

### 1d. Template lifecycle

1. **Draft** (optional, ours) → **Submit** → `POST /{waba}/message_templates { name, language, category, parameter_format, components, message_send_ttl_seconds? }`.
   - Meta answers `{ id, status, category }`; status is usually `PENDING`, sometimes `APPROVED` at once.
   - Meta may also return a **different category** — we store it and show a "Meta changed the category to Marketing" note.
2. **Webhook / sync** moves the status: `APPROVED` / `REJECTED` (+ reason) / `PAUSED` (+ until) / `DISABLED` / `IN_APPEAL` / `PENDING_DELETION` / `ARCHIVED` / `REINSTATED` (→ approved) / `FLAGGED` (quality warning, stays sendable).
   - The status timeline is **ordered by event time**, so a late webhook never overwrites a newer sync.
3. **Edit** (`POST /{template-id} { category?, components?, message_send_ttl_seconds? }`), within the §1c rules → `PENDING` again (approved edits keep sending the old version until approved — Meta behaviour, shown in the UI).
4. **Delete:**
   - by id + name (one language) or by name (all languages, with a confirm listing them) → Meta;
   - our row → `DELETED` (kept for message history and reports);
   - the name is locked for 30 days (UI warns).
5. **Sync** (daily 04:10 IST per connected WABA + manual + on connect + after a webhook for an unknown id):
   - upserts by `metaTemplateId`;
   - marks templates missing at Meta as `DELETED`;
   - unsupported component types are kept read-only (`editable: false`, "Edit in WhatsApp Manager").
6. **Call permission template:** a "Create call permission template" button builds:
   - `purpose: call_permission`, category **UTILITY**, language = account default;
   - body: _"Kya hum aapko WhatsApp par call kar sakte hain? Aapke loan / account ke baare mein baat karni hai."_ (editable before submit);
   - component `{ type: 'call_permission_request' }`.

   Only one per WABA × language. Phase 12 sends it.

### 1e. Variables + sending

- **Variable sources** (per template, editable; the default is chosen on first send and remembered):
  - `contact.name`, `contact.phone`, `contact.email`, `field:<customFieldKey>` (typed values formatted: currency ₹, dates in the account timezone), `static:<text>`, `ask` (the sender types it).
- **Resolution:**
  - At send: values are trimmed, newlines and tabs collapsed for header / button params (Meta rejects them), and checked against length limits.
  - A missing value → 422 `TEMPLATE_VARIABLES_MISSING` listing the variable keys (never the values).
- **URL button suffix** is percent-encoded. **Copy code** value ≤ 20. **Quick reply** payloads are generated (`qr_<templateId>_<index>`) and come back as `button` messages (Phase 10 already shows them).
- **Header media at send:**
  - the stored example asset is sent again (uploaded to `/media` once per send); or
  - the sender attaches a new file (Phase 10 upload flow, `kind` from the header format).
- **Location header** asks for latitude / longitude / name / address.
- **Payload:** `{ type: 'template', template: { name, language: { code }, components: [ header?, body?, button[]? ] } }`, positional or `parameter_name` per format.
- **Stored message:**
  - `type: template`, the rendered text (body with values) for the bubble, search and preview;
  - origin `agent` (inbox / contact page) or `api` (internal API, Phase 15 public);
  - no window check;
  - **opens nothing** (the window is still opened only by the customer).
- **Send rules, in order:**
  1. channel ready (`connected` / `restricted`);
  2. not blocked;
  3. template `APPROVED` (or `FLAGGED`), not paused, same WABA as the channel;
  4. **marketing** templates refused when the contact is opted out (Phase 10 STOP), DND, or `whatsapp.marketing.stopped`;
  5. utility / authentication allowed for opted-out contacts **only while they are not DND** (default; §7 #5);
  6. wallet / budget (§1g);
  7. per-contact frequency: no more than **1 marketing template / contact / 24 h** from us (default, protects quality; §7 #6);
  8. rate limits.
- **Errors** (Meta → our code + reason in plain words):
  - `132000` parameter count mismatch → `TEMPLATE_PARAMS_INVALID`;
  - `132001` template doesn't exist / wrong language → sync + `TEMPLATE_NOT_FOUND`;
  - `132005` text too long after values;
  - `132007` policy;
  - `132012` parameter format;
  - `132015` paused → mark paused;
  - `132016` disabled → mark disabled;
  - `131049` Meta chose not to deliver (marketing ecosystem limit) → failed, hold released, reason "WhatsApp limited marketing messages to this customer — try later";
  - `131050` user stopped marketing → contact marketing stopped + failed + release;
  - `131026` / `131047` as in Phase 10.

### 1f. Rate card + price

- **Price per message:**
  - **Meta rate:** from the rate card effective at **send time**, for `market(recipient) × category`. Category: `template.category`, or `service` for free-form replies.
  - **Selling price:** account `fixedPrices[category]` if set, else `round_up_paise(metaRate × (1 + markupBps / 10,000))`, then `+ platformFeeMicros`.
  - **Customer-pays accounts:** price = `platformFeeMicros` only (default 0 → no hold at all).
- **Volume tiers** (utility / authentication): we charge the **list (first tier) rate + markup**; tier discounts become margin. The margin report uses `pricing_analytics` for the actual Meta cost when available, else the list rate.
- **Authentication-international:** used when the rate card has it for the market and Meta reports `category: authentication_international`.
- **Rate card import:**
  - superadmin uploads Meta's published CSV (INR) → we parse, show a preview diff vs the current card, then save with `effectiveFrom` (≥ now) and audit;
  - manual edit of rows is possible;
  - history is kept;
  - the seed has **placeholder INR rates** (marketing ₹0.8631, utility / authentication / service ₹0.115 — Meta list rates seen 23 Oct 2026, to be confirmed by the owner), markets IN + OTHER.
- **Estimate endpoint** (`POST /whatsapp/price-preview { channelId, contactId | phone, templateId | 'service' }`) → `{ market, category, priceMicros, payer, freeTierNote }`, used by the UI.

### 1g. Billing engine rules (`src/core/billing/engine.ts` additions)

- **`holdForWhatsApp`**:
  - at send, for `payer = platform` (or a platform fee > 0);
  - amount = selling price;
  - may use the credit limit (like calls) and checks `monthlyWhatsappMicros`;
  - idempotency key `wa-hold-<messageId>`;
  - insufficient funds → the send is refused **before** the message row is created: 422 `WALLET_INSUFFICIENT_BALANCE` (existing Phase 4 code; details `{ reason: 'whatsapp' }`, UI text "Add money to send WhatsApp messages").
- **Service replies:**
  - also held (category `service`), because Meta charges them after the 1,000 free / number / month (from 1 Oct 2026);
  - most will be **released** when Meta reports `billable: false` / `type: free_customer_service`;
  - inbox notes, reactions (not billable — Meta doesn't bill reactions? **verify in T11.2**, default: hold like service) and our auto-confirmations follow the same rule;
  - internal notes never touch money.
- **`captureWhatsApp`:**
  - on the first status with `pricing.billable === true` (`sent` / `delivered` / `read`);
  - amount = held price (the price is **fixed at send**, never re-priced);
  - category mismatch (Meta billed a different category, e.g. recategorised) → capture at the price of Meta's category, plus a ledger note and a margin-report flag.
- **`releaseWhatsApp`:**
  - on `failed`, on `billable: false` (free tier, free entry point, service free), on send errors before Meta accepts;
  - on the reaper: no billable status within `holdMaxAgeHours` (default **72 h**).
- **Late billable** status after a release:
  - a direct charge `whatsapp_charge` captured (may use the credit limit; may take the balance negative because Meta has already charged us);
  - flagged `late_charged`;
  - a bell for owners when the wallet goes negative.
- **Retries** (Phase 10 `retry`) create a new message → a new hold; the failed one was released.
- **Ledger line text:** `WhatsApp · <Category> · <Market label>` (e.g. "WhatsApp · Utility · India"), ref → message (the link opens the chat).
- **Budgets:** `monthlyWhatsappMicros` (owner sets it in Wallet → Budgets); reached → sends refused 422 `WALLET_BUDGET_EXCEEDED` (existing code) with the WhatsApp wording.
- **Money-writes test** updated: only the engine writes `whatsapp_charge`.

### 1h. Meta facts (re-checked 23 Oct 2026, Meta docs)

- **Per-message pricing** (since 1 Jul 2025):
  - charged when a message is **delivered**;
  - rate by category × the recipient's market;
  - users never pay.
- **Categories:** marketing, utility, authentication (templates); service (free-form in the window); authentication-international is a rate.
- **Free:**
  - free entry point (Click-to-WhatsApp ad → 72 h / up to 7 days window, everything free);
  - **1,000 free service messages / business number / month**.
- **From 1 Oct 2026:**
  - service messages beyond the free tier are **charged**;
  - utility templates sent inside an open window are **charged** (they were free);
  - businesses without a payment method may have service delivery stopped.
- **Webhook `statuses[].pricing`:** `{ billable, pricing_model: 'PMP', category, type: 'regular' | 'free_customer_service' | 'free_entry_point', subtype? ('paid_exempt' from 12 Oct 2026) }`. Tier changes come in `account_update` `VOLUME_BASED_PRICING_TIER_UPDATE`.
- **India:**
  - INR billing launched 1 Jan 2026;
  - eligible India accounts must be on INR by **31 Dec 2026**, else Meta stops non-INR delivery from 1 Jan 2027;
  - our platform credit line + WABAs must be INR (Phase 9 records `wabaCurrency`; Phase 11 warns superadmin on non-INR platform WABAs).
- **Volume tiers:** utility / authentication only, per market + category, aggregated per business portfolio, monthly.
- **`pricing_analytics`** (WABA insights) gives per-message cost breakdowns → reconciliation.
- **Template rules:** §1c / §1d.
- **Call permission:**
  - template component `call_permission_request` (body required; header / footer optional; category UTILITY or MARKETING);
  - limits 1 request / 24 h and 2 / 7 days per user;
  - the reply is an interactive `call_permission_reply` (Phase 12 consumes it).

### 1i. Webhooks consumed

| Field                                               | Effect                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `message_template_status_update`                    | status timeline, reason, pause; WS + bell (approved / rejected / paused / disabled / reinstated); unknown id → sync |
| `message_template_quality_update`                   | quality score; RED → bell                                                                                           |
| `template_category_update`                          | new category (and the pending-change notice Meta sends before a change); bell                                       |
| `message_template_components_update`                | components refreshed (edits done in WhatsApp Manager) — **added to `WEBHOOK_FIELDS` + setup guide**                 |
| `user_preferences`                                  | `marketing_messages` stop / resume → contact marketing flag; audit `contact.whatsapp_marketing_changed`             |
| `account_update` `VOLUME_BASED_PRICING_TIER_UPDATE` | stored on the channel (info for the margin report)                                                                  |
| `messages.statuses[].pricing`                       | billing capture / release (§1g)                                                                                     |

Phase 9 stored the template fields **deferred** → the Phase 11 backfill (`templates.backfill` job at worker start) consumes them in event order.

### 1j. Realtime

- **Account events:**
  - `whatsapp.template.updated { templateId, status, quality, category }` (no texts);
  - existing `wallet.updated` for money.
- **Topic:** none new (template detail refetches on the event).

### 1k. Security & privacy

- Templates are business content; **variable values, rendered texts and phones are customer data**:
  - stored on the message (customer data rules) and never logged;
  - audit records the template name + category + counts only.
- Header example media: sniffed like Phase 10 uploads; stored under `storageKey(area: 'template-media')`; served through signed links only.
- The rate card and markup are superadmin only. Accounts see their **selling** prices only, never Meta cost or margin.
- Impersonators: read only (no create / send / delete).
- Rate limits §1c; idempotency on sends (clientId, Phase 10) and money (keys per message).

### 1l. Permissions & roles

| Permission                                                                                                                                          | Owner / Admin | Manager | Agent | Viewer |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------- | ----- | ------ |
| `templates.read` (new)                                                                                                                              | ✓             | ✓       | ✓     | ✓      |
| `templates.manage` (new) — create / edit / submit / delete / sync, variable defaults                                                                | ✓             | ✓       | —     | —      |
| `inbox.reply` (Phase 10) — **send** templates                                                                                                       | ✓             | ✓       | ✓     | —      |
| `wallet.read` (Phase 4) — see WhatsApp prices · `wallet.topup` (Phase 4, owner / admin) — set the WhatsApp budget (same route as the other budgets) | as today      |         |       |        |
| `platform.billing.manage` (superadmin) — rate card, global markup, account overrides, margin + reconciliation reports                               | superadmin    |         |       |        |

New permissions → migration `syncSystemRoles()`.

### 1m. API surface (all `/api/v1`)

**Templates (`templates.read` / `templates.manage`):**

| Method | Path                                           | Notes                                                                   |
| ------ | ---------------------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/whatsapp/templates`                          | filters: channel / WABA, status, category, language, purpose, q; cursor |
| GET    | `/whatsapp/templates/:id`                      | + history, usage, variables, editability                                |
| POST   | `/whatsapp/templates`                          | create (draft or submit: `submit: true`)                                |
| PATCH  | `/whatsapp/templates/:id`                      | edit (§1c rules)                                                        |
| POST   | `/whatsapp/templates/:id/submit`               | draft → Meta                                                            |
| DELETE | `/whatsapp/templates/:id?scope=language\|name` |                                                                         |
| POST   | `/whatsapp/templates/sync`                     | `{ channelId }`                                                         |
| POST   | `/whatsapp/templates/media`                    | example header upload → storage + Meta handle                           |
| POST   | `/whatsapp/templates/call-permission`          | ready-made template                                                     |
| PATCH  | `/whatsapp/templates/:id/variables`            | default sources                                                         |

**Sending (`inbox.reply`):**

| Method | Path                                | Notes                                                                                              |
| ------ | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| POST   | `/inbox/conversations/:id/messages` | `{ type: 'template', templateId, variables: { key: value }, header?: { mediaToken \| location } }` |
| POST   | `/inbox/conversations/start`        | (Phase 10) + optional first template in the same call                                              |
| POST   | `/whatsapp/price-preview`           | §1f                                                                                                |

**Wallet:**

- `GET /wallet/rates` gains `whatsapp: { categories × markets }` (selling prices only);
- budgets accept `monthlyWhatsappMicros`;
- ledger filters gain `type=whatsapp_charge`.

**Superadmin (`platform.billing.manage`):**

| Method | Path                                             | Notes                                                                                   |
| ------ | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| GET    | `/admin/whatsapp-rates`                          | current + history                                                                       |
| POST   | `/admin/whatsapp-rates/import`                   | CSV multipart → preview diff                                                            |
| POST   | `/admin/whatsapp-rates`                          | save a card                                                                             |
| PATCH  | `/admin/whatsapp-billing`                        | global markup / platform fee / hold max age                                             |
| PATCH  | `/admin/accounts/:id/whatsapp-billing`           | Phase 9 route extended: `metaPayer` + `markupBps` / `fixedPrices` / `platformFeeMicros` |
| GET    | `/admin/reports/whatsapp-margin?month&accountId` |                                                                                         |
| GET    | `/admin/reports/whatsapp-reconciliation?month`   |                                                                                         |

**Dev only:** simulator kinds §1n; `GET /dev/meta/templates?channelId` (what the fake has).

OpenAPI for every path; error codes:

- `TEMPLATE_NOT_FOUND`, `TEMPLATE_NOT_APPROVED`, `TEMPLATE_PAUSED`, `TEMPLATE_VARIABLES_MISSING`, `TEMPLATE_PARAMS_INVALID`, `TEMPLATE_EDIT_NOT_ALLOWED`, `TEMPLATE_NAME_TAKEN`, `TEMPLATE_LIMIT_REACHED`, `TEMPLATE_MARKETING_BLOCKED`, `WHATSAPP_FREQUENCY_LIMIT`;
- reuse `WALLET_INSUFFICIENT_BALANCE` / `WALLET_BUDGET_EXCEEDED` (Phase 4) with `details.reason = 'whatsapp'`.

### 1n. Fake Meta + simulator

**Fake templates** (Redis, like Phase 9 / 10):

- create → `PENDING` → auto `APPROVED` after `FAKE_META_TEMPLATE_REVIEW_MS` (dev 3 s, E2E 1 s, tests off).
- Name knobs:
  - `…_reject` → `REJECTED` (reason `INVALID_FORMAT`);
  - `…_recategorize` → approved as MARKETING with a `template_category_update`;
  - `…_pause` → approved, then `PAUSED`;
  - `…_slow` → stays pending.
- Resumable upload returns `fake_handle_*`; sync lists the fake's templates.

**Fake pricing on statuses** (platform-billable unless knobs):

- every template `billable: true, type: regular`;
- service replies `billable: false, type: free_customer_service` unless the customer number ends `00010` (→ billable, simulating "beyond the free tier");
- `00011` → `free_entry_point`;
- `00012` → the template fails `131049`;
- `00013` → `131050` (stopped marketing).

**Simulator kinds:**

- `template_approved` / `template_rejected` / `template_paused` / `template_quality_red` / `template_category_changed` (`templateId`);
- `user_stopped_marketing` / `user_resumed_marketing` (`from`);
- `pricing_tier_update`;
- `run_hold_reaper`;
- `run_template_sync`;
- `late_billable_status` (`messageId`).

**Seed:** "Demo Finance" gets

- 4 templates: EMI reminder (utility, approved), offer (marketing, approved), call permission (utility, pending), one rejected with a reason;
- a rate card (placeholders);
- markup 15 %;
- WhatsApp charges in the ledger for the Phase 10 demo replies (one captured, one released).

**`npm run dev:templates`:** create → approve → send → capture on the dev DB (counts only).

### 1o. Frontend

**WhatsApp → Templates** (`/whatsapp/templates`, tab next to Numbers):

- List: name, language, category chip, status chip (+ reason tooltip), quality dot, number / WABA, last used, usage counts.
- Filters, search, **Sync now**, **Create template**, **Create call permission template**.
- Detail drawer: preview, components, status history, rejection reason with "Edit and resubmit", usage, variable defaults, delete (scope choice).

**Template builder** (dialog / page, lazy):

- Category (with Meta's descriptions), name (auto-slug from a title), language.
- Header: none / text / image / video / document / location; media example upload with progress.
- Body editor: insert variable (positional or named), sample values required, counter 1,024; footer.
- Buttons builder (quick reply, URL + dynamic suffix + example, phone, copy code, voice call) with grouping rules and limits.
- Call permission toggle; TTL (advanced).
- **Live phone preview** (WhatsApp-like bubble with samples).
- Validation messages per Meta rule; Save draft / Submit for review.
- Edit limits shown ("Approved templates can be edited once a day, 10 times a month").

**Send template dialog** (inbox composer **Templates** button — enabled now; window-closed banner action **Send a template**; contact page **Send template**):

- Pick an approved template (search, filter by category / language).
- Variable form: source per variable — contact field / static / type here, prefilled from defaults; values shown.
- Header media / location input; live preview with real values.
- **Cost line** ("This message costs ₹0.99 · Marketing · India" or "Billed by Meta to your WhatsApp account"); marketing blocked notice for stopped contacts; Send.
- Template bubbles in the chat show a "Template" label + name.

**Inbox:**

- Window-closed banner text: "The 24-hour window is closed. Send a template to start the conversation again." + button.
- Composer cost hint: "Replies may cost ₹0.13 after the free 1,000 each month" (platform payer).
- Failed reasons for template errors.

**Wallet:**

- Transactions show "WhatsApp · Utility · India" with a link to the chat.
- Prices tab gets a WhatsApp table (selling price per category for India + other).
- Usage chart category WhatsApp; Budgets → WhatsApp monthly budget.
- Low-balance banner wording includes WhatsApp.

**Superadmin:**

- **WhatsApp rates** page (current card, history, CSV import with diff preview, edit rows, effective date).
- **Billing settings** (global markup, platform fee, hold max age).
- Account page **WhatsApp billing** card (payer + markup / fixed prices override).
- **Margin report** (month, account, category: messages, Meta cost, billed, margin, %) + CSV export.
- **Reconciliation** (our captured vs Meta analytics per WABA / day, differences highlighted).

**Notifications:** template approved / rejected / paused / disabled / category changed / quality low; WhatsApp late charge took the wallet negative.

**Dashboard:** WhatsApp card gains "This month: ₹X on WhatsApp".

**Bundle:** Templates tab, builder, send dialog and superadmin pages are lazy; main growth ≤ 3 KB gzip (measured as in Phase 10, both per file and as one stream).

### 1p. Testing strategy

- **Unit:**
  - component validators (every Meta limit + grouping rules);
  - variable extraction / resolution / formatting (currency, dates, percent-encoding);
  - payload builders (positional + named, header media / location, buttons);
  - error mapping;
  - market lookup (calling codes, longest match, OTHER);
  - price math (markup, rounding to paise, fixed overrides, platform fee, customer payer);
  - status-timeline ordering;
  - CSV parser (Meta format, bad rows, duplicates).
- **Billing integration** (real Mongo, engine):
  - hold → capture (exact micros) / release on failed / free / reaper;
  - late billable → direct charge negative + bell;
  - category mismatch;
  - budget reached;
  - credit limit;
  - idempotent replays (same status twice, statuses out of order: delivered before sent);
  - service reply free vs billable;
  - customer payer (no hold, platform fee);
  - concurrency (200 sends, the wallet never below the allowed limit);
  - money-writes.
- **Templates integration:**
  - create / edit / delete / sync against the Graph stub (paging, unknown components, Meta errors);
  - fake review flow;
  - each webhook with Meta-sample fixtures;
  - backfill of Phase 9 deferred events in order;
  - unknown-template webhook → sync;
  - limits (count, rate, edit windows);
  - call permission template.
- **Send integration:**
  - every component type;
  - window bypass;
  - marketing blocks (opt-out, DND, stopped, 131050);
  - utility to opted-out;
  - frequency limit;
  - paused / disabled templates;
  - wrong WABA;
  - missing variables;
  - every error code;
  - rendered text stored, nothing logged.
- **Frontend unit:**
  - builder (each component, limits, grouping, preview, samples, edit rules);
  - templates list / drawer;
  - send dialog (sources, preview, cost, blocks);
  - inbox / contact entry points;
  - wallet / superadmin pages;
  - notifications.
  - Branch-complete for new files.
- **E2E (Playwright, fake Meta):** T11.11.
- **Coverage gates** stay ≥ backend 95 / 85 / 95 / 95, frontend 95 / 90 / 90 / 95.

### 1q. Contract for later phases

| Function / data                                                                         | Used by                                                                              |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `sendTemplate(conversation \| contact, templateId, variables)` + billing hold / capture | Phase 12 (call permission request), Phase 15 (public API), Phase 20 (bulk campaigns) |
| `priceFor(account, phone, category)` + `price-preview`                                  | Phase 20 campaign estimates                                                          |
| `whatsappTemplates.purpose = call_permission`                                           | Phase 12                                                                             |
| `contact.whatsapp.marketing` + marketing rules                                          | Phase 20                                                                             |
| margin / reconciliation data                                                            | Phase 14 reports                                                                     |

---

## 2. Tasks ka overview

| #           | Task                                                                                                                                                                                                                          | Repo | Size | Depends       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- | ------------- |
| T11.1       | Models (templates, rate cards, platform billing settings), message / ledger / wallet / contact / account fields, migration 0012, `TEMPLATE_LIMITS`, env, codes, audit, notifications, WS, permissions, jobs                   | BE   | M    | —             |
| T11.2       | `MetaClient`: templates CRUD + list paging, resumable upload, template send payloads, `pricing_analytics`; fake (review knobs, pricing knobs, analytics); schemas + fixtures (template webhooks, `user_preferences`, pricing) | BE   | L    | T11.1         |
| T11.3       | Template service: create / edit / submit / delete / sync, limits + edit rules, webhooks (4 fields) + backfill, `user_preferences`, call permission template, notifications + WS                                               | BE   | L    | T11.2         |
| T11.4       | WhatsApp billing: rate card lookup + price math, platform settings + account overrides, engine `holdForWhatsApp` / `captureWhatsApp` / `releaseWhatsApp` / late charge, reaper, budgets, Phase 10 status hook, money-writes   | BE   | L    | T11.1         |
| P11-B1-DONE | checkpoint                                                                                                                                                                                                                    |      |      |               |
| T11.5       | Template send in the outbound pipeline (variables, header media / location, buttons, rules, errors, rendered text), service-reply billing in Phase 10 sends, price preview                                                    | BE   | M    | T11.3, T11.4  |
| T11.6       | API + OpenAPI (templates, sending, wallet, superadmin rates / markup / reports, reconciliation job), simulator kinds, seed, `dev:templates`, hardening, ADR 0039, docs, real-WABA checklist                                   | BE   | M    | T11.5         |
| P11-B2-DONE | checkpoint                                                                                                                                                                                                                    |      |      |               |
| T11.7       | FE foundation: `gen:api`, clients, hooks, WS event, labels, money format, permissions, routes                                                                                                                                 | FE   | M    | T11.6         |
| T11.8       | Templates tab: list, drawer, builder with phone preview, call permission template                                                                                                                                             | FE   | L    | T11.7         |
| T11.9       | Send template dialog (inbox + contact page), inbox banner / Templates button / cost hint, template bubbles                                                                                                                    | FE   | M    | T11.8         |
| T11.10      | Wallet (labels, prices, budget, usage), superadmin rates / billing settings / account override / margin / reconciliation, notifications, dashboard line, bundle check                                                         | FE   | M    | T11.7         |
| T11.11      | Playwright E2E — whole suite twice                                                                                                                                                                                            | FE   | M    | T11.9, T11.10 |
| T11.12      | Gap audit, security checklist, docs, Phase 11 sign-off                                                                                                                                                                        | both | M    | all           |
| P11-B3-DONE | checkpoint                                                                                                                                                                                                                    |      |      |               |

---

## 3. Tasks — step by step

### T11.1 — Models, migration 0012, catalogue

- [ ] `whatsappTemplates` model (§1b) + indexes; `whatsappRateCards` (insert-only, validators: micros ≥ 0, market `OTHER` required, unique markets, calling codes digits); new `platformSettings` collection (one document per `key`; first key `whatsappBilling`, defaults in code, superadmin-only).
- [ ] Message: `type: 'template'`, `template`, `billing`; ledger `whatsapp_charge` / `whatsapp_message` / breakdown fields / usage kind; wallet budget + spend; contact `whatsapp.marketing`; account `settings.templates` + `whatsappBilling` override.
- [ ] Migration 0012: indexes, default platform settings, seed **placeholder** rate card (IN + OTHER) only when none exists, `syncSystemRoles()` (2 permissions), backfill `billing: { status: 'none' }` not needed (read as null). Down migration.
- [ ] `TEMPLATE_LIMITS` + `WHATSAPP_BILLING_LIMITS` (hold max age default 72 h, reaper batch 1,000, reconciliation days 3).
- [ ] Env: `FAKE_META_TEMPLATE_REVIEW_MS` (dev 3000, test off), `META_APP_ID` (needed for resumable upload with the real provider; prod rule), docs in env tables.
- [ ] Catalogue:
  - error codes (§1m);
  - audit actions: `template.created`, `.submitted`, `.updated`, `.deleted`, `.synced`, `.status_changed`, `.category_changed`, `whatsapp.rate_card_saved`, `whatsapp.billing_settings_updated`, `account.whatsapp_billing_updated`, `contact.whatsapp_marketing_changed`;
  - notification types: `template.approved`, `.rejected`, `.paused`, `.disabled`, `.category_changed`, `.quality_low`, `wallet.whatsapp_late_charge`;
  - WS event `whatsapp.template.updated`;
  - permissions;
  - job names (`template.sync`, `templates.backfill`, `billing.whatsapp_reap_holds`, `billing.whatsapp_reconcile`);
  - schedules.
- [ ] Tests: models, migration up / down, catalogue counts, roles snapshot.

### T11.2 — Meta core extension

- [ ] Graph methods:
  - `listTemplates(waba, cursor)` (fields incl. `quality_score`, `rejected_reason`, `parameter_format`, `sub_category`, `message_send_ttl_seconds`);
  - `createTemplate`, `editTemplate`, `deleteTemplate(byName | byId)`;
  - `createUploadSession` + `uploadFile` (Resumable Upload: `POST /{app-id}/uploads`, then `POST /upload:<id>` with `file_offset`);
  - `getPricingAnalytics(waba, start, end, granularity, dimensions)`.
- [ ] Payload builder `buildTemplatePayload(template, values, header)` (positional / named, every component).
- [ ] Error mapping for 132xxx / 131049 / 131050 + template management errors (name exists, limit reached, rate limited, invalid component) → scrubbed messages.
- [ ] Fake: templates in Redis per WABA, review timers + name knobs, sync listing, upload handles, pricing on statuses with knobs (§1n), analytics answers built from the fake's sends, call permission component accepted.
- [ ] Schemas (zod) for template webhooks, `user_preferences`, pricing object (incl. `subtype`), analytics; fixtures from Meta's documented samples (+ README of sources).
- [ ] Add `message_template_components_update` to `WEBHOOK_FIELDS` (+ setup guide subscription list).
- [ ] Tests: stub-server tests for each Graph call (paths, query, bodies, paging, errors, retries, scrubbing), fake behaviour per knob, schema fixtures.

### T11.3 — Template service + webhooks

- [ ] Service: validate components (§1c), extract variables, create (draft / submit), submit, edit (rules + edits log), delete (scopes, 30-day name note), sync (upsert / delete-missing / read-only unsupported), variable defaults, call permission template, usage counters (from message status changes), header example upload (sniff → storage → Meta handle).
- [ ] Webhook handlers (4 fields) registered in `WEBHOOK_HANDLERS`: status timeline ordered by event time, reason / pause info, quality, category (incl. pending-change notices), components refresh; unknown template → queue sync; notifications (owners / admins + template creator) + WS + audit.
- [ ] `user_preferences` handler → contact marketing flag (+ audit, WS `contacts.changed`?) — creates the contact if unknown? **No** (store on the conversation's contact only; unknown numbers ignored).
- [ ] `account_update` `VOLUME_BASED_PRICING_TIER_UPDATE` stored on the channel.
- [ ] `templates.backfill` job (Phase 9 deferred template events, event order) at worker start.
- [ ] Jobs: `template.sync` per WABA (daily 04:10 IST + on connect hook from Phase 9 channel service + manual), rate limited.
- [ ] Tests: every service path, limits / rate / edit windows (fake timers), webhook ordering (late webhook vs newer sync), backfill, user preferences, notifications without texts.

### T11.4 — WhatsApp billing

- [ ] `rates.ts`: effective WhatsApp rate card (cache + invalidate), market lookup (libphonenumber → calling code → longest match → OTHER), price math (§1f) with paise rounding, account override, platform fee, payer.
- [ ] Engine: `holdForWhatsApp`, `captureWhatsApp` (exact held price; category mismatch path), `releaseWhatsApp`, `chargeWhatsAppLate` (direct, may go negative within / beyond credit limit — documented), budgets (`monthlyWhatsappMicros`), wallet events.
- [ ] Phase 10 status hook: status service calls billing with the stored `pricing` (first billable → capture; `billable:false` → release; failed → release), idempotent per message.
- [ ] Reaper job `billing.whatsapp_reap_holds` (billing queue, every 30 min: holds older than `holdMaxAgeHours` without a billable status → release, mark `released`; message later billable → late charge).
- [ ] CSV import parser for Meta's rate card (columns: Market, Currency, Marketing, Utility, Authentication, Authentication-International, Service; tolerant headers; INR only → else refuse) + diff vs current.
- [ ] Money-writes test extended; engine invariants tests (balance + hold sums).
- [ ] Tests: §1p billing integration list, including 200 concurrent sends with a small wallet (no overspend), replays, out-of-order statuses.

### P11-B1-DONE — checkpoint

- [ ] Full backend verify; `npm run dev:templates` (create → approve → send → capture, a service reply released, a failed template released) on the dev DB; docs (data-model §2.9 draft, plan changelog).

### T11.5 — Template send + service billing

- [ ] Outbound `type: 'template'` (schema in `outbound.schema.ts`): load template (same WABA as the channel), rules §1e in order, resolve variables (contact / fields / static / ask) with formatting, header media (stored example re-uploaded or new `mediaToken`) / location, button params, rendered text, price + hold (before the message insert, in the same flow as Phase 10 idempotency), queue send.
- [ ] Send job: template payload, error mapping §1e (131050 → contact marketing stopped; 132015 / 132016 → template status), release on failure.
- [ ] Service replies (Phase 10 types) priced as `service` + held for platform payers; notes never; reactions per T11.2 finding.
- [ ] Contact page send = start conversation (Phase 10 `start`) + template in one request (`POST /inbox/conversations/start { channelId, contactId, template? }`).
- [ ] `POST /whatsapp/price-preview`.
- [ ] Frequency rule (1 marketing / contact / 24 h, configurable later) via the messages collection index.
- [ ] Tests: §1p send list + billing interplay (refused sends hold nothing; retries hold again; idempotent resend holds once).

### T11.6 — API, dev tools, hardening, docs

- [ ] Routes + OpenAPI (§1m), rate limiters, permissions, impersonation read-only, WhatsApp-off 503.
- [ ] Wallet routes: rates incl. WhatsApp selling prices, budgets field, ledger filters; superadmin routes; reports (margin: messages × Meta cost (analytics or list) × billed × margin; reconciliation: daily `billing.whatsapp_reconcile` job pulls `pricing_analytics` for platform WABAs, stores per WABA × day × category counts / cost, diff vs our captures).
- [ ] Simulator kinds (§1n) + `GET /dev/meta/templates`; seed; `dev:templates`.
- [ ] Hardening: 500 template sends in parallel across 50 contacts with a wallet that runs out mid-way (exact holds, no overspend, refused sends clean); 10,000 status webhooks with pricing (capture once each); sync of 1,000 templates (paging); CSV with 250 markets.
- [ ] Docs: ADR 0039 (templates + WhatsApp billing), data-model §2.9, api.md §14e, security / compliance (marketing consent + opt-out, India INR deadline), setup guide (template permissions, app id, credit line currency, webhook field added), README section, CHANGELOG, real-WABA checklist §14 (create template on the test WABA, approval, send outside window, delivered charge vs Meta's analytics).

### P11-B2-DONE — checkpoint

- [ ] Full verify; manual HTTP check (dev server: create / approve / send / capture / release / budget refusal / rate card import / margin report); log grep (no variable values, phones, names).

### T11.7 — FE foundation

- [ ] `gen:api`; clients (templates, sending, price preview, wallet additions, superadmin billing / reports); fixtures (`fakeTemplate(status, category, components)`, rate card, price preview); hooks (list / detail / mutations, live `whatsapp.template.updated`); labels (status / category / quality / errors), money formatting reused; permissions (`useCanManageTemplates`); routes `/whatsapp/templates`, `/admin/whatsapp-rates`, `/admin/reports/whatsapp`.
- [ ] Tests (clients, hooks, labels, permissions).

### T11.8 — Templates tab + builder

- [ ] List, filters, sync, drawer (preview, history, reason, usage, variable defaults, delete scopes), builder (§1o) with phone preview, validators mirrored from the backend limits, media example upload, call permission template button, edit rules UI.
- [ ] Tests: every component + limit + grouping rule, preview, submit / draft / edit / delete flows, read-only for viewers / agents / impersonators, unsupported synced templates read-only.

### T11.9 — Send template + inbox

- [ ] Send dialog (§1o) from the composer Templates button, the window-closed banner action and the contact page; variable sources; header media / location; preview; cost line; blocks; errors.
- [ ] Template bubbles (label + name), failed reasons for template errors, cost hint in the composer.
- [ ] Tests: exact request bodies per variable source and header type, blocks, cost line per payer, window-closed path, contact page path.

### T11.10 — Wallet + superadmin + entry points

- [ ] Wallet: transaction labels / links, Prices WhatsApp table, budget field, usage category, banner wording.
- [ ] Superadmin: rates page (import diff, edit, history), billing settings, account WhatsApp billing card, margin report (+ CSV), reconciliation page.
- [ ] Notifications (7 types), dashboard spend line, bundle check vs `main`.
- [ ] Tests for each.

### T11.11 — Playwright E2E

- [ ] Backend env: `FAKE_META_TEMPLATE_REVIEW_MS=1000`, status delays as Phase 10.
- [ ] Specs (one account each, serial):
  1. **`templates-done-when.spec.ts`:** create template (header image, 2 variables from contact fields, footer, quick reply + URL button) → Pending → Approved live (bell) → window-closed contact → Send template (preview with real values, cost ₹X) → ticks Read → ledger "WhatsApp · Utility · India" captured = price; rejected knob → reason → edit → resubmit → approved.
  2. **`templates-billing.spec.ts`:** superadmin imports a rate card (diff) + sets account markup → price preview changes; failed knob → released; free service reply released, billable service reply (`00010`) captured; empty wallet → refused, nothing held; WhatsApp budget reached → refused; customer-pays account → no hold; margin report shows the rows.
  3. **`templates-marketing-rules.spec.ts`:** marketing template to STOP contact refused; `user_stopped_marketing` → refused; utility allowed; 131050 knob → contact flagged; frequency limit second marketing refused; paused template knob → can't send; category recategorised → bell + chip.
  4. **`templates-roles-entry.spec.ts`:** viewer / agent read-only templates, agent can send; impersonator read-only; call permission template created (Pending → Approved); contact page Send template; dashboard spend line; wallet Prices WhatsApp table.
- [ ] Whole suite (103 + new) twice, 2nd with `E2E_BACKEND_LOGS=1` → log grep (variable values, rendered texts, phones, names, file names, handles, tokens, passwords) = 0.

### T11.12 — Gap audit, security, docs, sign-off

- [ ] Requirement → test table (§0 / §1 / tasks / decisions), missing tests added.
- [ ] Security checklist §1k; money-writes; gitleaks; `console.log` 0; no network in tests.
- [ ] Coverage (gates never lowered), bundle, hardening numbers.
- [ ] Docs both repos, BUILD_PLAN_V2 Phase 11 ✅ + "Next: Phase 12", tasks `[x]`, plan changelog, **PHASE_11_SIGNOFF.md**.

### P11-B3-DONE — checkpoint

- [ ] Both repos full verify, actionlint, E2E twice, fresh clones without `.env` (+ E2E once), gitleaks, `npm audit`, `infra:down`, final report.

---

## 4. Deliverables checklist

- [ ] Templates model + Meta CRUD / sync / upload + 4 template webhooks + backfill + call permission template.
- [ ] Template send (every component, variables from contacts, window bypass, marketing rules, errors).
- [ ] WhatsApp rate card (CSV import, history), markup global + per account, price preview.
- [ ] Billing engine hold / capture / release / late charge / reaper / budget for templates **and service replies**; money-writes.
- [ ] Superadmin rates, billing settings, account override, margin + reconciliation reports.
- [ ] UI: Templates tab + builder + preview, Send template dialog, inbox + contact entry points, wallet + superadmin pages, notifications, dashboard line.
- [ ] Playwright: done-when, billing, marketing rules, roles + entry points — twice, logs clean.
- [ ] Docs: ADR 0039, data-model, api, security, compliance, setup guide, READMEs, CHANGELOGs, real-WABA checklist, sign-off.

## 5. Risks

| Risk                                                                    | Mitigation                                                                                                           |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Meta pricing rules keep changing (1 Oct 2026 service + utility changes) | bill only on Meta's `pricing.billable`, never on our own rules; rate card is data (CSV); reconciliation flags drift  |
| Rate card wrong / outdated → under-charging                             | effective-dated cards, preview diff on import, margin report + reconciliation, placeholder rates marked "to confirm" |
| Holds stuck for undelivered messages                                    | 72 h reaper + late-charge path                                                                                       |
| Wallet goes negative on late billable statuses                          | documented, bell, capped by Meta's TTL; owner decision §7 #11                                                        |
| Template review / categorisation differs from what we build             | store Meta's answer, show recategorisation, never assume approval                                                    |
| Resumable upload needs `META_APP_ID` + token scopes                     | env rule + setup guide; fake for dev / E2E                                                                           |
| India INR migration deadline (31 Dec 2026)                              | warn superadmin on non-INR platform WABAs; checklist item                                                            |
| Template webhooks arrive before our create response / out of order      | timeline by event time, unknown id → sync                                                                            |
| Marketing frequency limits (131049) hurt delivery                       | per-contact cap, clear reason, release money                                                                         |
| Concurrency on small wallets                                            | engine conditional updates (Phase 4), 500-send hardening test                                                        |

## 6. Recommended order

Batch 1 (backend core: T11.1–T11.4) → `P11-B1-DONE` → Batch 2 (send + API + dev tools: T11.5–T11.6) → `P11-B2-DONE` → Batch 3 (frontend + E2E + sign-off: T11.7–T11.12) → `P11-B3-DONE`. T11.4 (billing) can run in parallel with T11.2 / T11.3 after T11.1.

## 7. Decisions and open questions

**Answered by the project lead on 23 Oct 2026 — all defaults accepted (locked):**

| #   | Question                                                                                         | Default                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | WhatsApp markup (platform margin) on Meta's price                                                | **15 %** global, per-account override allowed                                                                                                                                                                |
| 2   | Charge **service replies** (inbox free-form) after Meta's free 1,000 / number / month?           | **Yes**, at the service rate + markup, only when Meta reports billable                                                                                                                                       |
| 3   | Wallet empty → refuse template sends **and** service replies?                                    | **Yes**, both refused with "Add money" (notes still work)                                                                                                                                                    |
| 4   | Customer-pays-Meta accounts: platform fee per WhatsApp message?                                  | **₹0** (no charge)                                                                                                                                                                                           |
| 5   | Opted-out (STOP) contacts: allow **utility / authentication** templates (e.g. EMI due reminder)? | **Allow** unless the contact is DND; marketing always blocked                                                                                                                                                |
| 6   | Our own cap: marketing templates per contact per 24 h                                            | **1**                                                                                                                                                                                                        |
| 7   | Who manages templates                                                                            | Owner / Admin / Manager (`templates.manage`); agents send                                                                                                                                                    |
| 8   | Authentication (OTP) templates creation in Phase 11?                                             | **No** (later); synced ones read-only                                                                                                                                                                        |
| 9   | Price rounding                                                                                   | **Up to the next paisa**                                                                                                                                                                                     |
| 10  | Rate card source                                                                                 | Meta's INR rate card CSV imported by superadmin; seed placeholders: marketing ₹0.8631, utility / authentication / service ₹0.115 (Meta list, 23 Oct 2026) — **owner to confirm / provide the official file** |
| 11  | Undelivered template holds                                                                       | Released after **72 h**; a later billable status charged directly (wallet may go negative)                                                                                                                   |
| 12  | Default template language for the account                                                        | **`en`** (Hinglish written in English letters); Hindi `hi` available                                                                                                                                         |
| 13  | Marketing templates need recorded consent (Phase 3 `consent`)?                                   | **Warn only** in the send dialog (compliance note), not blocked                                                                                                                                              |
| 14  | Call permission template wording + category                                                      | Utility, _"Kya hum aapko WhatsApp par call kar sakte hain?…"_ (editable)                                                                                                                                     |

**Client inputs still pending (from Phase 9 / 10):** Meta app (id, secret), Business verification, Solution Partner + credit line (must be **INR**), System User token, test WABA / number, staging domain.

---

## Changelog

- 2026-10-23: Plan created after the Phase 10 sign-off and merge (BUILD_PLAN_V2 → Phase 11). Meta facts re-checked 23 Oct 2026 (pricing page, template guides, call permissions): per-message pricing on delivery; 1,000 free service messages / number / month; from 1 Oct 2026 service beyond the free tier and utility inside the window are charged; pricing webhook `subtype` from 12 Oct 2026; India INR billing since 1 Jan 2026 with a 31 Dec 2026 deadline; template limits (name 512, header 60, body 1,024, footer 60, 10 buttons, URL ≤ 2, phone ≤ 1, copy code ≤ 1, labels 25, 250 / 6,000 per WABA, 100 creations / hour, edit rules, 30-day name reuse); call permission template component and limits. Billing follows Meta's `pricing.billable`, never our own free / paid guess.
- 2026-10-23: Open questions §7 #1–#14 answered by the project lead — every default accepted and locked (15 % markup, service replies charged when Meta bills them, empty wallet refuses templates and replies, ₹0 platform fee for customer-pays accounts, utility allowed to opted-out non-DND contacts, 1 marketing template / contact / 24 h, managers manage templates, no OTP template creation, prices rounded up to the paisa, Meta INR CSV rate card with placeholders, 72 h hold release + late charge, `en` default language, consent warning only, utility call permission template). WhatsApp billing jobs named after the existing billing queue (`billing.whatsapp_reap_holds`, `billing.whatsapp_reconcile`).
- 2026-10-23: Run prompt prepared ([PHASE_11_PROMPT.md](../prompts/PHASE_11_PROMPT.md)) — refinements locked (the prompt's §1 wins where it differs from the text above): the call-hold reaper limited to `call_charge` (today it releases every held row after 2 h); separate WhatsApp engine functions and a `whatsapp` budget; the price fixed at send (a Meta category mismatch is flagged, never re-priced); the hold taken inside `sendMessage` keyed by the clientId; the billing hook in `applyStatuses`; reactions billed per Meta's docs; templates never hard-deleted; a backend variable formatter mirroring the frontend; module layout `modules/templates` + `core/billing/whatsapp.ts` + `modules/whatsapp-billing`; fake pricing knobs `00010`–`00013`; simulator kinds 44 → 58.
- 2026-10-23: T11.1 deviations — (1) the engine's `canSpend` / `moneyPipeline` learned the `whatsapp` budget and monthly spend (with `$ifNull` for wallets from before migration 0012) in T11.1 instead of T11.4, so the wallet model and the engine never disagree; (2) the wallet API (`GET /wallet`, `PATCH /wallet/settings`) shows / sets `budgets.monthlyWhatsappMicros` and `monthSpend.whatsappMicros` (the month total includes WhatsApp); (3) the unique live-template index uses `status ∈ every status except DELETED` (`LIVE_TEMPLATE_STATUSES`) because partial indexes can't use `$ne`; (4) the billing job names + schedules are in the catalogue now, their handlers land in T11.4 (the worker refuses unknown names until then); (5) the Phase 11 bell types live in `modules/templates/notification-types.ts` (title, audience, link, e-mail flag); (6) messages get two partial indexes — `billing_held_at` (hold reaper) and `template_contact_at` (1 marketing template / contact / 24 h).
- 2026-10-23: Observed once during the T11.1 full run — `tests/campaigns/dry-run-100.test.ts` "dials only inside the window" (Phase 8) saw a later attempt dialled at the same fake-clock instant as the previous one (gap 0 < 18 s); it passed alone 3/3 and in the next full run. Suspected cause: a callback / promise follow-up dial counted as a retry by the assertion. To be investigated in the T11.12 gap audit (a `fix(campaigns)` commit if it is a product bug).
- 2026-10-23: T11.2 Meta re-check (pricing page, error codes, template / `user_preferences` / `account_update` webhook references, `pricing_analytics`) — (1) **reactions:** Meta's pricing page bills every delivered message by category and does not list reactions as free → `REACTIONS_BILLABLE = true` (held like a service reply, released when Meta reports `billable: false`); (2) `message_template_status_update` events also include `LOCKED`, `UNARCHIVED`, `REINSTATED`, and the value carries `message_template_category`, `rejection_info { reason, recommendation }` (INVALID_FORMAT), `disable_info { disable_date }` and `other_info.title` (`FIRST_PAUSE`, `SECOND_PAUSE`, `RATE_LIMITING_PAUSE`, `UNPAUSE`, `DISABLED`) — schema accepts them, T11.3 maps them; (3) `template_category_update` has a pending variant (`correct_category` + `category_update_timestamp`, applied in 24 h) and the done variant (`previous_category`); (4) `user_preferences` entries also carry `user_id` / `parent_user_id` (business-scoped ids) — kept loose, we match by `wa_id`; (5) `pricing_analytics` takes `dimensions(PRICING_CATEGORY,PRICING_TYPE,COUNTRY)` **without** brackets, granularity `DAILY` / `HALF_HOUR` / `MONTHLY`, an optional `TIER` dimension, data points `{ start, end, country, pricing_type, pricing_category, volume, cost, tier? }` under `pricing_analytics.data[].data_points[]`; (6) error codes: 131049 / 131050 / 132000 / 132001 / 132005 / 132007 / 132012 / 132015 / 132016 / 2388040 / 2388047 confirmed on Meta's reference; 2388023 / 2388024 / 2388042 / 80008 are not on that page (template creation subcodes — mapped by code **or** subcode, duplicate name = code 100 subcode 2388023), and 80007 (WABA rate limit) is mapped to 429 too; (7) `VOLUME_BASED_PRICING_TIER_UPDATE` value is `volume_tier_info { tier_update_time, pricing_category, tier 'min:max', effective_month, region }`; (8) the status `pricing.subtype` documented value is `paid_exempt`. Implementation notes — `uploadExample(token, file)` takes the app id from the client config (not a parameter); template review timers share the fake's timer set, so the existing `connectFakeStatusWebhooks` shutdown hook (`stopStatusTimers`) cancels them (no separate `fake-meta-templates` hook); the fake reports no `pricing` on `failed` statuses (Meta bills delivered messages only) and fails template sends to `00012` / `00013` synchronously with 131049 / 131050.
- 2026-10-23: T11.3 notes — (1) `message_template_components_update` carries texts only (not Meta's component JSON), so it queues a `template.sync` instead of patching components; (2) status events `REINSTATED` / `UNARCHIVED` / `UNPAUSED` → `APPROVED`, `LOCKED` keeps the status and records the reason; `FIRST_PAUSE` / `SECOND_PAUSE` set `pausedUntil` (+3 h / +6 h); (3) webhook ordering uses the time we received the event (`receivedAt`) against the row's `lastEventAt` (a sync sets it to its start), because handlers see only the change value; (4) extra Meta content rules checked before submit — a body can't start / end with a variable or have two side by side; call permission templates are body + `call_permission_request` only (no buttons); (5) `template.synced` is audited on the WhatsApp channel (counts + reason); (6) the after-connect sync is a `WhatsAppServiceHooks.onConnected` hook (connect, retry setup, PIN) built in `routes.ts` with the server's `templateJobs`; a failing hook never fails the connect; (7) the manual sync rate (1 / min / WABA, 429) is enforced by the API in T11.6 — the job only takes the `tpl-sync-<wabaId>` lock and skips when it is held; (8) variable keys are unique per template: body keys as Meta's (`1`, `first_name`), header `header_<n>` (positional), URL buttons `button_<index>`, copy codes `copy_code_<index>`.
- 2026-10-23: Observed once during the T11.3 full run — `tests/campaigns/hardening.test.ts` "a Redis flush mid-run … without double dials" (Phase 8) ended with 1 contact still `calling` (9 / 10 completed); it passed alone 3/3. Load-dependent like the dry-run flake above; both go to the T11.12 gap audit.
- 2026-10-23: T11.4 notes — (1) **locked reaper fix done** (`reapStaleHolds` only `call_charge`; regression test `tests/billing/reaper-scope.test.ts` failed before the fix: the reaper tried to release a WhatsApp hold and logged an error every run, and WhatsApp holds could fill its 1,000-row batch); (2) like calls, the WhatsApp budget counts **captured** spend (holds don't count), so parallel holds can pass the budget by at most the messages in flight; (3) the WhatsApp reaper reads the hold age from the ledger row (`createdAt`, not `billing.at`) and sets the message `billing.status = released`; (4) `billing.whatsapp_reconcile` got its handler in T11.4 (with the schedule from T11.1); the billing worker receives the WhatsApp context from the server and skips the job without it; (5) the billing hook runs for every outgoing status carrying `pricing.billable` or `failed`, also when the status itself loses the monotonic race (retried webhooks still capture once — engine keys); (6) message rows don't store the platform fee separately — a late charge's ledger breakdown has `platformFeeMicros: 0` and the fee inside `markupMicros`; (7) Meta's published CSV has market names but no calling codes: known single-country markets map in code (`KNOWN_MARKETS`), regional markets need a `Calling codes` column, otherwise the row is refused with its number; rates are parsed from strings (≤ 6 decimals, no floats).
- 2026-10-23: **Batch 1 done (T11.1–T11.4, P11-B1-DONE).** Real bug found by `npm run dev:templates`: Meta's `sent` status already carries `pricing.billable: true`, so the hook captured messages that failed afterwards (the `…00009` customer) — fixed in `fix(billing)` with a regression test that failed first; the capture / late charge now waits for `delivered` / `read` (Meta charges delivered messages only), `billable: false` and `failed` still release at once. `dev:templates` drives the send directly in Batch 1 (price → hold → Meta → message row); T11.5 switches it to `sendMessage`. Backend 2712 → 2881 tests.
- 2026-10-23: T11.5 notes — (1) the 1 marketing template / 24 h rule counts per **contact** (`accountId + contactId`, index `template_contact_at`), not per conversation, so a second number can't double-send; failed messages don't count; (2) a stored header example is **copied** per message to `inbox-media/` (the message's 90-day retention never deletes the template's example); (3) opt-out / opt-in confirmations are held like replies (key `wa-hold-sys-<messageId>`); with an empty wallet the confirmation is skipped and logged (the opt-out itself always applies); (4) test helpers fund new test accounts with ₹1,000 (replies are charged now); `db:seed` already credits the demo wallet before the inbox seed; (5) `dev:templates` now sends through `sendMessage`; (6) message views add `template { templateId, name, language, category }` (no values) and `billing { payer, category, market, priceMicros, status }`; (7) a template retry is held again like any retry; the window check is skipped for templates in retries too.
- 2026-10-23: T11.6 notes — (1) the header example upload is `POST /whatsapp/templates/:id/media` (per template — a draft first, then the file) instead of a free-standing `/templates/media`; (2) the template list returns every live template of the account (≤ 1,000, newest change first) without a cursor — the UI filters by status / category / number / name; (3) the manual sync runs inline (returns its counts) and holds the per-WABA job lock for a minute; (4) **hardening finding:** the 72-hour reaper released holds one transaction each (5,000 holds ≈ 30 s) — it now releases per account in one transaction (`releaseWhatsAppMany`, 5,000 holds ≈ 0.1 s); (5) the Phase 9 `PATCH /admin/accounts/:id/whatsapp-billing` keeps its path and `metaPayer`, extended with `markupBps` / `fixedPrices` / `platformFeeMicros` (at least one field; the response adds `whatsappBilling`); (6) reconciliation differences beyond 2 % or ₹10 reuse the Phase 4 platform notification type `billing.reconcile_mismatch`; (7) `user_preferences` events in the same second: the later one wins (`$lte`); (8) a sync marks templates with a `call_permission_request` component as `purpose: call_permission`; (9) the seed adopts the fake's templates when the dev database was reset but Redis kept the fake's state; (10) seeded demo replies are priced and released by their free statuses (the inbox seed got the billing hook).
- 2026-10-23: Observed once during a T11.6 run — `tests/whatsapp/service-manage.test.ts` "sync … rate limited to once a minute" saw no 429 (passed alone 2/2); goes to the T11.12 gap audit with the two Phase 8 flakes.
