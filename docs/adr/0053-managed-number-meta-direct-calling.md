# ADR 0053: Calls of a managed (Pinnacle) number over Meta Graph

**Status:** Accepted (PMC, 21 Nov 2026) · Prompt: [PINNACLE_META_CALLING_PROMPT.md](../prompts/PINNACLE_META_CALLING_PROMPT.md)

## Context

A managed number sends messages, templates and campaigns through the Pinnacle partner API, and Pinnacle's credit line pays Meta. Calling did not work: Pinnacle relays `messages` but not `calls` webhooks, and it refuses the calling settings and call control APIs (`provider_unsupported`). Meta logged the inbound calls, but none reached us. Our Meta webhook route also dropped every change of a managed number, because the relay was its only source.

## Decision

- **Hybrid.** `provider` stays `pinnacle`. Everything except calling stays on the partner. A new `metaCalling` sub-document holds our app's token (sealed, `select: false`, never returned, exported or audited; last 4 only), its method, scopes, expiry, the Facebook user who granted it, its own webhook check, and an `error`.
- **Getting the token.**
  - **Method A (main)**: our Embedded Signup popup for the same WABA and number, open to anyone with `whatsapp.manage` and to a superadmin in Full access.
  - **Method B (fallback)**: a System User token pasted by the platform team, either on the admin route or by a superadmin in Full access.
  - **Checks for both:** `debug_token` valid; both WhatsApp scopes; this WABA among the granted ids (a token with no granular targets passes); the number listed under the WABA. Otherwise nothing is saved.
- **Turn on.**
  - Subscribe our app to the WABA, make sure the app webhook has `calls` (repair with `POST /{app}/subscriptions`), and read it back.
  - Turn calling ON at WhatsApp if it is off, then set `metaCalling.status = on`.
  - A failed step leaves `error` with the step. The token is kept so **Check / Fix** can retry.
- **Routing.** `callingClientFor(ctx, channel, channelToken)` decides how a call reaches WhatsApp:
  - managed + `on`: the Graph client with the `metaCalling` token;
  - `error`: refused with `WA_META_CALLING_BROKEN`;
  - otherwise: `clientFor` with the channel token.

  Every call API of `modules/whatsapp-calling` uses it: start / pre-accept / accept / reject / terminate, settings get / update, call permission status, and the readiness scope check. The permission-request message stays a partner send.

- **Webhooks.**
  - The Meta route keeps only `calls` and `account_settings_update` (`META_DIRECT_FIELDS`) for a managed + `on` number.
  - WABA-level changes of such a WABA are dropped unless a Meta-direct number of ours shares the WABA.
  - The relay's `calls` for that number are dropped. Messages and statuses come from one source only, so nothing is duplicated or charged twice.
- **Health.**
  - The daily calling sync first runs a check without repair on every `on` / `error` number.
  - Meta refusing the token during a sync, check or settings change → `error`, calling `unavailable / meta_calling_broken`, and one bell `whatsapp.meta_calling_broken` per on → error change.
  - Healthwatch rule: `wa-meta-calling-broken`. Admin → System shows the on / broken counts.
  - A data-deletion callback from the granting user clears the token. A deauthorize marks it `error`. Disconnect and Switch to Meta direct clear it.
- **Money.** Meta bills the WABA's payment method (the partner's credit line), so calls are paid the same way as messages. Our wallet charging is unchanged.

## Alternatives

- **Switch to Meta direct (SAC-T11):** moves messages too and needs the partner webhook cleared. It is too large a change when only calling is missing. It stays available.
- **Waiting for Pinnacle calling support:** no date.

## Consequences

- Our app's subscription to a managed WABA means Meta sends us every event of it, and we filter them. Pinnacle must not answer `calls` events of such a number.
- Method A for customers outside our business needs advanced access for both WhatsApp permissions (App Review). Until then, testers or Method B.
- Migration `0032-wa-meta-calling` is additive. `WA_META_CALLING_ENABLED=false` hides the button and refuses the routes.
