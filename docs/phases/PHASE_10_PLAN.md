# Phase 10 — WhatsApp Inbox: Chat Screen (Detailed Plan)

**Source:** [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md) → Phase 10 · **Builds on:** Phase 1 (storage + signed links, queues, maintenance jobs, catalogues), Phase 2 (RBAC + `syncSystemRoles()`, impersonation, notifications), Phase 3 (contacts, DND / opt-out, realtime topics), Phase 9 (channels, `MetaClient` + fake Meta, webhook pipeline, **deferred events** `listDeferred` / `markConsumed`, `getChannelToken`, simulator, coexistence syncs) · **Branch:** `feature/phase-10-whatsapp-inbox` (both repos) — from `main` after Phase 9 is merged, else from the `feature/phase-9-whatsapp-connect` tip (project lead decides) · **Tracker:** [PHASE_10_TASKS.md](PHASE_10_TASKS.md) · **References (read only):** AutoChatix `message.model.ts`, `message.controller.ts`, `inbox.controller.ts`, frontend `ChatHistory.tsx`, `ChatMessageSend.tsx`, `ChatDrawer.tsx` (patterns + bugs to avoid — never copied)

---

## 0. Is phase ka goal

Phase 10 ke end tak team ek **Inbox** screen me apne WhatsApp numbers ki saari chats dekhe aur reply kare: customer jo bhi bheje (text, photo, video, audio / voice note, document, sticker, location, contact card, button / list reply, reaction, reply-to, ad referral…) wo **live** aaye aur sahi dikhe; agent **har free-form type** wapas bheje (text, media, **browser se recorded voice note**, sticker, location, contact, interactive buttons / list / link button, reaction, reply-to) — **status ticks** (sent → delivered → read / failed + reason) ke saath; **24-hour window** rule lage; WhatsApp Business app (coexistence) numbers pe phone se bheje messages, purani history aur phone contacts bhi chat me aayein. Ye Meta App Review ke `whatsapp_business_messaging` screencast ka base hai (Phase 13).

1. **Data** — `conversations` (ek per channel × customer) aur `messages` (har type, direction, origin, status timeline, media, reply context, reactions); contact pe WhatsApp profile.
2. **Inbound pipeline** — Phase 9 ke deferred `messages` events consume: contact match / auto-create, conversation upsert, message normalize per type, **media download job** (Meta media id 7 din me expire), unread, window, notifications, live events. Statuses → message status timeline (monotonic, out-of-order safe). Pricing data store (Phase 11 billing).
3. **Outbound pipeline** — send API → validate (window, opt-out, channel ready, type limits) → `queued` → queue job → Graph `POST /{phone}/messages` → `accepted` (Meta wamid) → webhooks se sent / delivered / read / failed. Media upload (our storage → Meta media id). **Voice notes** recorded in the browser (WebM/Opus → OGG/Opus remux on our server, no re-encode, no ffmpeg). Idempotent (client id), retries, Meta error codes → clear reasons.
4. **Read receipts + typing indicator** — agent chat khole → customer ke messages "read" (blue ticks, account setting); agent type kare → typing indicator (throttled).
5. **24-hour window** — last customer message + 24 h ke andar free-form; band → composer "Window closed — send a template (Phase 11)"; API 409.
6. **Opt-out keywords** — `STOP`, `UNSUBSCRIBE`, Hinglish / Hindi (`BAND KARO`, `MAT BHEJO`, `बंद करो` …) → contact opt-out + DND entry + audit + auto-confirmation reply; `START` / `SHURU` → opt in again. Opted-out contacts: business-initiated blocked (templates Phase 11), replies to the customer still allowed while they write.
7. **Coexistence** — `smb_message_echoes` → outgoing messages "Sent from the WhatsApp Business app"; `history` → past chats imported (no unread / notifications); `smb_app_state_sync` → contacts.
8. **Retention** — messages + their media **90 days** (`INBOX_RETENTION_DAYS=90`) ke baad daily job se delete; conversation row + contact rehte hain.
9. **Conversation management** — list (search, filters: unread, assigned to me, unassigned, channel, open / closed), assign / unassign, close / reopen, internal notes (team-only, never sent), block / unblock on WhatsApp, unread counts.
10. **Business profile** — about, description, address, email, websites, vertical, profile photo edit (Numbers drawer; `whatsapp.manage`).
11. **Realtime** — `inbox.*` WS events (account level: ids + counts only) + topic `conversation:<id>` (full message content, permission checked), unread badge.
12. **Dev tools** — fake Meta: send → wamid → **auto statuses** (sent → delivered → read with delays), media upload / download, failure knobs; simulator: every inbound type + statuses + "customer replies"; seed demo chats; `dev:inbox`.
13. **UI** — **Inbox** page (3 panes: list · chat · contact panel), bubbles for every type, media viewer / player, ticks, reply / reactions, window banner + countdown, composer (text, emoji, attachments, **voice note recorder**, location, contact card, interactive builder, notes), contact page **Open chat**, bell, nav unread badge.

**Done when:** Har supported type **dono direction** me chale (fake Meta se Playwright E2E: customer sends → live bubble; agent sends → ticks sent → delivered → read; media dono taraf with preview / download; browser se voice note record → OGG/Opus → customer tak), **window rule** (expired → composer blocked + API 409), **statuses** sahi (failed with reason), opt-out `STOP` / `BAND KARO` kaam kare (confirmation reply ke saath), 90-day retention job sahi delete kare, coexistence echoes / history chat me dikhe, roles (viewer read only, impersonator read only) — **Playwright se proven**; real test number pe manual checklist ready (Phase 13 me chalega).

### Phase 10 mein kya NAHI hoga

| Kaam                                                                                                     | Kaunse phase mein                                                |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Templates create / sync / **send**, window band hone pe template se baat shuru karna, campaign templates | Phase 11 (composer me "Templates" button disabled + note)        |
| WhatsApp charges in the wallet (Meta rate card, markup, hold / settle), service message pricing          | Phase 11 (Phase 10 sirf `pricing` data store karta hai)          |
| WhatsApp calling, call permission request message, call buttons                                          | Phase 12 (contact panel me "Call permission: —" placeholder)     |
| AI agent auto-replies on WhatsApp (bot), flows on WhatsApp                                               | Later phase (open question §7)                                   |
| Voice note transcription / translation (AI), waveform previews                                           | Later (AutoChatix lesson: never re-bill on every view)           |
| Message preview text inside bell notifications                                                           | Never (decision §7 #2 — name + link only)                        |
| Saved / canned replies, auto-assignment rules, SLA timers, chat export                                   | Later (open question §7)                                         |
| WhatsApp Flows (`nfm_reply` forms builder), catalogs / products / orders sending, payments               | Later — incoming `nfm_reply` / `order` are **shown** (read-only) |
| Public API / webhooks for messages                                                                       | Phase 15                                                         |
| Real Meta app + test number manual check                                                                 | Phase 13 (checklist written now)                                 |
| Instagram / Messenger                                                                                    | Scope me nahi                                                    |

### Conventions to follow

Same as earlier phases: [api.md](../conventions/api.md), [security.md](../conventions/security.md), [secrets.md](../conventions/secrets.md), [data.md](../conventions/data.md), [data-model.md](../conventions/data-model.md) (new §2.8 Inbox), [websocket.md](../conventions/websocket.md), [audit.md](../conventions/audit.md), [error-codes.md](../conventions/error-codes.md), [definition-of-done.md](../conventions/definition-of-done.md), ADR 0005 (queues), ADR 0037 (WhatsApp). **Message text, captions, customer phones, names and media are customer data:** never in logs, audit meta, notification **bodies** (title + contact name + conversation link only — never message text, §1l), error texts or job data (job data carries ids only). Tests make **no network calls** (Graph client tested against the local stub server; media download / upload stubbed). AutoChatix is reference only. BullMQ job ids never contain `:`.

---

## 1. Locked decisions (pehle se tay — implementation me dobara debate nahi)

### 1a. Architecture

```
Meta ──► POST /webhooks/meta (Phase 9) ─► metaWebhookEvents (deferred: messages / echoes / history / state sync)
            └─► queue whatsapp: webhook.process ─► Phase 10 consumers (registerDeferredField)
                   messages.value.messages[]  → inbound.service → contact + conversation + message
                                                → media.download job (if media) → storage
                                                → opt-out keywords → WS + notifications
                   messages.value.statuses[]  → status.service → message status timeline (monotonic)
                   smb_message_echoes          → message origin business_app (outgoing)
                   history / smb_app_state_sync → import job (no unread / notifications) / contacts

Agent (Inbox UI) ─► POST /inbox/conversations/:id/messages {clientId, type, …}
                      → outbound.service: window / opt-out / channel / limits / idempotency
                      → message queued → queue whatsapp: message.send (job id msg-send-<id>)
                      → worker: media upload (storage → Meta media id) → MetaClient.sendMessage
                      → accepted (wamid) → statuses webhooks → sent / delivered / read / failed
```

- **Consumers of the Phase 9 deferred events** register with `registerDeferredField` and run inside the existing `whatsapp` worker — the handler table in `webhook-handlers.ts` gets `messages` (inbound + statuses), `smb_message_echoes`, `history`, `smb_app_state_sync` handlers that now **process** (status `processed`) instead of only storing; the coexistence counters from Phase 9 stay.
- **Backfill:** events already stored as `deferred` (Phase 9 ran before Phase 10 deploys) are processed once by the `inbox-backfill` job (migration 0011 enqueues it; `listDeferred` + `markConsumed`, oldest first, idempotent by `waMessageId`).
- Module layout: `src/modules/inbox/` (conversations, messages, inbound, outbound, statuses, media, opt-out, coexistence import, notes, topic auth, routes, schemas, json views), `src/core/meta/` extended (send / media / read / typing / block / profile), models in `src/db/models/`.
- WhatsApp disabled → `/inbox/*` 503 `WHATSAPP_NOT_CONFIGURED` (same as Phase 9).

### 1b. Data model

**Conversation** (`conversations`, `tenantPlugin`) — one per **channel × customer** (`waId`):

| Field                  | Type                                                         | Notes                                            |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| channelId              | ObjectId → whatsappChannels                                  |                                                  |
| contactId              | ObjectId → contacts                                          | matched / created by phone                       |
| waId                   | string                                                       | customer's WhatsApp id (digits, from Meta)       |
| phoneE164              | string                                                       | `+<waId>`                                        |
| profileName            | string \| null                                               | Meta `contacts[].profile.name` (latest)          |
| status                 | `open \| closed`                                             | inbound reopens a closed one                     |
| assignedTo             | ObjectId → users \| null                                     |                                                  |
| unreadCount            | number                                                       | inbound since the last "read" by the team        |
| lastMessage            | `{ id, direction, type, preview (≤ 120 chars), at, status }` | list row; preview of text / caption / type label |
| lastInboundAt          | Date \| null                                                 | window start                                     |
| windowExpiresAt        | Date \| null                                                 | `lastInboundAt + 24 h`                           |
| lastReadAt, lastReadBy | Date, ObjectId                                               | team read marker                                 |
| blocked                | boolean                                                      | blocked on WhatsApp (Block API)                  |
| source                 | `inbound \| outbound \| business_app \| history`             | how it started                                   |
| closedAt, closedBy     | Date, ObjectId                                               |                                                  |
| createdAt, updatedAt   |                                                              |                                                  |

Indexes: `{ accountId, channelId, waId }` unique, `{ accountId, status, 'lastMessage.at': -1 }`, `{ accountId, assignedTo, status, 'lastMessage.at': -1 }`, `{ accountId, unreadCount }` partial (> 0), `{ accountId, contactId }`.

**Message** (`messages`, `tenantPlugin`):

| Field                                | Type                                                                                                                                                                     | Notes                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| conversationId, channelId, contactId | ObjectId                                                                                                                                                                 |                                                                                                                 |
| direction                            | `in \| out`                                                                                                                                                              |                                                                                                                 |
| origin                               | `customer \| agent \| business_app \| history \| system`                                                                                                                 | `business_app` = coexistence echo; `system` = Meta system message                                               |
| type                                 | `text \| image \| video \| audio \| document \| sticker \| location \| contacts \| interactive \| button \| reaction \| order \| system \| unsupported \| note`          | `note` = internal, never sent                                                                                   |
| text                                 | string \| null                                                                                                                                                           | body / caption (≤ 4096)                                                                                         |
| media                                | `{ metaMediaId, storageKey, mimeType, size, sha256, fileName, voice, durationSec, animated, status: pending \| ready \| failed \| expired, error }` \| null              | `voice` = voice note (in: Meta flag; out: recorded in the browser)                                              |
| location                             | `{ latitude, longitude, name, address, url }` \| null                                                                                                                    |                                                                                                                 |
| contacts                             | `{ name, phones[], emails[], org }[]` \| null                                                                                                                            | vCard-like, ≤ 10                                                                                                |
| interactive                          | `{ kind: button \| list \| cta_url \| button_reply \| list_reply \| nfm_reply, header, body, footer, buttons[], sections[], reply: { id, title, description } }` \| null | outgoing builder + incoming reply                                                                               |
| reaction                             | `{ targetWaMessageId, targetMessageId, emoji }` \| null                                                                                                                  | empty emoji = removed                                                                                           |
| context                              | `{ replyToWaMessageId, replyToMessageId, forwarded, frequentlyForwarded, referral: { sourceUrl, sourceType, headline, body, ctwaClid } }` \| null                        | reply quote + ad referral                                                                                       |
| reactions                            | `{ emoji, by: customer \| agent, at }[]`                                                                                                                                 | reactions ON this message (denormalised for bubbles)                                                            |
| status                               | `received \| queued \| accepted \| sent \| delivered \| read \| failed \| deleted`                                                                                       | in: `received` / `deleted`                                                                                      |
| statusHistory                        | `{ status, at }[]`                                                                                                                                                       | timeline (≤ 10)                                                                                                 |
| error                                | `{ code, title, message }` \| null                                                                                                                                       | Meta error (no PII)                                                                                             |
| waMessageId                          | string \| null                                                                                                                                                           | Meta `wamid…`, unique per channel                                                                               |
| clientId                             | string \| null                                                                                                                                                           | outgoing idempotency (uuid from the browser)                                                                    |
| sentBy                               | ObjectId → users \| null                                                                                                                                                 | agent                                                                                                           |
| pricing                              | `{ billable, model, category, type }` \| null                                                                                                                            | from status webhooks (Phase 11 bills)                                                                           |
| metaTimestamp                        | Date \| null                                                                                                                                                             | Meta's timestamp                                                                                                |
| at                                   | Date                                                                                                                                                                     | chat order + paging + retention: `metaTimestamp` for inbound / echoes / history, send time for outgoing / notes |
| createdAt, updatedAt                 |                                                                                                                                                                          |                                                                                                                 |

Indexes: `{ accountId, channelId, waMessageId }` unique partial (string), `{ accountId, conversationId, at: -1, _id: -1 }` (paging, order by Meta time — never arrival time), `{ at: 1 }` (retention purge), `{ accountId, clientId }` unique partial, `{ 'media.status': 1, createdAt: 1 }` (download retries), text index `{ text: 'text' }` with `accountId` prefix (search).

**Contact addition:** `whatsapp: { waId, profileName, lastInboundAt, blocked }` (no index change; `phoneE164` already unique among live contacts). Auto-created contacts: `source: { type: 'whatsapp' }`.

**Account addition:** `settings.inbox` (defaults — decisions §7):

```ts
{
  sendReadReceipts: true,
  optOutKeywords: ['STOP', 'STOP ALL', 'UNSUBSCRIBE', 'CANCEL', 'BAND KARO', 'BAND KARDO', 'MAT BHEJO',
                   'MESSAGE MAT BHEJO', 'बंद करो', 'बंद कर दो', 'मत भेजो'],
  optInKeywords: ['START', 'UNSTOP', 'SHURU', 'SHURU KARO', 'चालू करो', 'शुरू करो'],
  optOutReply: true,
  optOutReplyText: "You won't get more messages from us. Reply START to opt in again.\nAb aapko humse messages nahi aayenge. Dobara shuru karne ke liye START bhejein.",
  optInReply: true,
  optInReplyText: "You're subscribed again. / Aap dobara subscribe ho gaye hain.",
  notifyOnNewMessage: 'assigned_or_all', // 'assigned_or_all' | 'assigned_only' | 'off'
}
```

Keyword lists: ≤ 30 entries, each ≤ 30 chars, stored upper-cased + NFC; the same word in both lists → 422. Reply texts ≤ 1024 chars. Message retention is **not** an account setting — platform env `INBOX_RETENTION_DAYS` (§1f), shown read-only in Settings → Inbox.

### 1c. Inbound types (Meta `messages[].type`) → stored / shown

| Meta type                                                                                      | Stored as                                                                          | Shown as                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `text`                                                                                         | `text`                                                                             | bubble (links clickable, `preview_url` irrelevant inbound)                                                           |
| `image` / `video` / `audio` (`voice: true` = voice note) / `document` / `sticker` (`animated`) | `media` + caption                                                                  | image thumb + viewer, video player, audio player ("Voice note"), document card (name, size, download), sticker image |
| `location`                                                                                     | `location`                                                                         | map card (static, link to Google Maps; no API key needed)                                                            |
| `contacts`                                                                                     | `contacts[]`                                                                       | contact card(s) + "Add to contacts"                                                                                  |
| `interactive.button_reply` / `list_reply`                                                      | `interactive.reply`                                                                | "Replied: <title>" chip quoting the asked message                                                                    |
| `interactive.nfm_reply` (WhatsApp Flows)                                                       | `interactive` (`response_json` kept as plain JSON ≤ 8 KB; larger → truncated flag) | "Form submitted" card (read only)                                                                                    |
| `button` (template quick reply)                                                                | `button` (`payload`, `text`)                                                       | "Tapped: <text>"                                                                                                     |
| `reaction`                                                                                     | `reaction` → also pushed into the target's `reactions[]`                           | emoji on the target bubble; no own bubble                                                                            |
| `order`                                                                                        | `order` (`catalog_id`, items count, total)                                         | "Order received" card (read only)                                                                                    |
| `system` (`customer_changed_number`, `customer_identity_changed`)                              | `system`                                                                           | centred system line ("Customer changed their number to …" — the new number masked to last 4)                         |
| `unsupported` / `unknown` / `errors[]`                                                         | `unsupported` + error                                                              | "This message type isn't supported yet"                                                                              |
| `context` (reply / forwarded) / `referral` (click-to-WhatsApp ad)                              | `context`                                                                          | quote above the bubble / "Forwarded" / "From ad: <headline>"                                                         |

Every inbound message: dedupe by `waMessageId` (Meta redelivers), `at = metaTimestamp` orders the chat (insert by timestamp, not arrival), contact profile name updated, `lastInboundAt` / window refreshed, `unreadCount += 1` (not for reactions), conversation reopened.

### 1d. Outbound types (free-form, inside the window)

| Type                | Body                                                                                                     | Limits (Meta)                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| text                | `{ body, previewUrl }`                                                                                   | ≤ 4096 chars; `preview_url` auto when a URL is present                                                  |
| image               | upload or library file + caption                                                                         | JPEG / PNG ≤ 5 MB; caption ≤ 1024                                                                       |
| video               | upload + caption                                                                                         | MP4 / 3GP (H.264 + AAC) ≤ 16 MB                                                                         |
| audio               | upload                                                                                                   | AAC / AMR / MP3 / M4A / OGG (Opus, mono) ≤ 16 MB                                                        |
| voice note          | recorded in the browser (§1f-voice) → OGG / Opus mono                                                    | ≤ 16 MB, ≤ `voiceNoteMaxSeconds` (600 s); shown to the customer as a voice message                      |
| document            | upload + caption + file name                                                                             | PDF / DOC(X) / XLS(X) / PPT(X) / TXT ≤ 100 MB (our cap `INBOX_LIMITS.documentMaxBytes`, default 100 MB) |
| sticker             | upload                                                                                                   | WebP 512 × 512, static ≤ 100 KB (animated ≤ 500 KB: receive only)                                       |
| location            | `{ latitude, longitude, name?, address? }`                                                               |                                                                                                         |
| contacts            | Phase 3 contact(s) → vCard-like                                                                          | ≤ 10                                                                                                    |
| interactive buttons | body + ≤ 3 reply buttons (title ≤ 20, id ≤ 256) + header (text / image / video / document) + footer ≤ 60 | body ≤ 1024                                                                                             |
| interactive list    | body + button label ≤ 20 + ≤ 10 sections, ≤ 10 rows total (title ≤ 24, description ≤ 72)                 |                                                                                                         |
| interactive CTA URL | body + display text ≤ 20 + https URL                                                                     |                                                                                                         |
| reaction            | target message + emoji (empty = remove)                                                                  | target ≤ 30 days old                                                                                    |
| reply-to            | any type + `context.message_id`                                                                          |                                                                                                         |
| note (internal)     | text                                                                                                     | never sent; visible to the team                                                                         |
| mark read / typing  | `{ status: 'read', message_id, typing_indicator? }`                                                      | typing ≤ 25 s, throttled 1 / 10 s per conversation                                                      |

- **Window rule:** every type above except `note` needs `windowExpiresAt > now` → else **409 `WHATSAPP_WINDOW_CLOSED`** (template sending is Phase 11). Reactions too (Meta treats them as messages).
- **Opt-out:** opted-out contacts may still receive replies **inside a customer-opened window**; banner "This customer opted out — replies only". Business-initiated (outside window) is impossible in Phase 10 anyway.
- **Blocked** conversation (we blocked them) → 409 `WHATSAPP_RECIPIENT_BLOCKED`.
- **Channel** must be `connected` (or `restricted` with Meta allowing service messages → Meta decides; we send and map the error) → else 409 `WHATSAPP_CHANNEL_NOT_READY`.
- **Idempotency:** the browser sends `clientId` (uuid v4) — a retry with the same id returns the same message (unique index), never a second send.
- **Media upload:** the browser uploads the file to us (`POST /inbox/media`, multipart, magic-byte sniffing, size per type, stored at `inbox/<accountId>/<uuid>`), gets a `mediaToken`; the send uses it; the worker uploads to Meta (`POST /{phone}/media`, multipart) and caches the Meta media id on the stored file (30 days validity) for re-sends.
- **Errors (Meta codes → reason shown on the bubble):** `131047` window closed (re-engagement), `131026` undeliverable, `131049` / `131050` marketing limits (Phase 11), `131051` unsupported type, `131052` / `131053` media download / upload error, `131056` pair rate limit (retry after 60 s), `130429` throughput (retry with backoff), `131000` / `131016` service unavailable (retry), `131009` / `100` invalid parameter (no retry), `368` / `131031` account restricted / locked (channel → restricted via Phase 9 transition), `190` token (needs reconnect). Retryable ones: 5 attempts exponential (2 s base), then `failed`.

### 1e. Statuses (Meta `statuses[]`)

- `sent` → `delivered` → `read` (`played` for voice notes → stored as `read`), `failed` (+ `errors[]` → `error`), `deleted` (customer deleted an inbound message → `deleted`, text kept hidden in UI "This message was deleted").
- **Monotonic:** rank `queued 0 < accepted 1 < sent 2 < delivered 3 < read 4`; a lower status never overwrites a higher one (Meta delivers out of order); `failed` overrides anything below `delivered` only. Every accepted change appends to `statusHistory` (dedupe same status) and emits `inbox.message.updated`.
- A status for an unknown wamid (sent outside the app — e.g. API before Phase 10, or another tool on the same number) → stored on the event as `ignored` with a counter; coexistence echoes cover the phone-sent ones.
- `pricing` (`billable`, `pricing_model`, `category`, `type`) and `conversation` objects are stored on the message for Phase 11 — **no wallet charge in Phase 10** (service messages are free under per-message pricing; templates come in Phase 11).

### 1f. Media handling

- **Inbound:** `GET /{media-id}` (business token) → short-lived URL (5 min) → `GET` with `Authorization: Bearer` (no token in our logs) → stream to storage `inbox/<accountId>/<conversationId>/<messageId>/<sha256>.<ext>` with size cap (`INBOX_LIMITS.inboundMediaMaxBytes`, 100 MB) and mime check (must match Meta's `mime_type`) → `media.status: ready`. Job `media.download` (job id `media-dl-<messageId>`, 6 attempts, exponential 10 s), queued at once (Meta media ids from webhooks expire after **7 days**); failure → `failed` (bubble "Media couldn't be downloaded" + Retry for managers while < 7 days old).
- **Serving:** `GET /inbox/messages/:id/media` → signed storage link (5 min, `Content-Disposition` with the file name for documents; `inline` for image / video / audio) — permission `inbox.read`, account checked; never the Meta URL.
- **Outbound:** §1d. Library files: none in Phase 10 (each send uploads); the stored file is reused for retries.
- **Voice notes (§1f-voice)** — decision §7 #6:
  - Browser: `MediaRecorder` on a mono mic stream (`getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })`), preferred types in order: `audio/ogg;codecs=opus` (Firefox) → uploaded as is; `audio/webm;codecs=opus` (Chrome, Edge, Safari 18.4+) → **remuxed on our server**; neither supported (older Safari: `audio/mp4`) → uploaded as a normal **audio file** (M4A/AAC — the customer sees an audio file, not a voice bubble; the composer shows "Your browser records audio files, not voice notes").
  - Upload: `POST /inbox/media` with `kind: 'voice'` (+ `durationSec` from the browser, re-checked on the server from the container where possible).
  - Server remux `src/modules/inbox/voice/webm-to-ogg.ts` — **pure TypeScript, no ffmpeg, no re-encode**: parse EBML / Matroska (Segment → Tracks: exactly one audio track, `CodecID = A_OPUS`, `CodecPrivate` = OpusHead → channel count 1 (2 → downmix not possible without decoding → rejected 422 `WHATSAPP_MEDIA_INVALID`, the browser asks again with `channelCount: 1`); Clusters incl. **unknown-size** segments / clusters (Chrome writes them), `SimpleBlock` + `BlockGroup`, Xiph / EBML / fixed lacing) → write Ogg pages (OpusHead page, OpusTags page with vendor `cell-ai`, audio pages ≤ 255 segments, granule position from the Opus TOC frame counts at 48 kHz incl. pre-skip, CRC-32 Ogg polynomial, EOS flag on the last page). Output sniffed again (`OggS` + `OpusHead`), size / duration caps, stored as `audio/ogg`.
  - Send: Meta `type: audio` with the uploaded OGG media id — Meta renders OGG / Opus mono as a voice message; if Meta documents an explicit voice flag at implementation time, set it (re-check on the Meta media / messages reference, T10.2).
  - Message: `type: audio`, `media.voice: true`, `media.durationSec`.
  - Mic permission denied / no mic → clear message, no upload; recording auto-stops at `voiceNoteMaxSeconds`; leaving the chat while recording asks to discard.
- **Retention (decision §7 #1 — 3 months):** env `INBOX_RETENTION_DAYS` default **90** (`0` = keep forever; other values must be ≥ 30, production rule). Daily maintenance job **`inbox-retention`** (job id `inbox-retention-<yyyymmdd>`, batches of 1,000, resumable, per account): deletes messages with `at < now − 90 days` (incl. notes, reactions, history imports, echoes) and their stored files (storage `delete`; missing file = fine); then for touched conversations recomputes `lastMessage` (none left → `lastMessage = null`, preview gone, `unreadCount = 0`) — the conversation row, contact, assignment and status stay; reactions pointing at purged messages are just dropped. Same job deletes **orphan uploads** (`mediaToken` unused > 24 h). Audit `inbox.messages_purged` (system, counts only, one per account per run when > 0). History imports skip messages already older than the cutoff (`skippedOld` counter). Settings → Inbox shows "Messages are kept for 90 days" (read only).
- **Thumbnails:** none (the browser scales images; videos show a poster-less player). EXIF untouched.

### 1g. Contacts, opt-out, block

- **Match:** `phoneE164 = '+' + waId` among live contacts of the account → link; none → **auto-create** (`name` = profile name or the number, `source.type = 'whatsapp'`, `whatsapp.waId`), audited as `contact.created` with `source: whatsapp` (system actor). Deleted contacts are not revived (a new one is created; the old conversation keeps its contactId and shows "Contact deleted").
- **Profile name** updates on every inbound (stored on the conversation and `contact.whatsapp.profileName`; the contact's own `name` is not overwritten once a person edited it).
- **Opt-out keywords** (decision §7 #3 — English + Hinglish + Hindi list in §1b, editable): matched only against the **whole** text message after normalising — Unicode NFC, trim, collapse inner whitespace, strip trailing `. ! ? ।` and emoji, upper-case (Latin) — so "band karo" / "BAND KARO!" / "बंद करो।" match, but "mera order band karo mat" or "stop by tomorrow?" do not. Text and button / list replies are checked; captions, history, echoes never.
  - Opt-out → `contact.optedOutAt = now` + DND entry `reason: 'WhatsApp STOP'` (Phase 3 DND service, idempotent) + system line in the chat ("Customer opted out") + audit `inbox.contact_opted_out` (system) + **auto-confirmation** (decision §7 #4, on by default): `optOutReplyText` sent as a normal outgoing text (`origin: system`, `sentBy: null`, inside the window the STOP itself opened; once per opt-out — a second STOP within 24 h sends nothing). Send failure → shown on the bubble like any message, opt-out still stands.
  - Opt-in keywords → clear `optedOutAt` + remove that DND entry (only the WhatsApp-created one; a DND added by a person stays and the system line says so) + audit `inbox.contact_opted_in` + `optInReplyText` when `optInReply`.
  - Already opted out + STOP again → no new audit / DND (idempotent); opted in + START → nothing.
- **Block** — owners / admins / managers (`inbox.assign`): `POST /{phone}/block_users` (only users who messaged in the last 24 h — else 409 with Meta's reason), `conversation.blocked = true`, audit; unblock `DELETE`. Blocked → no sends, inbound from them stops (Meta).
- **Customer changed number** system message → system line + the old contact keeps its phone (no automatic merge — managers decide).

### 1h. Coexistence (WhatsApp Business app numbers)

- `smb_message_echoes` → outgoing message `origin: business_app`, status `sent` (later statuses for an echo wamid, if Meta sends any, update it like any outgoing message — re-checked on a real number in Phase 13), bubble label "Sent from the WhatsApp Business app"; window **not** refreshed (only customer messages open it); no unread.
- `history` chunks → `inbox-history-import` job per event: threads → conversations (`source: history`), messages (`origin: history`, statuses from `history_context.status`), media metadata only if the chunk carries media ids (download if still valid), **no unread, no notifications, no opt-out keyword checks**, messages older than the retention cutoff skipped (§1f); `coexistence.historyProgress` from Phase 9 continues; dedupe by `waMessageId`.
- `smb_app_state_sync` → contacts upsert (`action: add` → create / update name if not edited by a person; `remove` → nothing deleted, only `whatsapp.syncRemovedAt`).

### 1i. Conversation management

- **List** `GET /inbox/conversations?cursor&limit&status=open|closed&filter=unread|mine|unassigned&channelId&q` (cursor by `lastMessage.at` + `_id`); `q` searches contact name / phone (prefix) and message text (text index) — results show conversations with a match snippet (no text in logs).
- **Assign** `PATCH /inbox/conversations/:id { assignedTo | null }` (`inbox.assign`; assignee must be an active user of the account with `inbox.read`) → notification `inbox.conversation_assigned` to the assignee, audit; **close / reopen** `POST /:id/close | /reopen` (`inbox.reply`), audit; inbound reopens automatically (system).
- **Read marker** `POST /:id/read` (`inbox.read`) → `unreadCount = 0`, `lastReadAt`, and (if `sendReadReceipts`) Meta read receipt for the latest inbound message (one call; Meta marks earlier ones read too). Impersonators: marker skipped (read only), no receipt.
- **Typing** `POST /:id/typing` (`inbox.reply`) → Meta typing indicator on the latest inbound (throttle 1 / 10 s, only inside the window).
- **Notes** `POST /:id/messages { type: 'note', text }` (`inbox.reply`) → message `type: note`, never sent, shown with a yellow tint "Internal note".
- **Unread totals** `GET /inbox/summary` → `{ unreadConversations, assignedToMeUnread, open }` (nav badge + dashboard card).
- **Contact panel data** `GET /inbox/conversations/:id/contact` → Phase 3 contact (name, phone, tags, lists, custom fields, DND / opt-out), recent calls (Phase 7), call permission (Phase 12 placeholder `null`), other conversations of this contact (other numbers).

### 1j. Realtime

- Account events (to every connected user of the account; **ids + counts only, no text**): `inbox.conversation.updated { conversationId, status, unreadCount, assignedTo, lastMessageAt, lastMessageDirection }`, `inbox.summary.updated { unreadConversations }`.
- Topic `conversation:<id>` (authorised: account + `inbox.read`): `inbox.message.created { message }` (full view), `inbox.message.updated { messageId, status, error?, media? , reactions? }`, `inbox.typing { conversationId, by: 'agent', userId }` (other agents see "Asha is typing" — internal only).
- Frontend: list refreshes from account events (+ polling 15 s while the page is open — live updates can be off), open chat subscribes to its topic (+ polling 5 s while any outgoing message is `queued` / `accepted`).

### 1k. Limits (`INBOX_LIMITS`)

| Limit                                                                                                                                                    | Value                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `textMax` / `captionMax`                                                                                                                                 | 4096 / 1024                                     |
| `imageMaxBytes` / `videoMaxBytes` / `audioMaxBytes` / `stickerMaxBytes` / `documentMaxBytes`                                                             | 5 MB / 16 MB / 16 MB / 100 KB / 100 MB          |
| `inboundMediaMaxBytes`                                                                                                                                   | 100 MB                                          |
| `buttonsMax` / `buttonTitleMax` / `listRowsMax` / `listSectionsMax` / `rowTitleMax` / `rowDescriptionMax` / `headerTextMax` / `footerMax` / `ctaTextMax` | 3 / 20 / 10 / 10 / 24 / 72 / 60 / 60 / 20       |
| `contactsMax`                                                                                                                                            | 10                                              |
| `conversationsPageMax` / `messagesPageMax`                                                                                                               | 50 / 100                                        |
| `sendsPerMinutePerUser`                                                                                                                                  | 60 (`rl:inbox-send:`)                           |
| `uploadsPerMinutePerUser`                                                                                                                                | 20 (`rl:inbox-upload:`)                         |
| `sendAttempts` / `sendRetryBaseMs`                                                                                                                       | 5 / 2000                                        |
| `mediaDownloadAttempts` / `mediaDownloadRetryBaseMs`                                                                                                     | 6 / 10 000                                      |
| `typingThrottleMs`                                                                                                                                       | 10 000                                          |
| `previewMax`                                                                                                                                             | 120                                             |
| `statusHistoryMax`                                                                                                                                       | 10                                              |
| `notificationThrottleMs` (new-message bell per conversation)                                                                                             | 600 000                                         |
| `orphanUploadTtlMs`                                                                                                                                      | 24 h                                            |
| `windowMs`                                                                                                                                               | 24 h                                            |
| `voiceNoteMaxSeconds` / `voiceNoteMinMs`                                                                                                                 | 600 / 1000 (shorter → discarded, like WhatsApp) |
| `retentionBatchSize`                                                                                                                                     | 1000                                            |
| `optOutKeywordsMax` / `keywordMaxLength` / `replyTextMax`                                                                                                | 30 / 30 / 1024                                  |
| `optOutReplyCooldownMs`                                                                                                                                  | 24 h                                            |

### 1l. Security & privacy

- Messages / media are customer data: tenant-scoped everywhere (another account's conversation / message id → 404), topic auth, signed media links (5 min), uploads sniffed (magic bytes vs declared mime + allowed list per type), file names sanitised (no path, ≤ 200 chars), SVG / HTML never served inline.
- Logs: ids, types, statuses, Meta error codes only — never text, captions, names, phones, file names, Meta media URLs, tokens. Job data: ids only.
- Notifications (decision §7 #2): title "New WhatsApp message" + contact **name** + link — **never** the message text, caption or file name (no setting to turn it on); a test asserts the stored notification has no message text.
- XSS: message text rendered as text (links detected and rendered as anchors with `rel="noopener noreferrer"` + `target="_blank"`), no HTML; interactive / vCard fields escaped.
- Outbound URLs (CTA, text with links) must be `https:` (CTA) / any (text); no `javascript:`.
- Impersonating superadmin: read everything, send nothing (403 `AUTH_IMPERSONATION_BLOCKED`), no read receipts.
- Rate limits §1k; sends also limited by Meta throughput (130429 handled).
- Retention / deletion: messages + media older than **90 days** deleted daily (§1f); account deletion (Phase 16) deletes conversations + messages + media; contact deletion keeps the chat (business record) — open question §7 #9.
- Voice recording: the mic is used only while the agent holds / taps record (browser indicator visible); recordings never stored in the browser (memory only, discarded on cancel); the remuxer is a parser of untrusted input → bounded loops, size checks before every allocation, fuzz-style tests with truncated / corrupt files.

### 1m. Permissions & roles

| Permission                                                         | Owner / Admin | Manager | Agent | Viewer |
| ------------------------------------------------------------------ | ------------- | ------- | ----- | ------ |
| `inbox.read` (new)                                                 | ✓             | ✓       | ✓     | ✓      |
| `inbox.reply` (new) — send, notes, close / reopen, typing          | ✓             | ✓       | ✓     | —      |
| `inbox.assign` (new) — assign anyone, block / unblock, retry media | ✓             | ✓       | —     | —      |
| `whatsapp.manage` (Phase 9) — business profile edit                | ✓             | —       | —     | —      |

Agents may assign **themselves** (`assignedTo = me` with `inbox.reply`). New permissions → migration `syncSystemRoles()`.

### 1n. API surface (all `/api/v1`)

| Method      | Path                                         | Permission                                 | Notes                                                                                                                                                                                   |
| ----------- | -------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET         | `/inbox/summary`                             | `inbox.read`                               | unread / open counts                                                                                                                                                                    |
| GET         | `/inbox/conversations`                       | `inbox.read`                               | §1i filters, cursor                                                                                                                                                                     |
| GET         | `/inbox/conversations/:id`                   | `inbox.read`                               | detail (window, assignment, channel, contact summary)                                                                                                                                   |
| GET         | `/inbox/conversations/:id/messages`          | `inbox.read`                               | cursor (older), `around=<messageId>` (jump to a reply)                                                                                                                                  |
| GET         | `/inbox/conversations/:id/contact`           | `inbox.read`                               | contact panel                                                                                                                                                                           |
| POST        | `/inbox/conversations/:id/messages`          | `inbox.reply` (`note` too)                 | `{ clientId, type, … }` §1d; `rl:inbox-send:`                                                                                                                                           |
| POST        | `/inbox/conversations/:id/read`              | `inbox.read`                               | marker + receipt                                                                                                                                                                        |
| POST        | `/inbox/conversations/:id/unread`            | `inbox.read`                               | team-only marker (`unreadCount = 1`); no Meta call                                                                                                                                      |
| POST        | `/inbox/conversations/:id/typing`            | `inbox.reply`                              |                                                                                                                                                                                         |
| PATCH       | `/inbox/conversations/:id`                   | `inbox.assign` (or `inbox.reply` for self) | `{ assignedTo }`                                                                                                                                                                        |
| POST        | `/inbox/conversations/:id/close`, `/reopen`  | `inbox.reply`                              |                                                                                                                                                                                         |
| POST        | `/inbox/conversations/:id/block`, `/unblock` | `inbox.assign`                             | Meta Block API                                                                                                                                                                          |
| POST        | `/inbox/conversations/start`                 | `inbox.reply`                              | `{ channelId, contactId }` → existing conversation or a new one (window closed → only notes until Phase 11 templates)                                                                   |
| POST        | `/inbox/media`                               | `inbox.reply`                              | multipart upload (`kind`: image / video / audio / voice / document / sticker; `voice` → WebM remuxed to OGG) → `{ mediaToken, mimeType, size, kind, durationSec? }`; `rl:inbox-upload:` |
| GET         | `/inbox/messages/:id/media`                  | `inbox.read`                               | signed link                                                                                                                                                                             |
| POST        | `/inbox/messages/:id/retry`                  | `inbox.reply`                              | failed outgoing → re-queue (same clientId chain: `retryOf`)                                                                                                                             |
| POST        | `/inbox/messages/:id/media/retry`            | `inbox.assign`                             | failed inbound download (< 7 days)                                                                                                                                                      |
| GET / PATCH | `/whatsapp/channels/:id/profile`             | `whatsapp.read` / `whatsapp.manage`        | business profile (about, address, description, email, websites ≤ 2, vertical)                                                                                                           |
| POST        | `/whatsapp/channels/:id/profile/photo`       | `whatsapp.manage`                          | JPEG / PNG ≤ 5 MB, 192–640 px square (resumable upload → handle → profile)                                                                                                              |
| GET / PATCH | `/account/inbox-settings`                    | `account.read` / `account.update`          | read receipts, keywords (opt-out / opt-in), auto-confirmation texts, notify mode; `retentionDays` returned read-only                                                                    |
| POST        | `/dev/meta/webhooks` (Phase 9)               | dev                                        | new inbound kinds §1o                                                                                                                                                                   |

- **Error codes (new):** `WHATSAPP_WINDOW_CLOSED` (409), `WHATSAPP_RECIPIENT_BLOCKED` (409), `WHATSAPP_MEDIA_INVALID` (422 — type / sniff mismatch), `WHATSAPP_MEDIA_TOO_LARGE` (413), `INBOX_MEDIA_EXPIRED` (410 — Meta media older than 7 days). Count 54 → 59.
- **Audit (new):** `inbox.conversation_assigned`, `inbox.conversation_closed`, `inbox.conversation_reopened` (user only; system reopen not audited), `inbox.contact_opted_out` (system), `inbox.contact_opted_in` (system), `inbox.contact_blocked`, `inbox.contact_unblocked`, `inbox.history_imported` (system, counts), `inbox.messages_purged` (system, counts — retention), `inbox.settings_updated`, `whatsapp.profile_updated`. Count 95 → 106. Meta: conversation id, channel id, counts — never text / phone.
- **WS (new):** `inbox.conversation.updated`, `inbox.summary.updated` (account); `inbox.message.created`, `inbox.message.updated`, `inbox.typing` (topic `conversation:<id>`).
- **Notifications (new types):** `inbox.message_received` (assignee, else every user with `inbox.reply` per `notifyOnNewMessage`; throttled per conversation), `inbox.conversation_assigned` (assignee). Count 17 → 19. No emails.

### 1o. Fake Meta + simulator (dev / test / E2E)

- `sendMessage` → `wamid.FAKE<hex>`; after `FAKE_META_STATUS_DELAYS_MS` (default `[500, 1500, 3000]`) the fake **posts signed status webhooks** (sent → delivered → read) through the real `/webhooks/meta` pipeline (in-process, like the simulator), unless a knob says otherwise.
- **Recipient knobs (customer phone ending):** `00009` → `failed 131026` (undeliverable); `00008` → stays `delivered` (never read); `00007` → `failed 131047` (window); `00006` → throughput error `130429` twice then accepted (retry path).
- **Media:** fake `uploadMedia` stores bytes in Redis (≤ 16 MB, TTL 1 day) → `fake_media_<hex>`; `getMediaUrl` → `http://<APP_URL>/api/v1/dev/meta/media/<id>?sig=…` (dev route, signed, non-production) so the real download code path is exercised; fixtures: sample JPEG / PNG / MP4 / OGG / PDF / WebP in `tests/fixtures/meta/media/` (tiny files) + voice fixtures in `tests/fixtures/voice/` (WebM/Opus built by a test-only EBML writer: known-size, unknown-size clusters, `BlockGroup`, laced blocks, stereo, non-Opus, truncated; plus one real Chromium recording captured from the E2E fake mic, ≤ 30 KB). The fake records for every audio send whether the uploaded bytes are a valid OGG/Opus (`OggS` + `OpusHead`, mono) and marks it `voice` in its state (E2E asserts it).
- **Simulator kinds (new):** `inbound_text` (exists) + `inbound_image`, `inbound_video`, `inbound_audio`, `inbound_voice`, `inbound_document`, `inbound_sticker`, `inbound_location`, `inbound_contacts`, `inbound_button_reply` (to the last interactive), `inbound_list_reply`, `inbound_template_button`, `inbound_reaction` (to the last outgoing), `inbound_reply` (context on the last outgoing), `inbound_forwarded`, `inbound_ad_referral`, `inbound_order`, `inbound_nfm_reply`, `inbound_unsupported`, `inbound_number_changed`, `inbound_deleted`, `inbound_stop`, `inbound_start`, `inbound_stop_hinglish` (`BAND KARO`), `inbound_stop_hindi` (`बंद करो`), `status_failed` (last outgoing), `echo_text` (exists), `history_chunk` (now with threads that import), `contacts_sync`, `window_expired` (dev / test only: moves the conversation's `lastInboundAt` back 25 h so the closed-window state can be tested), `age_messages` (dev / test only: moves a conversation's messages `at` back N days so the retention job can be run and checked), `run_retention` (dev / test only: runs the `inbox-retention` job now for this account). Each takes optional `{ from, text }` (dev UI "Simulate customer message" box: a test customer phone + text / kind).
- Inbox dev panel (fake provider + non-production): "Simulate customer" drawer on the chat → kind + text → simulator.

### 1p. Frontend

- **Menu:** **Inbox** (`/inbox`, icon `ForumOutlined` or `QuestionAnswerOutlined`, `inbox.read`, `phase: 10`, **unread badge**), `LIVE_PHASE = 10`.
- **Inbox page** (`/inbox`, `/inbox/:conversationId`, lazy chunk; mobile: list → chat → panel as stacked views):
  - **Left — conversation list:** search box (debounced 300 ms), filter tabs (All · Unread · Mine · Unassigned · Closed), channel select (when > 1 number), rows (avatar initials, name / number, last message preview with type icon + "You:" / "Phone:" prefixes, time, unread badge, assignee avatar, window icon when open), "Load more", empty states, live re-ordering.
  - **Middle — chat:** header (name, number, channel label, window state "Open · 3 h 12 m left" / "Closed", assignee select, close / reopen, more menu: block / unblock, mark as unread (sets `unreadCount = 1`, team-only), view contact), message list (infinite scroll up, date separators, unread divider, jump to replied message, "Load newer" when far), bubbles per type §1c / §1d (text with links, image grid tap-to-view lightbox, video / audio players, voice note label, document card with size + download, sticker, location card, contacts card + "Add contact", interactive reply chips + outgoing buttons / list preview, order / form cards, system lines, unsupported, deleted, note), reactions row, reply quote, forwarded / ad labels, origin label (Business app / History), status ticks (clock queued / ✓ sent / ✓✓ delivered / blue ✓✓ read / ⚠ failed with tooltip + **Retry**), media status (downloading / failed + Retry).
  - **Composer:** text area (Enter sends, Shift+Enter newline, 4096 counter), emoji picker (lazy), attach menu (Photo / Video, Audio, Document, Sticker) with preview + caption + upload progress + cancel, **Voice note** (mic button shown while the text box is empty — like WhatsApp: tap → recording with red dot + timer + cancel (trash) → stop → preview player (play / re-record / send) → upload progress → bubble; auto-stop at 10 min; < 1 s discarded; mic denied / no mic / unsupported browser messages; Esc cancels), **Location** dialog (lat / long / name / address, "Use my location"), **Contact card** picker (Phase 3 search), **Interactive** builder (buttons / list / link button with live preview + limits), reply-to bar, **Note** toggle (yellow), **Templates** button (disabled — "Templates arrive in Phase 11"), window closed → composer replaced by banner "The 24-hour window is closed. You can reply when the customer writes again, or send a template (Phase 11)." + notes still allowed; opted-out banner; blocked banner; read-only for viewers / impersonators.
  - **Right — contact panel:** name / phone (copy), WhatsApp profile name, tags, lists, custom fields (Phase 3), DND / opt-out state, channel, assignee, call permission (placeholder "Calling arrives in Phase 12"), recent calls (Phase 7), other conversations, "Open contact".
  - Typing indicator from other agents ("Asha is typing…"), new-message sound (off by default, toggle stored in localStorage).
- **Contact page:** **Open chat** (existing conversation) / **Start chat** (window closed → opens with banner + notes only).
- **Numbers page (Phase 9):** drawer gets **Business profile** section (edit about / description / address / email / websites / vertical / photo).
- **Settings → Inbox** tab: read receipts (on by default — decision §7 #5), opt-out / opt-in keyword chips (defaults incl. Hinglish / Hindi, add / remove, duplicate across lists blocked), auto-confirmation toggles + texts (opt-out / opt-in) with character counters, new-message notifications mode, "Messages are kept for 90 days" (read only).
- **Notifications:** icons / texts / links for the 2 new types; **dashboard card** "Inbox: N unread · M assigned to you".
- **Bundle:** Inbox page lazy, emoji picker lazy chunk, lightbox lazy, voice recorder lazy (native `MediaRecorder`, no library); main growth ≤ 3 KB gzip.

### 1q. Testing strategy

- **Unit (backend):** normalizers per inbound type (fixtures from Meta's documented samples, test values only), outbound body builders per type (exact Graph JSON), limits / validation, window math, status ranking (every pair + out-of-order), opt-out / opt-in keyword matching (every default word in English / Hinglish / Hindi, case, whitespace, trailing `।` / `!` / emoji, NFC vs NFD Devanagari, partial sentences **not** matched), auto-confirmation once per opt-out (cooldown), error-code mapping, preview builder, mime sniffing, **WebM → OGG remuxer** (every fixture: valid Ogg pages + CRC, granule positions monotonic and equal to the summed Opus frame durations, packet count = block count, OpusHead copied, EOS on the last page; stereo / non-Opus / two tracks / truncated / corrupt sizes / huge declared sizes → 422 without big allocations), **retention job** (90-day boundary to the second, media deleted, `lastMessage` recomputed / cleared, other accounts and newer messages untouched, `0` disables, resumable after a crash, history import skips old messages).
- **Graph client:** stub server — `sendMessage` (each type's exact body), `markRead` (+ typing), `uploadMedia` (multipart), `getMediaUrl`, `downloadMedia` (Bearer, size cap, mime), `blockUsers` / `unblockUsers`, `getProfile` / `updateProfile`, profile photo resumable upload; retries / error mapping (131056 retry-after, 130429).
- **Integration:** inbound every type → contact (match / auto-create) + conversation + message + WS + notification (throttled) + unread; duplicates once; out-of-order timestamps ordered; media download success / retry / fail / expired; statuses (monotonic, failed reasons, unknown wamid ignored, pricing stored); outbound every type (validation, window closed 409, opted-out within window allowed, blocked 409, channel not ready, idempotent clientId, retries, error → failed + reason, 190 → needs reconnect); read receipts / typing (throttle, impersonator skip); assign / close / reopen / notes / block; search + filters + cursor; backfill of Phase 9 deferred events; coexistence echoes / history import / contacts sync; topic auth; roles × routes; isolation; suspended account (writes 403); WhatsApp off → 503; logs clean (pino capture: no text / phone / names / file names / tokens).
- **Hardening:** 1,000 inbound messages across 50 conversations in bursts (order, counts, unread exact), 200 outbound sends in parallel (no double send, statuses settle), worker restart mid-send (no double send — Meta call idempotency via our `clientId` + `accepted` state check), media download crash / resume, history import of 5,000 messages, retention purge of 20,000 messages across 3 accounts (time recorded, no other data touched), remux of a 10-minute recording (time + memory recorded).
- **Frontend unit:** clients / hooks / WS + topic merges, list (filters, search, live reorder, load more), every bubble type, ticks, reply / reactions, composer (each type, limits, upload progress / cancel / errors, window closed, read only), voice recorder (mocked `MediaRecorder` / `getUserMedia`: type preference order, timer, auto-stop, < 1 s discard, cancel, denied / no mic / unsupported, mp4 fallback label), interactive builder validation, contact panel, settings (keyword chips, duplicate across lists, reply texts, retention read only), profile editor, notifications, nav badge — branch-complete.
- **E2E (Playwright, fake Meta):** see T10.11.
- Coverage gates stay ≥ backend 95 / 85 / 95 / 95, frontend 95 / 90 / 90 / 95.

### 1r. Contract for later phases

| Function / data                                                                              | Used by                                                                 |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `outbound.send(conversation, input)` (type builders, window check bypass flag for templates) | Phase 11 templates, Phase 20 bulk                                       |
| `messages.pricing` + statuses                                                                | Phase 11 billing settle                                                 |
| `conversation.windowExpiresAt`, `contact.optedOutAt`                                         | Phase 11 (template rules), Phase 12 (call permission request), Phase 20 |
| `inbox.message.*` events + topic                                                             | Phase 12 (call permission reply), Phase 15 (webhooks)                   |
| interactive builder + `button_reply` handling                                                | Phase 12 (call permission request button), bots later                   |

---

## 2. Tasks ka overview

| #      | Task                                                                                                                                                                                                                                                     | Repo | Size | Depends on    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- | ------------- |
| T10.1  | Models (Conversation, Message), contact / account fields, migration 0011 (+ backfill enqueue), `INBOX_LIMITS`, env, codes, audit, WS, notifications, permissions                                                                                         | BE   | M    | —             |
| T10.2  | `MetaClient` extension (send every type, read / typing, media upload / url / download, block, profile) + fake (wamid, auto statuses, media store, knobs) + schemas / fixtures for every inbound type + statuses                                          | BE   | L    | T10.1         |
| T10.3  | Inbound pipeline: normalizers, contact match / create, conversation upsert, ordering, unread / window, media download job, opt-out / opt-in, statuses (monotonic), coexistence (echoes, history import, contacts), deferred backfill, WS + notifications | BE   | L    | T10.2         |
| T10.4  | Outbound pipeline: validation per type, window / opt-out / block / channel rules, idempotency, upload service, **voice WebM → OGG remuxer**, send job (retries, error mapping), read receipts + typing, notes, **retention job**                         | BE   | L    | T10.2, T10.3  |
| T10.5  | Inbox API (conversations, messages, actions, media, summary, contact panel, settings, business profile), topic auth, rate limits, OpenAPI                                                                                                                | BE   | M    | T10.3, T10.4  |
| T10.6  | Simulator kinds + dev media route + `dev:inbox` + seed, hardening (bursts, parallel sends, restart, history 5,000), ADR 0038, docs, real-number manual checklist                                                                                         | BE   | M    | T10.5         |
| T10.7  | FE foundation: `gen:api`, clients, keys / hooks (infinite lists, topic merges), WS events, nav Inbox + badge (`LIVE_PHASE = 10`), routes, labels, permission hooks, formatting helpers                                                                   | FE   | M    | T10.6         |
| T10.8  | Inbox page: list (search, filters, live), chat view (every bubble type, media viewer / players, ticks, reactions, reply quotes, date / unread dividers, infinite scroll, window header)                                                                  | FE   | L    | T10.7         |
| T10.9  | Composer: text + emoji, attachments with upload progress, **voice note recorder**, location, contact card, interactive builder, reply-to, reactions, notes, window / opt-out / blocked / read-only states, retry failed                                  | FE   | L    | T10.8         |
| T10.10 | Contact panel, conversation actions (assign, close / reopen, block), contact page Open / Start chat, Settings → Inbox, business profile editor, notifications, dashboard card, dev "Simulate customer"                                                   | FE   | M    | T10.8         |
| T10.11 | Playwright E2E — whole suite twice                                                                                                                                                                                                                       | FE   | M    | T10.9, T10.10 |
| T10.12 | Gap audit, security checklist, docs, Phase 10 sign-off                                                                                                                                                                                                   | both | M    | all           |

Batches: **Batch 1 = T10.1–T10.4** (`[P10-B1-DONE]`), **Batch 2 = T10.5–T10.6** (`[P10-B2-DONE]`), **Batch 3 = T10.7–T10.12** (`[P10-B3-DONE]`).

---

## 3. Tasks — step by step

### T10.1 — Models, migration 0011, limits, catalogue

- [x] `conversation.model.ts`, `message.model.ts` (§1b, `tenantPlugin`, every field declared — AutoChatix lost reactions to strict mode — enums exported as const arrays for zod / OpenAPI), indexes incl. partial uniques + text index.
- [x] Contact `whatsapp` sub-document; account `settings.inbox` with the §1b defaults (English + Hinglish + Hindi keywords, both auto-confirmation texts on, read receipts on); message `at` field + indexes.
- [x] Migration **0011-inbox**: collections + indexes, account settings backfill, `syncAllSystemRoles()` (`inbox.read` / `inbox.reply` / `inbox.assign`), enqueue `inbox-backfill` (idempotent); `down` refuses when messages exist, else drops + unsets + pulls permissions; up / down / up test.
- [x] `INBOX_LIMITS` (§1k); env: `INBOX_RETENTION_DAYS` (default **90**, `0` = keep, else ≥ 30), `FAKE_META_STATUS_DELAYS_MS` (dev / test only; production must not set), production rules + `env.test.ts` + `.env.example` + README table.
- [x] Error codes +5 (→ 59), audit +11 (→ 106), notifications +2 (→ 19), WS events (5) in backend `events.ts` + websocket.md, topic kind `conversation`, queue job names (`message.send`, `media.download`, `inbox.backfill`, `inbox.history-import`, `read.receipt`), maintenance job `inbox-retention` (daily), permissions + role matrix snapshot, docs (data-model §2.8, error-codes, audit, websocket, rbac).
- [x] Tests: models (validation, defaults, uniques — same wamid twice → duplicate; same clientId twice → duplicate; text index present), migration, catalogue counts, permissions.

### T10.2 — Meta core extension

- [x] `MetaClient` methods: `sendMessage(token, phoneId, payload)` → `{ waMessageId }`, `markRead(token, phoneId, waMessageId, { typing? })`, `uploadMedia(token, phoneId, { bytes, mimeType, fileName })` → `{ mediaId }`, `getMediaUrl(token, mediaId)` → `{ url, mimeType, size, sha256 }`, `downloadMedia(token, url, { maxBytes })` → stream, `blockUsers` / `unblockUsers(token, phoneId, waIds[])` → per-user results, `getBusinessProfile` / `updateBusinessProfile(token, phoneId, fields)`, `uploadProfilePhoto(token, appId, bytes)` (resumable `POST /{app-id}/uploads` → handle → `profile_picture_handle`).
- [x] `payloads.ts` — pure builders per outbound type (§1d) → exact Graph JSON (`messaging_product`, `recipient_type: individual`, `to`, `type`, `context`); limits enforced again (defence in depth).
- [x] Error mapping additions (§1d codes → `retryable`, `retryAfterSec`, `channelEffect: needs_reconnect | restricted | none`).
- [x] Fake: wamids, auto status webhooks (signed, through the receiver) with delays + recipient knobs (§1o), media store in Redis + dev download route, block / profile in Redis, `failNext` for every new op.
- [x] Zod schemas for every inbound message type, statuses (+ `pricing`, `conversation`, `errors`), media url answer, profile; fixtures `tests/fixtures/meta/messages-*.json` (one per type + statuses sent / delivered / read / failed / deleted) from Meta's documented samples with test values; fixtures README updated.
- [x] Tests: stub-server per method (exact path / method / headers / body / multipart), download size cap + mime mismatch, retries / mapping, fake determinism + knobs + auto statuses, every fixture parses.

### T10.3 — Inbound pipeline

- [x] `normalize.ts` — Meta message → our message fields per type (§1c), preview builder, system line texts (numbers masked).
- [x] `inbound.service.ts` — per message: dedupe (`waMessageId`), contact match / auto-create (§1g), conversation upsert (reopen, window, unread, profile name, `lastMessage` by `metaTimestamp`), insert message, reaction → target `reactions[]`, reply context → `replyToMessageId`, media → `media.download` job, opt-out / opt-in keywords (`optout.service.ts`: normaliser, matcher, DND, audit, auto-confirmation via the outbound pipeline with cooldown), WS account + topic events, notifications (throttled, per setting).
- [x] `status.service.ts` — §1e monotonic statuses, errors, pricing, `deleted`, unknown wamid counter, channel effects (190 → needs reconnect via Phase 9 `markNeedsReconnect`; 368 → restricted).
- [x] `media.service.ts` — download job (§1f), retries, failed / expired, signed links.
- [x] `coexistence-import.ts` — echoes (§1h), history import job (threads, dedupe, progress), contacts sync.
- [x] Register the consumers (`registerDeferredField('messages' | 'smb_message_echoes' | 'history' | 'smb_app_state_sync')`) and switch those Phase 9 handlers to process; `inbox-backfill` job (deferred events → consumed, oldest first, batches of 200, resumable).
- [x] Tests: every inbound fixture end to end (WS payloads without text on the account event, full on the topic), duplicates, out-of-order, reaction add / remove, reply context, media success / retry / fail / expired, opt-out / opt-in (every default keyword, DND entry created / removed, person-added DND kept, idempotent, audit, confirmation text sent once, cooldown), statuses table, backfill, coexistence, notification throttle, logs clean.

### T10.4 — Outbound pipeline

- [x] `outbound.schema.ts` — discriminated union per type (zod), limits from `INBOX_LIMITS`.
- [x] `upload.service.ts` — multipart (busboy / multer already used in Phase 3? reuse the contact-import upload middleware), magic-byte sniffing (`file-type` lib if present, else a small signature table), size per kind, storage key, `mediaToken` (signed, 24 h); `kind: voice` → OGG passes through (validated), WebM → remux, MP4 → stored as a normal audio file (`voice: false`).
- [x] `voice/webm-to-ogg.ts` + `voice/ogg.ts` (page writer, CRC-32) + `voice/opus-toc.ts` (frame durations) — §1f-voice; bounded parser; test-only EBML writer in `tests/helpers/webm.ts` builds the fixtures.
- [x] `retention.job.ts` — §1f retention (`inbox-retention`, maintenance schedule like the Phase 1 jobs, batches, resumable, media delete, `lastMessage` recompute, orphan uploads, audit counts).
- [x] `outbound.service.ts` — §1d rules (window, opt-out banner rule, blocked, channel ready, conversation reopen on send, assignment untouched), idempotent `clientId`, message `queued`, enqueue `message.send` (job id `msg-send-<messageId>`), WS.
- [x] `send.job.ts` — load message + token (`getChannelToken`), upload media if needed (cache `metaMediaId`), `sendMessage`, `accepted` + wamid (guard: never call Meta twice for an `accepted` message — restart safety), error mapping → retry / failed + reason / channel effects; retry endpoint (failed → new attempt, `retryOf`).
- [x] `receipts.ts` — read marker + Meta read receipt (setting, impersonation skip), typing (throttle in Redis `inbox-typing-<conversationId>`).
- [x] Notes (`type: note`, never queued).
- [x] Tests: every type's exact Graph body through the fake / stub, validation errors per field, window closed 409, opted-out inside window allowed, blocked 409, channel states, idempotency (same clientId → same message, one Meta call), retries + 130429 / 131056, failed reasons, restart mid-send, upload sniffing (PNG renamed .pdf → 422), oversize 413, voice uploads (OGG as is, WebM remuxed, stereo / corrupt → 422, too long → 422, MP4 → audio file), retention job (§1q), receipts / typing throttle, notes, logs clean.

### P10-B1-DONE — checkpoint

- [x] Full backend verify (each command separately); `dev:inbox` script (connects a fake number, simulates 10 inbound messages of different types, sends 5 replies, waits for statuses, prints counts only) run on the dev DB; tasks ticked, plan changelog; commit `docs: mark phase 10 batch 1 complete [P10-B1-DONE]`.

### T10.5 — Inbox API

- [x] `inbox.routes.ts` + schemas (§1n), static paths before `/:id`, `requirePermission`, `blockWhenImpersonating()` on writes (read marker: no-op for impersonators), suspended → writes 403, WhatsApp off → 503, rate limits `rl:inbox-send:` / `rl:inbox-upload:`.
- [x] Views (`inbox-json.ts`): conversation row / detail, message (per type; media without storage keys — only `GET …/media`), contact panel.
- [x] Topic auth `conversation:<id>` (extend `authorizeTopic`), WS event types in `events.ts`.
- [x] Business profile routes (Phase 9 module), account inbox settings routes.
- [x] OpenAPI: every route + schema (import in `src/openapi.ts`), docs test paths, `openapi:check`.
- [x] Tests: roles × routes (owner / admin / manager / agent / viewer / superadmin / impersonating), isolation on every `:id` route, search + filters + cursor, assign rules (self-assign for agents, assignee must have `inbox.read`), close / reopen, block / unblock (Meta 24 h rule error), summary counts, settings, profile (fake), topic auth, rate limits, 503 / 403.

### T10.6 — Dev tools, hardening, docs

- [x] Simulator kinds (§1o) + optional `{ from, text }`; dev media route; `npm run dev:inbox [-- --account <slug>]`; seed: Demo Finance gets 4 conversations (text chat with replies, media chat, a closed one, a coexistence echo) through the real pipeline.
- [x] Hardening tests (§1q) — record timings.
- [x] **ADR 0038 — WhatsApp inbox (conversations, messages, statuses, media, window)**; docs: data-model §2.8, api.md §14d, security.md (customer messages, media, uploads), compliance-notes (90-day message retention, opt-out handling incl. Hinglish / Hindi keywords + confirmation texts, voice recording consent note, DPDP), README (Inbox section, simulator kinds, env), src/README rows, CHANGELOG.
- [x] **Real number manual checklist** in `docs/setup/meta-whatsapp.md` §13 (send / receive every type with a real phone, statuses, window expiry, STOP + `BAND KARO` + `बंद करो` with confirmation texts, media both ways, **voice note recorded in Chrome, Firefox and Safari plays as a voice message on Android + iPhone**, coexistence echo) — runs in Phase 13.

### P10-B2-DONE — checkpoint

- [x] Full backend verify + manual check through the HTTP API on the dev server (simulate inbound of every type, reply with every type, statuses arrive, window-closed 409, STOP → opted out, media links work, logs clean); tasks ticked; commit `docs: mark phase 10 batch 2 complete [P10-B2-DONE]`.

### T10.7 — FE foundation

- [x] `gen:api`; `services/api/inbox.ts` (+ upload with progress via axios `onUploadProgress`), profile + settings clients; types; fixtures `src/test/inbox.ts` (`fakeConversation`, `fakeMessage(type)` for every type).
- [x] `features/inbox/{keys,queries,labels,format,permissions}.ts`: infinite conversations / messages, `useConversationTopic(id)` merging `inbox.message.*` into the cache, account events → list / summary, polling fallbacks (§1j), mutations (send with optimistic `queued` bubble keyed by `clientId`, read, typing throttle, assign, close / reopen, block, retry), `useCanReply` / `useCanAssign`, status tick helpers, window countdown helper, preview / type labels, file size format.
- [x] Realtime: event types + topic `conversation:<id>` subscribe.
- [x] Nav **Inbox** with unread badge (`inbox.read`, `phase: 10`), `LIVE_PHASE = 10`, layout test; routes `/inbox`, `/inbox/:conversationId` (lazy).
- [x] Tests: clients, hooks (merge order, dedupe optimistic vs real, polling stop), labels, nav.

### T10.8 — Inbox page (list + chat view)

- [x] Three-pane layout (responsive), conversation list (§1p left), chat header (window state, assignee, actions menu), message list (infinite up, separators, unread divider, jump to reply, auto-scroll on new when at bottom else "New messages" pill), **bubbles for every type** (§1c / §1d incl. note, system, deleted, unsupported, order, form, referral, forwarded, business app / history labels), media viewer (lightbox lazy), audio / video players, ticks + failed tooltip + Retry, media download state + Retry (managers).
- [x] Tests: every bubble type renders (text with links escaped — `<script>` stays text), ticks per status, list filters / search / live reorder, unread divider, infinite scroll (load older keeps position), jump to reply, mobile stacking, empty / loading / error states, read marker sent on open (not for impersonators).

### T10.9 — Composer

- [x] Text + emoji (lazy picker) + counter, attachments (kind detection, preview, caption, upload progress, cancel, size / type errors before upload), **voice recorder** (`features/inbox/voice-recorder.ts` hook + `VoiceRecorder.tsx`, §1p: type preference, mono stream, timer, auto-stop, discard < 1 s, preview, re-record, upload `kind: voice`, mic released on stop / unmount), location dialog, contact card picker, interactive builder (buttons / list / CTA URL with limits + live preview), reply-to, reactions (hover / long-press picker), notes toggle, Templates button (disabled with Phase 11 text), window closed / opted out / blocked / read-only / channel not ready states, optimistic send + retry, typing pings.
- [x] Tests: each type sends the exact body, validation per limit, upload flows (progress, cancel, 413 / 422 from server), window closed hides send (notes allowed), keyboard (Enter / Shift+Enter), optimistic → real replacement, failed → Retry, read only roles, voice recorder states (recording / preview / uploading / denied / unsupported / fallback), mic tracks stopped on cancel / unmount.

### T10.10 — Contact panel + entry points

- [x] Contact panel (§1p right), assign select (self / others by permission), close / reopen, block / unblock (confirm), contact page **Open chat** / **Start chat**, Settings → **Inbox** tab, Numbers drawer **Business profile** editor (+ photo), notification icons / texts / links (2 types), dashboard **Inbox** card, nav badge live, dev **Simulate customer** drawer (fake provider + dev build), bundle check vs `main` (same script as Phase 9).
- [x] Tests for each.

### T10.11 — Playwright E2E

- [x] Backend env: `FAKE_META_STATUS_DELAYS_MS=200,500,800` (fast ticks).
- [x] Chromium launch args for the inbox specs: `--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream` (fake mic, no prompt) + `permissions: ['microphone']`; other specs unchanged.
- [x] Helpers `e2e/inbox.ts`: `connectNumber` (reuse `e2e/whatsapp.ts`), `simulateCustomer(page, kind, text?)` (dev drawer or API), `openConversation`, `sendText`, `sendFile(path)`, `expectTicks(bubble, state)`.
- [x] Specs (one account per spec, serial, unique phones):
  1. **`inbox-done-when.spec.ts`:** connect number → customer sends text → conversation appears live (unread 1, bell) → open (unread 0, read receipt) → reply text → ticks ✓ → ✓✓ → blue ✓✓ → reply with an image (upload progress → bubble) → customer sends image / video / voice note / document / sticker / location / contact card → each bubble renders, media opens / plays / downloads → reply-to a customer message (quote) → customer reacts → emoji on bubble → agent reacts → interactive buttons sent → customer taps a button → "Replied: …" → list + CTA URL sent → **voice note**: tap mic → record 3 s (fake mic) → preview → send → voice bubble with duration → ticks → fake confirms it received a valid mono OGG/Opus.
  2. **`inbox-window-statuses.spec.ts`:** a conversation whose window expired (simulator kind `window_expired` — dev / test only — moves `lastInboundAt` back 25 h) → composer blocked + banner, notes still work, API 409 → customer writes → window open again; failed recipient (`…00009`) → ⚠ with "Message undeliverable" + Retry; never-read recipient (`…00008`) stays ✓✓; throughput knob (`…00006`) still delivers.
  3. **`inbox-optout-coexistence.spec.ts`:** customer sends "STOP" → opted-out banner + DND on the contact page + auto-confirmation bubble → "START" → cleared + opt-in confirmation → customer sends "band karo" → opted out again → "बंद करो" again → no second confirmation (idempotent) → "SHURU" → cleared; "mera order band karo mat" → nothing happens; retention: `age_messages` 91 days + run the retention job (dev trigger) → old bubbles gone, newer stay, list preview updated; coexistence number → `echo_text` shows "Sent from the WhatsApp Business app" → history chunk imports past messages (no unread) → contacts sync creates contacts.
  4. **`inbox-roles.spec.ts`:** viewer reads, no composer; agent replies, assigns self, can't assign others / block; manager assigns to agent → agent bell "assigned to you" + "Mine" filter; impersonating superadmin read only (no read receipt sent); second account never sees the first's conversations; search by name / text; close → reopen by inbound.
  5. **`inbox-entry-points.spec.ts`:** contact page Open chat; Start chat with a closed window (banner); Settings → Inbox shows read receipts **on** by default → toggle off (fake records no receipt) → on again; adds a custom keyword ("ROKO") → customer sends it → opted out; retention text "90 days" visible; business profile edit on the Numbers drawer; dashboard card + nav badge counts.
- [x] All earlier **77** tests stay green; whole suite **twice** (2nd with `E2E_BACKEND_LOGS=1` → log grep: customer texts used in specs, test phones (full + `+91`), contact names, file names, `wamid`, Meta media urls, tokens, `Bearer`, `sk-`, passwords → 0).

### T10.12 — Gap audit, security, docs, sign-off

- [x] Requirement → test table for §0 / §1 / every task; missing tests added.
- [x] Security checklist (§1l): customer data never in logs / audit / notifications / job data / errors; uploads sniffed; XSS (bubble rendering test with hostile text / file names / vCard / interactive titles); signed media links + isolation; impersonation read only; topic auth; gitleaks both repos; `console.log` 0; no network in tests.
- [x] Coverage re-measured (gates never lowered), bundle numbers, hardening numbers.
- [x] Docs both repos, BUILD_PLAN_V2 Phase 10 ✅ + "Next: Phase 11", tasks all `[x]`, plan changelog, **PHASE_10_SIGNOFF.md**; `[P10-B3-DONE]` (full verify both repos, E2E twice, fresh clones without `.env`, actionlint, gitleaks, `infra:down`).

---

## 4. Deliverables checklist

- [x] Conversations + messages models, contact / account fields, migration 0011 + Phase 9 backfill.
- [x] Meta client: send every free-form type, read / typing, media upload / download, block, business profile; fake with auto statuses + knobs + media.
- [x] Inbound: every type normalised, contacts, conversations, unread, window, media downloads, statuses, opt-out / opt-in, coexistence echoes / history / contacts.
- [x] Outbound: every free-form type, uploads, browser voice notes (WebM → OGG remux), window / opt-out / block rules, idempotent sends with retries, read receipts, typing, notes, opt-out / opt-in confirmations.
- [x] 90-day retention job (messages + media + orphan uploads).
- [x] Inbox API + OpenAPI + topic auth; business profile + inbox settings; simulator kinds + `dev:inbox` + seed; hardening; ADR 0038; real-number checklist.
- [x] UI: Inbox (list, chat with every bubble, composer with every type, contact panel), Open / Start chat, Settings → Inbox, business profile editor, notifications, dashboard card, nav badge.
- [x] Playwright: done-when (both directions every type), window + statuses, opt-out + coexistence, roles, entry points — twice, logs clean.
- [x] Docs: ADR 0038, data-model, api, security, compliance, READMEs, CHANGELOGs, sign-off.

## 5. Risks

| Risk                                                                                 | Mitigation                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meta payload variety (new types, fields) breaks parsing                              | loose schemas, `unsupported` fallback with the raw type, fixtures from Meta samples, schema failure → message stored as `unsupported` (never lost)                                                                                                                    |
| Status webhooks out of order / duplicated                                            | monotonic ranking, dedupe, tests for every pair                                                                                                                                                                                                                       |
| Double send on retries / restarts                                                    | `clientId` unique, `accepted` guard before any Meta call, job id per message                                                                                                                                                                                          |
| Media ids expire (7 days) / large files                                              | immediate download job with retries, size caps, streaming to storage                                                                                                                                                                                                  |
| Browser upload of a renamed file / malicious file                                    | magic-byte sniffing, allowed list, never inline for documents, signed links                                                                                                                                                                                           |
| WS volume on busy accounts                                                           | account events carry ids only; full messages only to subscribers of the open conversation; list polling fallback                                                                                                                                                      |
| Inbox page bundle size (emoji, players, lightbox)                                    | lazy chunks, native `<audio>` / `<video>`, no heavy libs                                                                                                                                                                                                              |
| Coexistence history volume (~180 days)                                               | import job in batches, no notifications, progress shown                                                                                                                                                                                                               |
| Real Meta differences (echo statuses, typing payload, block API limits)              | re-check list in the setup guide §12 / §13 at Phase 13; fake follows Meta's documented samples                                                                                                                                                                        |
| Browser recordings vary (Chrome unknown-size clusters, Safari versions, stereo mics) | pure-TS remuxer tested on generated + real Chromium fixtures, mono forced in `getUserMedia`, clear 422 + MP4 audio-file fallback; if real recordings fail in Phase 13, fallback plan = ffmpeg remux in a worker (`-c:a copy`, no re-encode) behind the same interface |
| Retention deletes data someone still needs                                           | 90 days is a platform decision (§7 #1), shown in Settings, audit counts per run, boundary tests, other accounts / newer messages untouched; legal review can change the env without code changes                                                                      |
| Hinglish keywords matching normal chat ("band karo" inside a sentence)               | whole-message match only after normalising, partial-sentence tests, editable list, audit + system line make every opt-out visible                                                                                                                                     |
| Agents texting opted-out customers                                                   | banner + backend rule (only inside a customer-opened window); business-initiated impossible until Phase 11 templates, which will block opted-out marketing                                                                                                            |

## 6. Recommended order

1. T10.1 → T10.2 → T10.3 → T10.4 (Batch 1) — data and pipelines first, tested on the fake.
2. T10.5 → T10.6 (Batch 2) — API, dev tools, hardening, docs; manual HTTP check.
3. T10.7 → T10.8 → T10.9 → T10.10 → T10.11 → T10.12 (Batch 3) — UI, E2E, sign-off.

_Estimate — run batch-wise with one detailed run prompt (Batch 1 = T10.1–T10.4, Batch 2 = T10.5–T10.6, Batch 3 = T10.7–T10.12)._

## 7. Decisions and open questions

**Answered by the project lead on 23 Oct 2026 (locked):**

| #   | Question                                   | Decision                                                                                                  | Where in the plan                 |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | Message retention                          | **3 months** — `INBOX_RETENTION_DAYS=90`, daily `inbox-retention` job (messages + media + orphan uploads) | §0 #8, §1f, §1l, T10.4, T10.11    |
| 2   | Message preview text in bell notifications | **No** — title + contact name + link only, no setting                                                     | §1l, Conventions                  |
| 3   | Hindi / Hinglish opt-out / opt-in keywords | **Yes** — defaults in §1b (English + Hinglish + Hindi), editable in Settings → Inbox                      | §1b, §1g, T10.3, T10.11           |
| 4   | Auto-confirmation text on STOP             | **Yes** — on by default, English + Hinglish text, also an opt-in confirmation; once per opt-out (24 h)    | §1b, §1g                          |
| 5   | Read receipts to customers by default      | **Yes** — on (account toggle)                                                                             | §1b, §1i, §1p                     |
| 6   | Voice note recording from the browser      | **Yes, in Phase 10** — `MediaRecorder` → WebM/Opus remuxed to OGG/Opus by a pure-TS remuxer (no ffmpeg)   | §1d, §1f-voice, §1p, T10.4, T10.9 |

**Still open (defaults used until answered):**

| #   | Question                                          | Who    | Default                                               |
| --- | ------------------------------------------------- | ------ | ----------------------------------------------------- |
| 7   | Saved replies, auto-assignment (round robin), SLA | You    | Later phase                                           |
| 8   | AI bot replies on WhatsApp (agent from Phase 5)   | You    | Later phase (after Phase 12)                          |
| 9   | Contact deleted — keep its chats?                 | Client | Keep (business record), panel shows "Contact deleted" |
| 10  | Who may block customers                           | You    | Owner / admin / manager (`inbox.assign`)              |

---

## Changelog

- 2026-10-23: Plan created after the Phase 9 sign-off (BUILD_PLAN_V2 → Phase 10). Builds on the Phase 9 deferred-events contract; every free-form type both ways on the fake Meta provider (auto statuses + media), templates and WhatsApp billing stay in Phase 11, calling in Phase 12. Meta facts re-checked on 23 Oct 2026: webhook media ids expire after 7 days (download at once), upload media ids after 30 days; media caps (image 5 MB, audio / video 16 MB, document 100 MB, sticker 100 KB static / 500 KB animated); typing indicator rides on the read receipt and clears after ~25 s; Block API only for users who messaged in the last 24 h (64,000 cap).
- 2026-10-23: Open questions 1–6 answered by the project lead → locked: 90-day message retention (`inbox-retention` job, audit `inbox.messages_purged` → audit count 106, message `at` field for order / paging / purge), no preview text in notifications (setting dropped), Hinglish + Hindi opt-out / opt-in keywords with normalised whole-message matching, auto-confirmation texts on (opt-out + opt-in, 24 h cooldown), read receipts on by default, **browser voice-note recording moved into Phase 10** (pure-TS WebM → OGG/Opus remux, MP4 fallback as an audio file, fake-mic E2E). Questions 7–10 stay open with defaults.
- 2026-10-23: Run prompt prepared ([PHASE_10_PROMPT.md](../prompts/PHASE_10_PROMPT.md)) — refinements locked there (the prompt's §1 wins where it differs from the text above): `inboxUploads` collection with the upload id as the media token, `storageKey()` areas `inbox-uploads` / `inbox-media`, media download host allowlist (SSRF guard), per-conversation send order, own emoji picker / lightbox (no new libraries), fake auto statuses off in unit / integration tests.
- 2026-10-23: T10.1 deviation — migrations have no queue access, so `0011-inbox` does not enqueue `inbox.backfill`; the WhatsApp worker queues it at start whenever deferred `messages` / coexistence events exist (T10.3). DND entries get a `whatsapp` source so an opt-in keyword removes only the entry a WhatsApp opt-out created.
- 2026-10-23: T10.3 deviations — (1) WhatsApp auto-created contacts are not audited: the catalogue has no contact-created action (manual creates aren't audited either). (2) A conversation follows the live contact: when its contact was deleted and the customer writes again, the new contact is linked (the old one is never revived). (3) The inbox consumers are injected into the WhatsApp webhook handlers as hooks (no import cycle); handlers get the event id so a `history` event is imported by its own `inbox.history-import` job and consumed there. (4) `sniff.ts` moved from T10.4 to T10.3 (inbound downloads check the bytes). (5) The WhatsApp worker queues `inbox.backfill` at start whenever deferred inbox events exist; `messages` events stay 30 days while deferred.
- 2026-10-23: T10.4 notes — internal notes are stored `status: sent` (never queued, no ticks) and don't change the list row; reactions don't either. The upload row is deleted in the same transaction as the message insert (a parallel send of the same upload gets 422). The Meta typing indicator is only sent when the account sends read receipts (Meta's typing call also marks the message read). Order waits and Meta's 60 s pair limit move the job to delayed (`DelayedError`) without using a retry attempt. `applyReaction` lives in `reactions.ts` (no import cycle).
- 2026-10-23: **Batch 1 done** (T10.1–T10.4 + `[P10-B1-DONE]`). `npm run dev:inbox` on the dev DB: a fake number, 10 customer messages over the HTTP webhook (every main type, STOP / START), 6 replies (text, image, browser voice note, buttons, list, reaction) → all read via the fake's auto statuses, media downloaded, the voice note a valid mono OGG / Opus; the worker also backfilled the deferred events earlier dev runs had stored. Real bug found by it and fixed with a regression test (`3833db4`): keywords now apply in message-time order (a START processed before an earlier STOP no longer leaves the customer opted out). Backend 2678 tests, coverage 97.14 / 89.64 / 96.73 / 98.28.
- 2026-10-23: T10.5 notes — `GET /inbox/messages/:id/media` answers `{ url, mimeType, fileName, expiresInSec }` (a signed storage link) instead of redirecting, so the browser decides inline / download. `/account/inbox-settings` is mounted only where WhatsApp is enabled. Public contacts get a small `whatsapp` view (profile name, last inbound, blocked) for the contact page. The inbox router needs the app's file storage (503 `PROVIDER_UNAVAILABLE` without it).
- 2026-10-23: **Batch 2 done** (T10.5–T10.6 + `[P10-B2-DONE]`). Manual check on a locally started server through the HTTP API (dev DB, fake Meta, auto statuses on): 16 simulated customer types → all stored, every media `ready`; 11 replies (text with a link, image, browser voice note, document, location, buttons, list, CTA, reaction, quoted reply, note) → 201, every send `read`, the voice note a valid mono OGG; a media link downloads; after `window_expired` a send answers 409 `WHATSAPP_WINDOW_CLOSED` and a note 201; `band karo` → opted out + DND + confirmation; block / unblock and a profile edit 200; `age_messages` + `run_retention` empty the chat; the server log has no texts, numbers, names, file names, wamids, media URLs or tokens. Found while building: the simulator's ageing needed `updatePipeline` (Mongoose 9) and a wrong-secret simulation of `inbound_text` was signed with the right secret — both fixed before commit. Backend 2711 tests, coverage 97.08 / 89.56 / 96.61 / 98.20.
- 2026-10-23: T10.7–T10.10 notes — the menu item is `ForumOutlined` with badge key `inbox-unread`; tick labels Queued / Sent / Delivered / Read / Failed; the Inbox simulator kinds live in their own frontend list (the Numbers drawer keeps the 16 Phase 9 test events); the business profile hooks live in `features/whatsapp/profile.ts`; the menu badge is a lazy chunk so the inbox client stays out of the main bundle; the composer tools sit on their own row above the text box.
- 2026-10-23: **Batch 3 done** (T10.7–T10.12 + `[P10-B3-DONE]`). Playwright 26 inbox tests in 5 specs, 103 in total, green twice; the second run's backend log free of customer data and secrets. Found by the E2E run and fixed with regression tests: send / retry responses without the quote and sender (backend `2cae0a2`); the message box squeezed to zero width on a narrow three-pane chat; React strict mode starting the voice recorder twice; the contact panel not refreshing on opt-out (frontend `588a4b0`, `c47524a`, `3d4cb72`). Bundle: start-up code +2.7 KB gzip as one stream, +8.4 KB counted per file (the bundler splits it into 42 files instead of 18) — recorded as a deviation. Sign-off: [PHASE_10_SIGNOFF.md](PHASE_10_SIGNOFF.md).
