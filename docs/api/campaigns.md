# Campaigns

Four kinds, two APIs:

| Kind                   | API                                        | What runs                                                                                        |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| SIP / normal calls     | `POST /campaigns` with `line: "phone"`     | a published flow or AI agent on the phone line (`mode: live`) or the test line (`mode: dry_run`) |
| WhatsApp calls         | `POST /campaigns` with `line: "whatsapp"`  | a flow or agent over WhatsApp calls, only to people who allowed calls                            |
| Recorded voice / IVR   | `POST /campaigns` with `line: "voice_api"` | one audio file or IVR menu played by the provider                                                |
| WhatsApp bulk messages | `POST /whatsapp-campaigns`                 | approved templates only                                                                          |

## Call campaigns

Lifecycle: **create** (draft) → **estimate** (`POST /campaigns/{id}/estimate`) → **start** (`Idempotency-Key`) → `pause` / `resume` / `cancel` → results in `GET /campaigns/{id}/contacts`, exports, and the `campaign.completed` webhook.

```bash
curl -X POST https://wa.notifynow.in/api/v1/campaigns \
  -H "X-API-Key: $NOTIFYNOW_KEY" -H "Content-Type: application/json" \
  -d '{"name":"November EMI calls","mode":"live","line":"phone","flowId":"6720f0a1b2c3d4e5f6a7b8c9","audience":{"listIds":["6720f0a1b2c3d4e5f6a7b8ca"]},"window":{"start":"10:00","end":"19:00","days":[1,2,3,4,5,6]}}'

curl -X POST https://wa.notifynow.in/api/v1/campaigns/6720f0a1b2c3d4e5f6a7b8cc/start \
  -H "X-API-Key: $NOTIFYNOW_KEY" -H "Idempotency-Key: nov-emi-start"
```

- **Audience:** `listIds`, `segmentId`, a contact `filter` or `contactIds`. At start the audience is snapshotted: DND, opted-out, invalid and duplicate numbers (and contacts in other active campaigns, unless turned off) are skipped with a reason.
- **Window & retries:** calls only inside the window (09:00–21:00 at most); `retry` redials no-answer / busy / failed.
- **Schedule:** `schedule.startAt` for later, `schedule.recurrence` for daily / weekly runs (`GET /campaigns/{id}/runs`).

### Recorded voice (`line: "voice_api"`)

```json
{
  "name": "Payment reminder (voice)",
  "line": "voice_api",
  "voiceApi": {
    "content": { "kind": "audio", "flowAudioId": "6720f0a1b2c3d4e5f6a7b8cd" },
    "retries": 1,
    "retryIntervalMin": 30
  },
  "audience": { "listIds": ["6720f0a1b2c3d4e5f6a7b8ca"] }
}
```

- Content: your own audio (WAV / MP3 ≤ 120 s, uploaded in the dashboard) or `{ "kind": "ivr", "ivrId": … }` from `GET /resources/ivrs`.
- Only 10-digit Indian mobiles are called (others skipped `not_indian_mobile`). Always live; no dry run.
- Numbers go to the provider in **batches**; each number is charged per started 15 seconds **when its batch is sent**, answered or not. Redials (0–3) are done by the provider and must fit in the window.
- **Stop / cancel** holds back numbers not yet sent; numbers already sent keep ringing.
- Results: `voice` on each row of `GET /campaigns/{id}/contacts` (provider status, duration, key pressed) and one call per number (`provider: voice_api`).

## WhatsApp bulk campaigns

Scopes `whatsapp-campaigns:read` / `whatsapp-campaigns:write`.

```bash
curl -X POST https://wa.notifynow.in/api/v1/whatsapp-campaigns \
  -H "X-API-Key: $NOTIFYNOW_KEY" -H "Content-Type: application/json" \
  -d '{"name":"November EMI reminder","channelId":"6720f0a1b2c3d4e5f6a7b8d1","variants":[{"key":"A","templateId":"6720f0a1b2c3d4e5f6a7b8d2","splitPct":100}],"variables":{"1":{"kind":"contact.name"}},"audience":{"listIds":["6720f0a1b2c3d4e5f6a7b8ca"]}}'

curl -X POST https://wa.notifynow.in/api/v1/whatsapp-campaigns/6720f0a1b2c3d4e5f6a7b8c9/estimate -H "X-API-Key: $NOTIFYNOW_KEY"
curl -X POST https://wa.notifynow.in/api/v1/whatsapp-campaigns/6720f0a1b2c3d4e5f6a7b8c9/start \
  -H "X-API-Key: $NOTIFYNOW_KEY" -H "Idempotency-Key: nov-reminder-start"
```

- Approved templates only; up to 3 variants for an A/B split (optionally pick a winner by read / reply after N hours).
- Variables: `contact.name`, `contact.phone`, a contact `field` or `static` text.
- Speed: 75 / second (Cloud API number) or 18 / second (Business App / unconfirmed), within the number's daily tier.
- Each message is charged when WhatsApp bills it. Results: `GET /whatsapp-campaigns/{id}` counters, `/recipients`, `/report`, `/export`, and the `whatsapp_campaign.completed` / `whatsapp_campaign.paused` webhooks.
