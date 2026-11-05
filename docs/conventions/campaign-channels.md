# Campaign channels and calling

Phase 19 continuation, 5 November 2026. Final validation is tracked in the Phase 19 sign-off.

Campaigns have three tabs, retained in the URL: SIP / Normal call (`line=phone`),
WhatsApp message (`line=whatsapp`), and WhatsApp call (`line=whatsapp-call`). The first
and third use the existing call-campaign engine; WhatsApp messages use the existing
message-campaign engine. Old phone URLs and payloads remain supported.

## Sending WhatsApp messages

Select a connected WhatsApp sender, approved templates, A/B split, variable sources,
audience and schedule. Lists, segments, tags, completed imports and explicit selections
are supported. Explicit selection shows its actual count; it does not imply every
matching contact. The estimate applies the same exclusions and variant assignment as
execution, prices category and market separately, and displays wallet shortfall.

Campaign/template lifecycle checks run before pacing, and repeat after a short wait. No DB work follows the final slot acquisition before the provider call. The shared Redis pacer applies immediately before provider attempts: Business App or
coexistence numbers use at most 18 messages/second; a confirmed regular Cloud API
number uses at most 75. `messageClassificationKnown` is set by Meta phone read-back,
including an explicit `is_on_biz_app` boolean. Missing legacy/read-back classification
uses 18 until refreshed. `WA_CAMPAIGN_MPS` is optional and only lowers that cap.
`WA_CAMPAIGN_MAX_RECIPIENTS` defaults to 100000. The cap is per account and sender,
shared across campaigns, permission requests, inbox messages, workers and retries.
Inbox jobs have priority 1; bulk jobs priority 10. Redis failures defer attempts.
Daily unique-recipient tiers, provider throttles, wallet and channel restrictions
still apply; the application cap does not promise provider throughput.

Uploads used by campaigns get durable account-owned media copies; each outgoing
message gets its own storage/upload copy. Template example media is explicitly
available through the existing send path, which also copies it per message. Headers
must match every selected variant. Location headers accept coordinates. Uploads are
sniffed, owned, unexpired, and bounded by template image/video/document limits.

Recurring runs snapshot fresh eligible contacts when due. A unique root/occurrence
index prevents duplicate runs. Pausing a scheduled run preserves its start time;
pausing a recurring root prevents new occurrences while paused. Stopping any run
disables the series and stops its active/scheduled children. Dispatch completion
waits for provider acceptance; late delivery/reply events continue to refresh reports.
Recipient status changes and their counter increments commit in one MongoDB transaction; concurrent/late statuses and replies cannot leave counters half-written. Replacing or deleting durable media releases it only after its final campaign reference is gone. Captured charges are matched against both message and stable client-ID ledger references.

## WhatsApp calls

Choose a ready calling number and a published flow or active AI agent. Incoming AI
settings persist the selected per-number program; outgoing single calls and campaigns
use the existing WhatsApp call session, media, handoff, recording and settlement paths.
Business App/coexistence messaging availability does not imply calling availability.
Live providers recheck readiness, country/restrictions, wallet and concurrency.

Call campaigns keep `flowId=null` for agent programs. Published flow versions are pinned
using existing campaign semantics. Agent status and ownership are rechecked before
execution. Snapshot and dial both check consent for the selected number/contact pair.
Optional ask-first uses an approved permission template and the bulk permission service;
grants wake existing active audience rows once. Revocation/expiry prevents dialing,
late grants cannot revive a stopped campaign, and two unanswered attempts prevent further
campaign attempts. Dry-run calls remain unbilled.

Contact main/row actions and Calls use the shared method/sender chooser. Inbox has the
same chooser under Call options alongside its context-specific WhatsApp shortcut.
One eligible sender is preselected; multiple require a choice. Normal calls carry the
selected caller ID; stale SIP readiness is rejected, without transport fallback.
WhatsApp readiness, permission and selling-price previews are keyed by sender/contact and reset on switches. AI confirmation waits for the selected pair’s quote; quote errors offer retry. The quote includes the sender’s payer setting, the contact’s market and account AI rate without exposing Meta costs or margins.
View-only and impersonated sessions cannot trigger calls; ordinary campaign editing
continues to follow the existing view/act guards.

## Templates

The template area always shows a WhatsApp number selector and stores it in the URL/query
key. All-numbers view requires a concrete sender for create, edit, sync and approval.
An open builder captures its sender so later navigation cannot retarget approval.
Templates remain shared at WABA level. List/detail availability derives all connected
same-WABA numbers; create/edit/submit/media operations enforce owned same-WABA senders.
Inbox, Contact and campaign send paths retain backend account/WABA checks.

## Validation and release

Use fake Meta/SIP/payment/AI providers in local tests. `npm run perf:wa-campaign` uses
only the throw-away `cav_perf` database, Redis database 9 and its own server. It checks
two campaigns per sender, two independent 18/75 senders, 1000 recipients each, rolling
attempt timestamps, paused hard-restart recovery, unique client/provider IDs and
counter/ledger agreement. Controlled-clock limiter tests separately prove caps with
concurrent workers, retries, downgrades and Redis failure.

Migrations 0023 (recurring runs/send-count marker) and 0024 (call campaign transport)
are additive. Refresh connected number metadata after migration for classification.
Apply migrations before workers; preserve Redis queued jobs/budgets on restart.
Live Meta devices, SIP carrier checks and deployment remain separate checks requiring
the owner's test numbers/server. No push, merge or deployment is implied by local tests.

## Recorded voice (Cell24x7, VAPI)

The SIP / Normal call type has two ways to call: **AI flow or agent** (SIP trunk or the
test line) and **Recorded voice or IVR** (`line: 'voice_api'`, Cell24x7). Recorded-voice
campaigns use the call-campaign engine but never the dialer: a batch job submits numbers
to Cell24x7 and results come back by webhook and polling. They are always live (no dry
run), call 10-digit Indian mobiles only, and charge per number per started 15 s when each
batch is sent. WhatsApp bulk campaigns send approved templates only. Details:
[cell24x7-voice.md](../integrations/cell24x7-voice.md).
