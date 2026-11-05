# Phase 19 contact-call follow-up — 5 Nov 2026

Owner amendment: Contact calls must offer a published flow, an active AI agent, or
**Call yourself** on both supported WhatsApp calling numbers and normal SIP lines.
Audit the related connection paths and preserve the original Phase 19 guards.

## Implementation

- The shared Contact/detail/row, Calls and Inbox chooser keeps the selected transport,
  sender and contact. Normal calls now offer flow, agent and browser human calling.
  WhatsApp keeps its flow/agent picker and adds a human confirmation with sender,
  contact and carrier-only selling price. No fallback to another transport occurs.
- `POST /calls` accepts `mode: human` only for a signed-in user with a SIP caller number,
  no program/version/variables. Existing caller ownership, calling window, DND,
  opt-out, caps, wallet, concurrency and idempotency checks remain authoritative.
- Human SIP uses the existing call session and human bridge. It reserves carrier
  usage without an AI hold, records according to account settings, and has zero
  AI runtime usage. Browser microphone and `call.ready` precede customer dialing.
  An unattached browser times out and releases its hold and capacity without dialing.
- Browser audio is converted between SIP 8 kHz and browser 24 kHz with streaming
  resampling and exact 20 ms frames. Hold, mute, keypad, hang-up and reconnect reuse
  the existing call bar. SIP keypad uses the documented Asterisk ARI DTMF endpoint.
- Human SIP media tickets and hold actions require the initiating user and tenant;
  call-specific bus handlers forward controls to the media owner without replacing
  WhatsApp controls. Duplicate media attaches are refused.
- SIP sessions respect the configured carrier ring timeout instead of the shorter
  browser-ready timeout. A browser disconnect before answer also ends or times out
  the customer leg; reconnect never originates a second customer call.

## Connection fixes

- A failed Meta SDK script is removed so retry loads a fresh script. Signup preloads
  the SDK while the user chooses the number type. Closing signup invalidates its
  pending outcome so it cannot save a number after the dialog was closed or unmounted.
  Synchronous Meta login errors become a recoverable error instead of a stuck spinner.
- Readiness and WhatsApp call-permission load failures expose Retry actions.
- A created human WhatsApp/SIP call is hung up if browser audio initialization fails.
  Canceling before the media socket opens invalidates pending audio work.

The owner confirmed the issue is WhatsApp connection, but does not know the exact
error text or whether it appears in Meta’s popup or after returning to the dashboard. These are verified defects/recovery gaps found
in code; this document does not claim the unspecified live incident is reproduced.

## Validation

Affected checks passed: **154 backend tests / 13 files**, **125 frontend tests / 8
files** (the final 27-test number-wizard rerun replaces that file’s earlier result),
and **2 Chromium browser cases**. The browser happy path covers microphone frames,
selected sender, hold, keypad and hang-up; the denial case asserts zero dial requests.
OpenAPI/types were regenerated, both typechecks/builds passed, and changed source/test
files passed lint. The full lint runs found only issues in these modified files;
those were fixed. Formatting checks passed. Build size/dynamic-import notices remain
non-blocking. See [structured evidence](evidence/PHASE_19_CONTACT_CALLS_CHECKS.json).

Original Phase 19 full
suite and coverage evidence remains in [PHASE_19_SIGNOFF.md](PHASE_19_SIGNOFF.md);
it must not be presented as new coverage for this follow-up.

The browser SIP tests intercept provider endpoints and media sockets. Backend SIP
integration uses local fake ARI/RTP, and bridge tests verify both sample rates. No
customer/provider was dialed, no real Meta signup was submitted and no production
server was changed. Live Meta/carrier/browser-device verification remains open.
