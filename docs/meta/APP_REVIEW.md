# Meta App Review pack (Phase 13 — T13.9)

**Status:** DRAFT prepared before the staging server exists (Gate A pending). The texts and scripts use the app's real screen labels; T13.9 re-checks them on staging after the real-number checks (T13.8), fills the URLs and finalises. **No credentials in this file** — demo credentials go only into Meta's reviewer-instructions form.

Plan: [PHASE_13_PLAN.md](../phases/PHASE_13_PLAN.md) §1d, §3 T13.9 / T13.10 · Prompt: [PHASE_13_PROMPT.md](../prompts/PHASE_13_PROMPT.md) GATE C.

## 1. Permissions (request only these)

| Permission                     | Access                                                | Why                                                                                                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp_business_management` | Advanced                                              | Read the business's connected WhatsApp account and phone numbers, subscribe our app to its webhooks, create / edit / sync / delete its message templates.                                                                   |
| `whatsapp_business_messaging`  | Advanced                                              | Send and receive messages from the shared inbox, templates outside the 24-hour window, read receipts, business profile, number registration, and WhatsApp voice calls (permission request, business calls, customer calls). |
| `business_management`          | Only if the Embedded Signup v4 configuration lists it | Then it gets its own text + video (the business portfolio step of Embedded Signup).                                                                                                                                         |

Not requested: `whatsapp_business_manage_events` (only for the Marketing Messages API + Conversions API, which we don't use). Unneeded permissions are a top rejection reason.

## 2. Use-case texts (paste into "Tell us how you're using this permission")

### whatsapp_business_management

> Cell AI Voicebot is a platform for lenders and other businesses to talk to their own customers. A business connects its own WhatsApp Business account to our app through Embedded Signup. We use whatsapp_business_management only for the accounts a business connected, and only to provide these features to that business: we read the connected phone numbers and their status, quality rating and messaging limit; we subscribe our app to the account's webhooks so new messages and template status changes reach the business's dashboard; and we let the business create, edit, sync and delete its own message templates (for example a payment reminder and the WhatsApp call permission request) from our Templates screen. Templates are submitted to Meta for review and the business sees the review result in our app. We do not access accounts that a business has not connected to our app.

### whatsapp_business_messaging

> Cell AI Voicebot gives the team of a business a shared WhatsApp inbox and WhatsApp calling for the number the business connected. We use whatsapp_business_messaging to send and receive messages on behalf of that business: replies to customers inside the 24-hour window (text, images, documents, voice notes, buttons and lists), approved templates outside the window, read receipts and typing indicators, the business profile, and phone number registration during signup. We also use it for WhatsApp Business Calling: the business asks a customer for call permission, places calls only after the customer allows them (answered by a team member in the browser or by the business's AI voice agent), and receives customers' calls. Opt-outs (for example STOP) are honoured, do-not-call numbers are blocked and every message or call is recorded in the business's account only.

## 3. Screencasts — one video per permission

Rules for every recording: one continuous take (no cuts), English UI, a caption on screen for every step (the step text below), cursor visible, 1080p, no audio needed, no secrets / env files / other tabs / real customer data, the Meta consent screen visible wherever Embedded Signup is shown, and the result shown **in the WhatsApp app** where the permission's result is a message. Record the phone with screen mirroring (or a second camera) next to the browser.

### Video 1 — `whatsapp_business_management` (create a message template)

| #   | Action                                                                                                                                                                      | Caption                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | Open `https://<app-host>` and sign in with the review owner.                                                                                                                | "Signing in to Cell AI Voicebot"                                                              |
| 2   | (If showing signup) WhatsApp → Numbers → **Connect WhatsApp** → Cloud API number → Meta's popup with the permissions → finish → the **Connected** card.                     | "Connecting the business's WhatsApp account (Embedded Signup) — whatsapp_business_management" |
| 3   | WhatsApp → **Templates** → **Create template**.                                                                                                                             | "Creating a message template for the connected account"                                       |
| 4   | Category Utility, **Name** `payment_reminder_demo`, **Language** English; body "Hi {{1}}, your payment of {{2}} is due on {{3}}." with sample values; preview on the right. | "Template body with variables and sample values"                                              |
| 5   | **Submit for review** → the template shows **In review**.                                                                                                                   | "Submitted to Meta for review"                                                                |
| 6   | Wait for (or refresh to) **Approved** — the status changes live from Meta's webhook.                                                                                        | "Meta approved the template; status synced to our app"                                        |
| 7   | Optional: WhatsApp Manager → Message templates shows the same template.                                                                                                     | "The same template in WhatsApp Manager"                                                       |

### Video 2 — `whatsapp_business_messaging` (send a message, shown in WhatsApp)

| #   | Action                                                                                         | Caption                                                  |
| --- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | Signed in, open **Inbox** → the test customer's chat (the customer messaged the number first). | "The business's shared WhatsApp inbox"                   |
| 2   | Type a reply and send; the bubble shows ✓ → ✓✓.                                                | "Replying to the customer — whatsapp_business_messaging" |
| 3   | The phone (mirrored) shows the reply in the WhatsApp app.                                      | "Delivered in the customer's WhatsApp"                   |
| 4   | **Send template** → the approved template → variables filled → send; the phone shows it.       | "Sending an approved template"                           |
| 5   | The customer replies on the phone; the reply appears live in the inbox.                        | "Customer reply received in the inbox"                   |

### Video 2b — calling (attach only if the form allows a second file; never mixed into Video 1)

Request permission from the chat → the phone shows the request → **Allow** → the chat shows "Can call" → **Call** → **Call yourself** → the phone rings → answered → both sides hear each other → hang up → the call bubble in the chat.

## 4. Reviewer instructions (template — fill at T13.9)

```
Website: https://<app-host>
Test login: (entered in Meta's form only)
Is Facebook Login for Business integrated? Yes (Embedded Signup for WhatsApp).

Cell AI Voicebot lets businesses connect their own WhatsApp Business account,
manage message templates and talk to their customers from a shared inbox and
by WhatsApp calls.

whatsapp_business_management
1. Sign in with the test login.
2. The demo account already has a connected WhatsApp test number (WhatsApp → Numbers).
3. Open WhatsApp → Templates → Create template, fill the form, Submit for review.
   The template appears as "In review" and changes to "Approved" when Meta approves it.

whatsapp_business_messaging
1. Send a WhatsApp message to <test number> from your phone.
2. It appears in Inbox. Open the chat, type a reply and send it — it is
   delivered to your WhatsApp.
3. Send template → choose the approved template → Send.

Support: <support e-mail>. The app is Live; Privacy Policy https://<app-host>/privacy,
Terms https://<app-host>/terms, data deletion https://<app-host>/data-deletion.
```

## 5. Pre-submit checklist (all ✓ before Submit)

- [ ] Business verification **Verified**.
- [ ] App settings → Basic: icon 1024, privacy URL, terms URL, data deletion callback / instructions URL, category, contact e-mail, app domain.
- [ ] Facebook Login for Business: allowed SDK domain, deauthorize + data deletion callbacks; the Embedded Signup v4 configuration lists exactly the requested permissions.
- [ ] Webhook **Verified**, every field of `WEBHOOK_FIELDS` subscribed.
- [ ] Privacy / terms approved by the client (front matter `status: approved`) and every `VITE_LEGAL_*` value set — no Draft banner on staging.
- [ ] Demo account works from a fresh browser profile; connected test number; approved templates; the test phone can message the number.
- [ ] Each video matches its permission's text; nothing secret or personal is visible.
- [ ] Data Use Checkup / Data Protection Assessment answered if the dashboard shows them.
- [ ] Submission sent — not left in draft.

## 6. Rejections log

| Date | Permission | Meta's reason | Fix | Resubmitted |
| ---- | ---------- | ------------- | --- | ----------- |
| —    | —          | —             | —   | —           |
