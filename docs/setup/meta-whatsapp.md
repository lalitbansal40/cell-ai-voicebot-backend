# Meta WhatsApp — switching from the fake provider to the real Meta app

Phase 9 runs on the **fake Meta provider** (`META_PROVIDER=fake`, the default outside production): signup, webhooks and the health job all work without Meta. This guide is the checklist for the day the real Meta app is set up. Switching is **env-only** — no code changes (ADR 0037).

> Never commit secrets. `.env` is git-ignored (docs/conventions/secrets.md). App secret, verify token and System User token go only into the server's `.env`. Do **not** copy values from other projects (AutoChatix) — create this app's own.

## 1. Meta Business account

1. [business.facebook.com](https://business.facebook.com) → the platform's own business (the company that runs Cell AI).
2. **Business verification** (Security Center): legal name, address, documents. Needed for App Review, Tech Provider access and higher messaging limits.

## 2. Create the Meta app

1. [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create app** → type **Business** → connect it to the business from step 1.
2. **Add products:** **WhatsApp** and **Facebook Login for Business**.
3. **App settings → Basic:** note the **App ID** (`META_APP_ID`, public) and **App secret** (`META_APP_SECRET`, secret, ≥ 32 characters). Set the privacy policy URL, terms URL, app icon and category (App Review needs them).

## 3. Embedded Signup configuration

1. **Facebook Login for Business → Configurations → Create** — template "WhatsApp Embedded Signup".
2. Permissions: `whatsapp_business_management`, `whatsapp_business_messaging` (+ `business_management` if Meta asks).
3. Copy the **Configuration ID** → `META_ES_CONFIG_ID`.

## 4. Domains

1. **App settings → Basic → App domains:** the frontend domain (e.g. `app.example.com`).
2. **Facebook Login for Business → Settings:** "Allowed domains for the JavaScript SDK" = the frontend URL (`https://app.example.com`); "Login with the JavaScript SDK" = on.

## 5. Webhooks

1. **WhatsApp → Configuration → Webhook:** Callback URL `https://<api-host>/api/v1/webhooks/meta`, Verify token = a long random value (≥ 24 characters) → `META_WEBHOOK_VERIFY_TOKEN`. Meta calls `GET` with the challenge; it must show "Verified" (the API must already run with the new env).
2. **Webhook fields** — subscribe all of these (the list is `WEBHOOK_FIELDS` in `src/core/meta/schemas.ts`): `messages`, `calls`, `account_settings_update` (Phase 12), `account_update`, `phone_number_quality_update`, `phone_number_name_update`, `business_capability_update`, `message_template_status_update`, `message_template_quality_update`, `template_category_update`, `message_template_components_update` (Phase 11), `user_preferences`, `security`, `history`, `smb_app_state_sync`, `smb_message_echoes`.
3. The superadmin page **Admin → WhatsApp** shows the exact webhook URL to paste.

## 6. App callbacks (App Review prerequisites)

**Facebook Login for Business → Settings:**

- Deauthorize callback URL: `https://<api-host>/api/v1/meta/deauthorize`
- Data deletion request URL: `https://<api-host>/api/v1/meta/data-deletion` (Meta shows users `https://<frontend>/data-deletion?code=…`).

## 7. Server env

```dotenv
WHATSAPP_ENABLED=true
META_PROVIDER=meta
META_APP_ID=<app id>
META_APP_SECRET=<app secret>
META_ES_CONFIG_ID=<configuration id>
META_WEBHOOK_VERIFY_TOKEN=<the verify token from step 5>
META_GRAPH_VERSION=v23.0            # the latest stable version on that day
# META_GRAPH_BASE_URL stays the default (production refuses anything else)
# FAKE_META_APP_SECRET must not be set in production
```

## 8. Billing — Solution Partner credit line (accounts with "platform pays Meta")

1. Become a **Solution Partner** (Meta Business Partner onboarding) and get the **credit line** shared with the business → its id → `META_CREDIT_LINE_ID` (digits).
2. **Business settings → Users → System users → Add** (Admin), assign the app, give it **Financial Editor** on the business's payment settings; generate a **never-expiring token** with `business_management` (+ the WhatsApp permissions) → `META_SYSTEM_USER_TOKEN` (secret).
3. Without these two values, connects of "platform pays Meta" accounts stop at `action_needed` ("Platform credit line isn't configured on this server"); "customer pays Meta" accounts work without them. A superadmin chooses the mode per account (**Admin → account → Meta billing**) before the customer connects — a credit line can't be removed from a WhatsApp account once attached.

## 9. Tech Provider access

To onboard **other** businesses (not only your own test WABA), complete **Tech Provider** onboarding and **App Review** for `whatsapp_business_management` and `whatsapp_business_messaging` (screenshots / screen recording of the signup and the numbers page — the fake mode UI looks the same). Until then only users with a role on the app can finish Embedded Signup; a superadmin can **manual connect** the platform's own test number with a System User token (**Admin → account → Manual connect**).

## 10. Local development with real webhooks

Meta must reach your machine: `cloudflared tunnel --url http://localhost:5100` (or ngrok) and use the tunnel URL in step 5 / 6 of a **separate dev app** (never point the production app at a laptop).

## 11. Switch + smoke checklist

1. Set the env (step 7, step 8), restart the API and the workers.
2. Meta dashboard → webhook **Verified** ✓.
3. **Admin → WhatsApp**: provider `meta`, every configured flag ✓, webhook URL shown.
4. Owner of a test account → **WhatsApp → Connect WhatsApp** → Meta popup → finish with a test number → card **Connected** (quality, limit, billing line).
5. Send a WhatsApp message to the number → a `messages` event appears (Admin → WhatsApp → last event; stored `deferred` until Phase 10).
6. **Sync now** on the card → still Connected; the daily health job runs at 22:00 UTC.
7. The simulator (`POST /dev/meta/webhooks`) is off in production; nothing simulated reaches production.
8. Logs: no tokens, codes, PINs or customer numbers (`grep` the API logs).

## 12. Re-check against Meta's docs on that day

- Graph API version (`META_GRAPH_VERSION`) and any changed field names in `getPhoneNumber` / `getWaba`.
- Embedded Signup `WA_EMBEDDED_SIGNUP` event names (`FINISH`, `FINISH_ONLY_WABA`, the coexistence finish event) and `sessionInfoVersion`.
- Coexistence: `smb_app_data` sync API, its time window after onboarding, and the `history` / `smb_app_state_sync` / `smb_message_echoes` payloads (fixtures in `tests/fixtures/meta/`).
- Credit sharing: `whatsapp_credit_sharing_and_attach` (Meta is moving partners to a newer method) and the supported currencies.
- Error codes the service reacts to: `190` (+ subcodes 460 / 463 / 467), `133005`, `100` / `36007` / `36009`, rate-limit codes.
- Phase 10: the `POST /{phone}/messages` bodies per type (`payloads.ts`), mark-as-read + `typing_indicator`, media upload / `GET /{media-id}` / download hosts (`META_MEDIA_HOST_SUFFIXES`), whether audio needs an explicit voice flag for OGG / Opus voice messages, Block Users API limits, business profile fields and the resumable upload for the photo, send error codes (131047, 131026, 131056, 130429, 131052 / 131053, 368).

## 13. Real-number manual checklist (Phase 13)

With the real app and a test number, from two phones (Android + iPhone):

1. Customer sends text, photo, video, voice note, audio file, document, sticker (+ animated), location, contact card; each appears live with the right bubble; media opens / plays / downloads.
2. Reply with each type: text (with a link preview), photo + caption, video, audio file, document, sticker, location, contact card, buttons, list, link button, reaction, a quoted reply — each arrives; ticks go sent → delivered → read (read receipts on).
3. Voice notes recorded in **Chrome, Firefox and Safari** play as **voice messages** (not files) on both phones; check duration and audio quality.
4. Send to an invalid number → failed with "Message undeliverable"; after 24 h without a customer message the composer is blocked and the API answers 409.
5. Customer sends `STOP`, `BAND KARO`, `बंद करो` → opted out + confirmation text; `START` → opted in + confirmation.
6. Customer reacts / quotes our message; the app shows it; customer deletes a message → "This message was deleted".
7. Block / unblock a customer; business profile edit (about, description, websites, photo) shows on the phone.
8. Coexistence number: a message sent from the Business app phone appears as "Sent from the WhatsApp Business app"; history import shows past chats without unread.
9. Typing indicator visible on the customer's phone while an agent types.
10. Server logs for the whole session contain no message texts, numbers, names, file names, media URLs or tokens.

## 14. Templates + charges (Phase 11)

- **Permissions:** template management uses `whatsapp_business_management` (already requested for Embedded Signup); header example uploads use the Resumable Upload API with `META_APP_ID` (already set).
- **Webhooks:** make sure `message_template_components_update` is subscribed (§5) — Phase 9 apps subscribed before it existed.
- **Credit line:** platform-paid numbers must use an **INR** credit line (deadline 31 Dec 2026); **Admin → WhatsApp billing → Settings** lists numbers billed in another currency.
- **Rate card:** import Meta's published INR rate card CSV (**Admin → WhatsApp billing → Rates**); regional markets need a `Calling codes` column. Until then the placeholder card (IN + OTHER) applies.

### Real-WABA checklist

1. Create a template on the test WABA from the app (utility, two variables) → Meta approves → the app shows "Approved" without a manual sync (webhook).
2. Create one with a deliberate mistake → rejected; the reason shows in the app and the bell / e-mail arrive.
3. Send the approved template to a customer whose 24-hour window is closed → delivered / read; the wallet shows one WhatsApp charge at the previewed price.
4. Next day, **Admin → WhatsApp billing → Reconciliation**: Meta's volume and cost for that day match our captured charge (difference ≤ 2 %).
5. A service reply inside the window → released when Meta reports it free (first 1,000 / number / month).
6. Pause / quality: trigger a low-quality report on a test template if possible (or check the webhook in Meta's test tool) → status "Paused" and the bell.
7. Create the call permission template → approved (Phase 12 uses it).
8. A customer turns off marketing in WhatsApp (Settings → Business → stop offers) → the contact shows "Stopped marketing"; a marketing send is refused, a utility send still goes.
9. Server logs for the session contain no variable values, rendered texts, phone numbers or names.

## 15. WhatsApp calling (Phase 12)

- **Enable:** a Cloud API number (not coexistence) with a messaging limit of at least **2,000** (Meta's rule); in the app **Number → Calling** switch on calling, set call hours, the inbound route (team / AI / AI → team) and the permission request text. Meta's business-initiated calling is not open in every country — the app explains when it is unavailable.
- **Webhooks:** subscribe the app to **`calls`** and **`account_settings_update`** (Meta's App Dashboard → WhatsApp → Configuration) in addition to §5.
- **Media network:** media nodes need public UDP `WA_MEDIA_PORT_MIN–WA_MEDIA_PORT_MAX` (default 40000–40999) open inbound / outbound, `WA_MEDIA_PUBLIC_IP` set when the node is behind NAT, and `WA_STUN_URLS` reachable; `WA_MEDIA_MAX_CALLS` caps calls per process.
- **Prices:** import Meta's INR calling rate card (**Admin → WhatsApp billing → Calling rates**, CSV `Market, Currency, Per minute`); until then the placeholder card (IN ₹0.3885 / min, OTHER ₹1 / min) applies.

### Real-device checklist

1. Request call permission to a real phone inside the 24 h window → the customer taps Allow → the contact panel shows "Can call · 7 days"; outside the window the approved template goes out.
2. Business-initiated call by an agent (browser) → the phone rings, two-way audio, hold / unhold, keypad digits reach the phone, hang up from either side.
3. Business-initiated AI call (agent program) → the customer presses a key → the flow branch runs; the call ends politely.
4. User-initiated call from the phone with route **team** → every available, online team member sees the incoming call; the first Accept wins, the others see "Taken"; with nobody answering the call becomes missed (bubble + bell).
5. User-initiated call with route **AI → team** → the AI greets, "talk to a person" rings the team, the agent takes over on the same call and recording.
6. Recording: the notice plays first; the recording plays back in the call detail with both sides.
7. Latency: measure mouth-to-ear on both sides (target < 400 ms) and note it in the Phase 13 report.
8. Charges: Meta's call duration in **WhatsApp Manager → Insights** matches our pulses for the BIC calls (± 1 pulse); the wallet shows the previewed per-minute price.
9. Server logs for the session contain no SDP lines (`v=0`, `a=candidate`, `a=fingerprint`, `ice-pwd`), phone numbers, names or digits.
