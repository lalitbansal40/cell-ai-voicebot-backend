# 0038 — WhatsApp inbox: conversations, messages, statuses, media, window, voice notes, retention

- **Status:** accepted
- **Date:** 2026-10-23

## Context

Phase 10 turns the WhatsApp numbers of Phase 9 into a team inbox: customers send every message type Meta supports and agents answer with every free-form type, live, with delivery ticks. Meta only allows free-form replies within 24 hours of the customer's last message, redelivers webhooks, sends statuses out of order, and keeps webhook media for only 7 days. Owner decisions (23 Oct 2026): keep messages 90 days, no message text in notifications, Hinglish / Hindi opt-out keywords with a confirmation reply, read receipts on, and voice notes recorded in the browser. Everything must work on the fake Meta provider; the real app comes in Phase 13.

## Options considered

1. **Conversations + messages collections fed by the Phase 9 webhook pipeline (injected consumers), an outbound job per message, media copied into our storage, a pure TypeScript WebM → OGG remuxer.** Chosen.
2. **Store raw webhook payloads and render from them** — no normalisation, but every screen re-parses Meta's shapes, search and paging are slow, and the 7-day media expiry loses files.
3. **Send synchronously in the HTTP request** — simpler, but a slow or throttled Meta call blocks the agent and retries / ordering get lost.
4. **ffmpeg for voice notes** — robust codec handling, but a native binary in every image and CI runner, larger attack surface, and re-encoding is not needed (browsers already record Opus).

## Decision

- **Data:** `conversations` (one per number × customer: status, assignee, unread, last message, `windowExpiresAt`, blocked), `messages` (every type both ways + internal notes; every sub-document declared — Mongoose strict mode drops undeclared fields; `at` orders, pages and expires messages), `inboxUploads` (composer files; the id is the media token, consumed in the message's transaction). Contacts are matched by number or auto-created; a name a person gave is never replaced by WhatsApp profile or phone-book names.
- **Inbound:** the WhatsApp worker gets the inbox as injected hooks (no import cycle) — customer messages are deduped by wamid, the conversation is upserted atomically (`$max` window, unread, reopen), replies / reactions resolved, media downloaded by a job from allowlisted Meta hosts only (no redirects, byte cap, sniffed against Meta's type) within 7 days, live events sent (account events never carry text; the `conversation:<id>` topic carries the full view to `inbox.read` subscribers) and a throttled bell rung with the contact name only. Events stored as deferred before the deploy are backfilled once.
- **Statuses:** forward only (`queued → accepted → sent → delivered → read`), `failed` only below delivered, `played` = read, inbound `deleted`; Meta errors stored with our reason text; pricing kept for Phase 11; 368 restricts the number, 190 marks it for reconnect.
- **Outbound:** a send checks the number, block state and the 24-hour window (409 `WHATSAPP_WINDOW_CLOSED`), is idempotent by `clientId`, is stored `queued` and sent by `message.send`: only queued messages are sent (restart safe), order is kept per conversation, media is uploaded to Meta once (≤ 29 days reuse), the wamid is stored atomically, retryable errors back off, Meta's pair limit waits 60 s, the rest fail with a reason. Notes never leave the app.
- **Keywords:** whole-message, normalised (NFC, case, trailing punctuation / emoji) English + Hinglish + Hindi lists, applied in message-time order with an atomic update (a found race: `3833db4`); opt-out adds a WhatsApp DND entry, a system line, an audit entry and one confirmation per 24 h; opt-in removes only that entry.
- **Voice notes:** `MediaRecorder` in the browser; WebM / Opus is remuxed to mono OGG / Opus on the server by a bounded EBML reader and Ogg page writer (no re-encode, no ffmpeg); OGG passes through after checks; M4A goes out as an audio file. ffmpeg (`-c:a copy`) behind the same interface is the fallback if real recordings fail in Phase 13.
- **Retention:** the daily `inbox-retention` job deletes messages + files older than `INBOX_RETENTION_DAYS` (90; 0 = keep), recomputes list rows and removes unused uploads; history imports skip older messages.
- **Coexistence:** echoes become `business_app` messages (no window, no unread), history chunks are imported by their own job in per-thread batches (no unread / bells), phone contacts update contacts.
- **API + dev tools:** `/api/v1/inbox` with `inbox.read` / `inbox.reply` / `inbox.assign` (agents assign themselves), impersonators read only, rate limits per user; business profile and inbox settings endpoints; the fake Meta sends auto statuses through the real receiver, has recipient knobs and signed media URLs; the simulator has 44 kinds through the real pipeline.

## Consequences

- The inbox never depends on Meta being fast: webhooks are stored first, sends and downloads are jobs, and every step is idempotent.
- Customer data stays in Mongo / storage: logs, audit meta, job data, notifications and account WS events carry ids and counts only (tested by capturing logs of full runs).
- Phase 11 adds templates (window bypass for approved templates, opted-out marketing block) and bills from the stored pricing; Phase 12 reuses interactive messages for the call-permission request; Phase 13 runs the real-number checklist (setup guide §13); Phase 16 deletes conversations + media with the account.
- The voice remuxer is our own parser of untrusted input: it is bounded and fuzz-style tested; real-device recordings must be checked in Phase 13.
