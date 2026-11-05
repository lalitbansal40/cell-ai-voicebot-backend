# Cell24x7 Voice API — recorded-voice / IVR campaigns (VAPI)

Recorded-voice campaigns play one audio file (or a Cell24x7 IVR menu) to every number
through Cell24x7's GSM gateway (about 4 calls at a time). No AI conversation runs on
this line; AI calls stay on the SIP trunk / WhatsApp. Source: Cell24x7 Voice API PDF
(5 Nov 2026). Plan: [VOICE_API_CELL24X7_PLAN.md](../plans/VOICE_API_CELL24X7_PLAN.md).

## Provider facts used

| Endpoint                                 | Use                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /submit` (multipart)               | One batch: `broadcast_name = cav-<campaignId>-<no>`, `caller_id`, `csv_file` (10-digit numbers), `audio_file` / `audio_file_id` / `ivr_id`, `retries`, `retry_interval` |
| `GET /details?request_id&page&limit=100` | Per-number status (the truth; polled)                                                                                                                                   |
| `POST /webhook`, `GET /webhook`          | Result webhook (registered from Admin → System)                                                                                                                         |
| `GET /ivrs`                              | IVR menus (superadmin assigns runnable ones per account)                                                                                                                |

The PDF does not name every `/details` / `/ivrs` field; the client reads them leniently
(`receiver`/`number`/`mobile`, `duration`/`call_duration`, `retry_count`, `dtmf_pressed`).
Confirm on the first live check.

Status map: `PP1` / `CALLING` / `Submitted` → dialing; `ANSWERED` → completed (answered);
`NO ANSWER` / `BUSY` / `FAILED` → not reached; `STOP` → canceled. A later `ANSWERED`
(a provider redial) upgrades a not-reached number once; repeats never move counters.

## Flow

1. Superadmin turns recorded voice on for the account (Admin → account → Recorded voice),
   assigns IVR menus and sets `Recorded voice (₹ per 15 s per number)` in the rate card.
   A price of 0 means "not priced": campaigns can be drafted but not started.
2. Campaigns → New campaign → SIP / Normal call → "Recorded voice or IVR". Audio comes
   from the account's own audio library (WAV / MP3, ≤ 120 s). Contacts that are not
   10-digit Indian mobiles are skipped (`not_indian_mobile`); DND / opt-out as usual.
3. The batch job (`voice.batch`, one per campaign under a Redis lock) claims
   `VOICE_API_BATCH_SIZE` numbers, **holds** the wallet (numbers × pulses × price), submits,
   then **captures**. The next batch waits until under 20 % of the open batches are still
   dialing, and only inside the effective calling window (TRAI 09:00–21:00 included,
   redials must fit before the window ends).
4. Results arrive by `POST /api/v1/webhooks/voice-api/<CELL24X7_WEBHOOK_SECRET>` (queued as
   `voice.result`) and by `voice.poll` every `VOICE_API_POLL_SEC`. Each final number gets a
   `calls` row (`provider: voice_api`) for contact history and reports.

## Failure handling

| Case                                                 | Result                                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 400                                                  | Batch `failed`, hold released, numbers back to pending, campaign paused `provider_error`                                           |
| 401 / 402                                            | Same, and **every** running voice campaign pauses; superadmin bell (once/hour)                                                     |
| 404 on a cached audio id                             | Cache cleared, sent once more with the file                                                                                        |
| Timeout / 5xx / unreadable 2xx / crash while sending | Batch `uncertain`, hold kept, campaign paused `provider_uncertain`; **never resent automatically**                                 |
| Uncertain batch                                      | Admin → System → Resolve: "It was sent" (request id → results follow, hold captured) or "It was not sent" (money and numbers back) |
| Stop / cancel                                        | No new batch; numbers already sent keep ringing (Cell24x7 has no stop API)                                                         |

## Security

- Token only in the server env (`CELL24X7_VOICE_API_TOKEN`); never logged, never returned.
- The webhook has no signature: the secret path is the only credential and polling
  re-checks every result; unknown request ids are ignored; 600 requests/min per IP.
- One platform token serves every account: customers never see the provider's audio or
  IVR lists — only their own audio and IVRs a superadmin assigned.
- Numbers (10 digits) and the audio file are sent to Cell24x7 (processor). See DATA_MAP.

## Going live (owner approval and a test number required)

1. Server env: `VOICE_API_PROVIDER=cell24x7`, `CELL24X7_VOICE_API_TOKEN`,
   `CELL24X7_WEBHOOK_SECRET` (32+ random chars), optional caller ID / batch size; restart.
2. Admin → System → Recorded voice → **Register webhook** (must show "registered").
3. Enable the test account, set its price, upload a 10 s audio, run a 1-number campaign to
   the owner's phone; check the webhook result, `/details` result and the wallet ledger.
4. Rollback: `VOICE_API_PROVIDER=off` (feature hidden; nothing else changes).
