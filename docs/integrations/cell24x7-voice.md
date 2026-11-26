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

Cell24x7 account logins need no voice environment changes. Non-secret defaults ship in
`src/config/voice-api.ts` (provider URL, caller ID fallback, batch size, gateway lines and
poll interval). After deployment, Admin → Accounts → account → **SIP trunk → Cell24x7 API
key** checks and encrypts the key, registers an automatically generated account webhook,
then enables recorded voice. Campaign queues start even without a shared platform login.

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

- Account tokens are entered in the dashboard and encrypted in MongoDB; never logged or
  returned. The optional shared platform login still accepts `CELL24X7_VOICE_API_TOKEN`.
- The webhook has no signature: the secret path is the only credential and polling
  re-checks every result; unknown request ids are ignored; 600 requests/min per IP.
- Platform-token accounts see their own audio and assigned IVRs. Own-token accounts see
  only the runnable IVRs belonging to their own Cell24x7 login.
- Numbers (10 digits) and the audio file are sent to Cell24x7 (processor). See DATA_MAP.

## One Cell24x7 login per account

Every account can use **its own Cell24x7 token without any voice env setup** — its own
credits, audios, IVRs, caller ID and webhook. An existing shared **platform token** remains
optional (env `CELL24X7_VOICE_API_TOKEN`). With no shared login, an account must connect its
own key before running campaigns. The provider allows one webhook URL per token.

Superadmin, **Admin → Accounts → account → Recorded voice → Cell24x7 login**:

1. Choose **Account's own token**, paste the token from that account's Cell24x7 dashboard (_Settings → API_), and the 10-digit caller ID Cell24x7 gave it (empty = `CELL24X7_VOICE_CALLER_ID`). Save: the token is checked with Cell24x7 first (`GET /ivrs`), then sealed (only the last 4 characters are ever shown; `keys:reseal` covers it).
2. **Register webhook**: points that token's webhook at `/api/v1/webhooks/voice-api/a/<account>/<secret>` (a new secret each time; only its hash is stored). Changing the token clears the webhook — register again.
3. IVRs: an own-token account sees every runnable IVR of its Cell24x7 login (no superadmin assignment). Audio uploads are cached per login.

What changes for an own-token account:

| Topic                   | Platform token                                      | Own token                                                    |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| Cell24x7 credits        | platform's                                          | the account's own                                            |
| Wallet charge           | rate card `voiceApiPulseMicros`                     | same (set 0 on the account's rate card for no markup)        |
| Caller ID               | `CELL24X7_VOICE_CALLER_ID`                          | the account's, else the env one                              |
| 401 / 402 from Cell24x7 | all platform-token campaigns pause, superadmin bell | only this account's campaigns pause, its owners get the bell |
| Results                 | platform webhook + polling                          | the account's webhook + polling with its token               |

Back to **Platform token** removes the account's token. Audit: `voice_api.credentials_changed`, `voice_api.account_webhook_registered`.

## Checks from the panel (IVR, superadmin only — no server access needed)

Admin → Accounts → account → **Recorded voice (Cell24x7)**:

- **Test connection** (`POST /admin/accounts/:id/voice-api/test-connection`) — calls `GET /ivrs` with the
  account's key (or the platform key) from our server. Saved on the account as `voiceApi.lastCheck`
  (`ok`, `reason`: `ok` / `auth` / `no_credits` / `timeout` / `dns` / `tls` / `refused` / `network` /
  `error`, HTTP status, IVR count). Audit `voice_api.connection_tested`. The token is never shown.
- **Send test call** (`POST …/voice-api/test-call`) — one number (a 10-digit Indian mobile), the
  account's audio or an IVR id. The **owner OK** box is required (the call really rings a phone).
  At most 3 an hour per account. It is a direct provider submit: **not charged to the wallet** and
  no campaign row (the cost shows only in the Cell24x7 panel). Audit `voice_api.test_call_sent`.
  **Refresh result** (`GET …/voice-api/test-call`) reads `/details` for that broadcast.
- **Last provider answer** (`GET …/voice-api/diagnostics`) — the field names and up to 3 masked sample
  rows of the last `/details` page, poll and webhook (Redis, 7 days; phone numbers as the last 4
  digits). Used to confirm the parser on the first live call because the PDF does not name every field.
  The same answer lists unknown provider statuses (also a bell `voice_api.provider_error`, once a
  day per status) and `noCredits24h` — how many 402 answers came back in 24 h.

## IVR key-press report

For IVR campaigns the campaign view has `voiceApi.ivrDigits` (`{ "1": 12, "2": 4, "none": 30 }`,
final numbers only). The results list filters with `?digit=1` (`none` = no key pressed) and the CSV
export has a **Key pressed** column. `call.completed` webhooks of recorded-voice calls carry
`voiceApi: { status, keyPressed, ivrDisposition }`.

## Audio by API key

`GET /api/v1/flow-audio` (scopes `campaigns:read` or `campaigns:write`) and `POST /api/v1/flow-audio`
(multipart `file`, scope `campaigns:write`) — upload a recorded-voice file and use its id as
`flowAudioId` in a campaign. Rename / delete / signed URL stay in the panel.

## Health

Admin → System → **Recorded voice** and two healthwatch rules (bell + incident row in
[incidents.md](../ops/incidents.md)):

- `voice-api-unreachable` — an account's last Test connection / poll in the last hour got no answer;
- `voice-api-uncertain` — an uncertain batch not resolved for 30 min (resolve it on the account).

## Incoming calls

**Not available on Cell24x7.** The partner API only places outgoing broadcasts (recorded voice / IVR);
there is no incoming-call or number-routing endpoint. Incoming calls come in on the phone line (SIP)
or WhatsApp. The Cell24x7 card and the campaign wizard say so. No code path exists for it.

## Not built

- `/report` reconciliation (IVR-T5): the provider PDF does not name a `/report` endpoint.
- Credits balance (IVR-T6): no balance endpoint; only the 402 count above.

## "This server cannot reach Cell24x7"

The key check calls `GET /ivrs` from **our server**. When nothing comes back (firewall, DNS, TLS, timeout) the key is still saved as _not checked_ and the card shows why. Fix on the server, then press **Save and connect** again (no new key needed):

```bash
# on the app server (not your laptop)
curl -sv -m 15 https://voice.truebeeps.com/api/v1/voice/partner/ivrs -o /dev/null
```

`HTTP 401` = reachable (good). A timeout or "connection refused" = outgoing HTTPS (443) to `voice.truebeeps.com` is blocked by the server / hosting firewall — the client's server admin must allow it.

## Going live (owner approval and a test number required)

1. Deploy API and workers. No new Cell24x7 env variables are required for account logins.
2. Admin → Accounts → account → SIP trunk → **Cell24x7 API key → Save and connect**.
   The provider must accept the key and webhook URL; the app uses its existing `APP_URL`.
3. Set the test account's price, upload a 10 s audio, run a 1-number campaign to
   the owner's phone; check the webhook result, `/details` result and the wallet ledger.
4. Turn an account off with its Recorded voice switch. `VOICE_API_PROVIDER=off` disables
   only the optional shared platform login; own account keys remain available. To disable
   the integration in code, set `VOICE_API_CONFIG.enabled` to `false` and redeploy.

For the optional shared platform login, keep the existing `VOICE_API_PROVIDER=cell24x7`,
`CELL24X7_VOICE_API_TOKEN` and `CELL24X7_WEBHOOK_SECRET` configuration and register its
webhook in Admin → System. Do not put API keys or webhook secrets in the constants file.
