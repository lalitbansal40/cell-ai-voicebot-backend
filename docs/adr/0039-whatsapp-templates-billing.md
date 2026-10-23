# 0039 — WhatsApp templates + message charges: Meta as the source of truth, billed on `pricing.billable`, price fixed at send, INR

- **Status:** accepted
- **Date:** 2026-10-23

## Context

Phase 11 lets accounts write to customers outside the 24-hour window with Meta-approved templates and charges every WhatsApp message to the account wallet. Meta reviews templates (approve / reject / pause / disable / recategorise), bills per delivered message by market × category (per-message pricing; 1,000 free service messages per number per month; service and in-window utility charged from 1 Oct 2026) and reports what it billed in each status webhook (`pricing.billable`, `type`, `category`). Indian businesses move to INR billing by 31 Dec 2026. Owner decisions (23 Oct 2026): 15 % markup, service replies charged when Meta bills them, an empty wallet refuses templates and replies, no platform fee for customer-pays accounts, utility allowed to opted-out (not DND) contacts, 1 marketing template per contact per 24 h, `templates.manage` for owners / admins / managers, no authentication template creation, round up to the paisa, placeholder rates until Meta's INR card is imported, 72-hour holds with a late charge.

## Options considered

1. **Meta is the source of truth for templates (our rows mirror it + drafts, variable sources, usage), money follows Meta's per-message `billable` flag: hold the price at send, capture on a billable delivered / read status, release on free / failed / no status in 72 h, charge late if Meta bills after a release.** Chosen.
2. **Charge at send** — simple, but free service messages (free tier, entry points) and failed sends would be charged; refunds become a second money flow.
3. **Re-price from Meta's `pricing_analytics` once a day** — exact against Meta, but customers would see charges a day late and the wallet could overspend between runs.
4. **Re-price on the category Meta reports** — follows Meta exactly, but a recategorised template would change the customer's price after the send preview showed another one.

## Decision

- **Templates:** `whatsappTemplates` per account × WABA (unique live name + language, Meta id unique per WABA, never hard-deleted — Meta deletion → `DELETED`, the 30-day name lock enforced). Every Meta rule is checked before submit (one error per field); edits only in Meta's editable statuses with the approved-edit windows (1 / 24 h, 10 / 30 days) and a locked category. Status, quality, category and components webhooks are applied in received order against `lastEventAt` (a sync sets it to its start), unknown ids trigger a sync, events stored before Phase 11 are backfilled; a daily sync, a sync after a connect and a manual sync (1 / min / number) keep rows in step. Managers and the creator get bells (rejected / disabled also by e-mail); nothing carries template text.
- **Sending:** approved / flagged, not paused, same WABA; marketing refused for opted-out, DND or "stopped marketing" contacts and limited to 1 per contact per 24 h; utility / authentication only stop at DND; the 24-hour window is skipped for templates. Variables resolve from the request or the remembered source (contact fields formatted like the frontend); the rendered text is stored for bubbles, search and preview.
- **Price:** Meta's list rate from the card in force at send time for the recipient's market (longest calling code, else `OTHER`) × category, plus the markup rounded up to the paisa (or the account's fixed price), plus the platform fee; customer-pays accounts pay the fee only. All money is integer micros; the CSV is parsed with string math.
- **Money:** `holdForWhatsApp` (key `wa-hold-<clientId>`, credit limit allowed, monthly WhatsApp budget) after every non-money rule and before the insert; refused → no message. The status hook (injected into the inbox) takes the first decisive signal: `billable: true` on delivered / read captures the held price (`wa-capture-<messageId>` — `sent` already carries the expected pricing and is ignored), `billable: false` or `failed` releases; a billable status after a release charges once (`wa-late-<messageId>`), possibly below zero, with a bell. A category mismatch is flagged, never re-priced. Holds without a decisive status are released after 72 h (`billing.whatsapp_reap_holds`, one transaction per account); the call-hold reaper only touches call holds.
- **Reconciliation:** `billing.whatsapp_reconcile` (03:00 IST) stores Meta's `pricing_analytics` against our captured charges per WABA day × category; differences beyond 2 % or ₹10 notify the superadmins; the margin report uses analytics when present, else our list cost.
- **Currency:** INR only. The superadmin billing page lists platform-paid numbers whose WABA currency is not INR before the 31 Dec 2026 deadline.

## Consequences

- Customers are charged only for what Meta bills, at the price shown before sending; refunds are never needed for free or failed messages.
- Money flows only through the engine (money-writes test); every scenario test checks that held rows equal the wallet's hold and the ledger equals the balance.
- Meta changes (new statuses, categories, pricing types) degrade safely: unknown statuses keep the row, unknown categories default to marketing (the highest price), the billable flag still decides money.
- Placeholder rates must be replaced with Meta's published INR card (superadmin import) before real traffic; the real-WABA checklist (setup guide §14) verifies a delivered charge against `pricing_analytics`.
- Phase 12 sends the call permission template made here; Phase 15 exposes template sends on the public API (`origin: api`).
