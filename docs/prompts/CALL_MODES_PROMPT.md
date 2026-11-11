# CALL MODES RUN — AI or a person, on every call (WhatsApp + normal) — Autonomous Run Prompt

> **HOW TO RUN (ise paste karo):**
> `cell-ai-voicebot-backend/docs/prompts/CALL_MODES_PROMPT.md poora padho aur CM-T1 se CM-T9 tak SAARE tasks step by step autonomously implement karo. Bich me question mat poocho — decisions D1–D20 locked hain; routine choice existing conventions se lo aur report me likho. Har task ke baad sirf us task ke tests + lint/typecheck, phir commit (tag [CM-Tn]). Full suites sirf CM-T9 me ek-ek baar (serial). Push / merge / deploy / client sync tabhi jab owner chat me bole. Ant me [CM-DONE] commit + short Hinglish report.`
>
> Working directory: `/Users/lalitbansal/Documents/cell-ai-voicebot`.

---

## 0. Goal

1. **Incoming WhatsApp calls:** an account can let the AI pick up **every** call (already possible) and gets the same choices as phone numbers: AI · Team · AI → team · **Team → AI (new)**. No incoming call is ever dropped silently.
2. **Outgoing, single and bulk, on both lines (normal / SIP and WhatsApp):** the user chooses **who talks** — **AI** (flow / agent) or **a person** (themselves / the team). Single calls already have this; **bulk campaigns get it now** (team calling campaigns).
3. Related fixes so the normal call line shows its real state.

## 1. Verified facts (do not re-derive)

| Area                             | Today                                                                                                                                                                | Where                                                                                                                                                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WhatsApp incoming routes         | `INBOUND_ROUTES = ['team','ai','ai_then_team']`; AI program per number                                                                                               | `backend src/db/models/whatsapp-channel.model.ts`, `modules/whatsapp-calling/calls.service.ts` `startInbound` (~L1083), `ringTeam`, `transferToTeam`, `onEnded`; UI `frontend src/features/whatsapp-calling/settings/CallingSection.tsx` (`ROUTE_LABELS`, `ProgramPicker`) |
| WhatsApp incoming, capacity full | `startInbound` returns early when `capacity().active >= max`; `bus.claimInbound` refuses with no capacity → **nobody claims, the customer just rings** (bug)         | `calls.service.ts` startInbound, `whatsapp-calling/bus.ts` `claimInbound`                                                                                                                                                                                                  |
| SIP incoming routes              | `ai`, `team`, `ai_then_team`, `team_then_ai` (Phase 20)                                                                                                              | `modules/calls/inbound/*`, `phone-numbers` inbound settings                                                                                                                                                                                                                |
| Single outgoing                  | SIP: flow / agent / **Call yourself** (`mode:'human'`, `CallManager.startSipCall` + `humanSip` + `BridgeScript`); WhatsApp: AI or human (`startOutbound` mode)       | `modules/campaigns/single-call.ts`, `modules/calls/call.service.ts`, frontend `features/calls/CallMethodDialog.tsx`, `CallNowDialog.tsx`, `whatsapp-calling/live/controller.ts` (`placeCall`, `placePhoneCall`, `answerCall`)                                              |
| Bulk call campaigns              | `line: 'phone' \| 'whatsapp' \| 'voice_api'`; program = flow / agent only — **no person mode**                                                                       | `db/models/campaign.model.ts`, `modules/campaigns/{dispatcher,whatsapp-line,snapshot,results,estimate}.ts`, wizard `frontend src/features/campaigns/wizard/*`                                                                                                              |
| Person audio in the browser      | `/ws/media` + media ticket; `CallBar`, `IncomingPopup`, live store                                                                                                   | `frontend features/whatsapp-calling/live/*`, backend `calls/media-tickets.ts`, `CallManager.attach`                                                                                                                                                                        |
| Presence / availability          | `onlineUsers(redis, accountId)`, `users.callAvailability`, `calls.answer` permission                                                                                 | `core/realtime/presence.ts`, `whatsapp-calling/routing.ts` `selectRingTargets`                                                                                                                                                                                             |
| Normal-line status               | Admin "Phone line" card says "Live" from `account.voiceLine` only (ignores `TELEPHONY_PROVIDER`); SIP trunk card shows the form even when the server has no SIP line | `frontend features/admin/PhoneLineCard.tsx`, `SipTrunkCard.tsx`; backend `modules/calls/line.ts` `effectiveLine`, `sip-trunks.service.ts` `sipTrunkView`                                                                                                                   |

## 2. Locked decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | WhatsApp `INBOUND_ROUTES` + `'team_then_ai'`: ring the team (`ringTeam`), nobody in time / nobody online → the number's AI program takes the call (same session, like SIP `TeamScript` fallback). Needs `aiProgram`. Ring time stays capped by Meta (`WHATSAPP_CALL_LIMITS.uicRingTimeoutSec`).                                                                                                                                                                                                                                                     |
| D2  | "AI picks up every call" = route `ai`. Settings copy: **"AI answers every call"** with the program picker; readiness lists a missing / unpublished program.                                                                                                                                                                                                                                                                                                                                                                                         |
| D3  | Capacity full on every node (WhatsApp incoming): never leave the customer ringing. Each node that sees an offer it cannot take sets `call:wa:full:<waCallId>` (NX, 30 s) ; a node without capacity that wins `call:wa:reject:<waCallId>` (NX) after **3 s** with no claim → `rejectCall` to Meta + call doc `outcome missed`, `endReason: 'line_busy'` (new reason reuse from Phase 20), bell `call.whatsapp_missed`, webhook `whatsapp.call.missed`.                                                                                               |
| D4  | Campaign field **`talkMode: 'ai' \| 'team'`** (default `'ai'`) for `line: 'phone'` and `line: 'whatsapp'` only (`voice_api` and WhatsApp bulk messages stay as they are). `team` → `program: null`, `flowId: null`.                                                                                                                                                                                                                                                                                                                                 |
| D5  | Team campaign = **progressive agent sessions** (no over-dialling, no abandoned calls): an agent **joins the campaign's calling session** in the browser (microphone first); the dispatcher dials **one contact per free joined agent**; the call is a human call owned by that agent (`mode:'human'`, `agentUserId`), audio over the existing human paths (SIP `humanSip` + `BridgeScript`; WhatsApp human outbound).                                                                                                                               |
| D6  | Campaign `team.agentUserIds: ObjectId[] \| null` (null = every member with `calls.trigger`), `team.wrapUpSec` (0–120, default 15). Only listed, active, non-viewer members may join.                                                                                                                                                                                                                                                                                                                                                                |
| D7  | Session state in Redis: `campaign:<id>:agents` hash `userId → { state: 'ready'\|'on_call'\|'wrap_up'\|'paused', since, callId }`, heartbeat 10 s (TTL 30 s, via the agent's realtime socket); a lost heartbeat = left (no new dials; a live call continues).                                                                                                                                                                                                                                                                                        |
| D8  | Dial handoff: dispatcher reserves a `ready` agent atomically (Lua: ready → on_call), starts the call with `initiatedBy = agent`, then pushes `campaign.call_assigned { campaignId, callId, contact: { id, name }, mediaTicket, wsPath, expiresAt }` to that agent only (`notifyUser`). The browser auto-connects (`connectLeg`) and the SIP leg dials once the agent socket is ready (existing human SIP rule). No socket in `readyTimeoutSec` → call canceled `no_agent_available`, contact back to `pending` (no attempt used), agent → `paused`. |
| D9  | After the call: agent → `wrap_up` for `wrapUpSec`, sees the contact + an outcome picker (account dispositions) + note; Save / timer → `ready`. Outcome saved on the call (`disposition`, `dispositionSource: 'agent'`) and campaign contact like AI results.                                                                                                                                                                                                                                                                                        |
| D10 | Billing: telephony only (no AI minutes) — same as single human calls (`CallBilling(…, ai=false)`; WhatsApp human pricing as today). Estimate shows "no AI minutes".                                                                                                                                                                                                                                                                                                                                                                                 |
| D11 | Compliance unchanged: calling window, DND / opt-out, per-contact caps, retries, WhatsApp call permission (team WhatsApp campaigns need the same permission as AI ones).                                                                                                                                                                                                                                                                                                                                                                             |
| D12 | Concurrency: team campaigns ignore the AI group slot limit; the account `maxConcurrentCalls` still applies; dials = number of `ready` agents.                                                                                                                                                                                                                                                                                                                                                                                                       |
| D13 | Status: a running team campaign with no joined agent shows **"Waiting for agents"** (no error, no pause). Owner can still pause / stop; stop ends no live call.                                                                                                                                                                                                                                                                                                                                                                                     |
| D14 | Single calls stay as they are (AI or "Call yourself") — verify both lines show both options in every entry point (Contacts, Calls, Inbox); fix any place that hides one.                                                                                                                                                                                                                                                                                                                                                                            |
| D15 | Permissions: create team campaign = `campaigns.write`; join session = `calls.trigger`; supervisors (`campaigns.read` + `calls.listen`) see the live agent board. No new permission.                                                                                                                                                                                                                                                                                                                                                                 |
| D16 | Public API: `talkMode`, `team.agentUserIds`, `team.wrapUpSec` on `POST /campaigns`; agent sessions are dashboard-only. `PUBLIC_DOCS` overlay + `docs:audit` 0 problems.                                                                                                                                                                                                                                                                                                                                                                             |
| D17 | Reports: per-agent rows on the campaign detail and calls report (calls, connected, talk time, outcomes); calls export column "Talked by" (`AI` / member name).                                                                                                                                                                                                                                                                                                                                                                                      |
| D18 | Normal-line fixes: `GET /admin/accounts/:id` adds `phoneLine: { server: 'sip'\|'dryrun', connected: boolean }`; Phone line card shows "Live" only when server SIP is on **and** the account is on SIP, else an explicit warning; SIP trunk card shows "This server has no phone line yet" **before** the form and disables Save.                                                                                                                                                                                                                    |
| D19 | Errors: `CAMPAIGN_NO_AGENTS` (409, start allowed but explained in UI only — do not throw on start), `AGENT_NOT_IN_CAMPAIGN` (403), `AGENT_SESSION_GONE` (409). `error-codes.ts` + docs. Audit: `campaign.agent_joined`, `campaign.agent_left`. Notification: none new. WS events: `campaign.call_assigned`, `campaign.session`.                                                                                                                                                                                                                     |
| D20 | Tests: only §5 files + existing tests this breaks; never weaken assertions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 3. Tasks

### CM-T1 — Model + migration

- `campaign.model.ts`: `talkMode`, `team { agentUserIds, wrapUpSec }`; validation (team ⇒ no program; ai ⇒ program required as today; `line ∈ {phone, whatsapp}` for team).
- `campaign-contact.model.ts`: `agentUserId` on the attempt; `call.model.ts` `dispositionSource` + `'agent'`.
- `whatsapp-channel.model.ts`: route `team_then_ai`.
- Migration `0027-call-modes` (defaults `talkMode:'ai'`, `team:null`). Commit `feat(campaigns): add who-talks mode to call campaigns [CM-T1]`.

### CM-T2 — WhatsApp incoming fixes

- `team_then_ai` (D1) in `startInbound` / ring flow / `onEnded` (not missed when the AI took it).
- Capacity-full rejection (D3).
- Settings schema + UI copy (D2). Commit `fix(whatsapp-calling): team-then-AI route and no silent drops [CM-T2]`.

### CM-T3 — Agent sessions (backend)

- `modules/campaigns/team/session.ts`: join / leave / pause / ready / heartbeat (D7), Lua reserve (D8), wrap-up timer (D9).
- Routes `POST /campaigns/:id/session/{join,leave,pause,ready}`, `POST /campaigns/:id/calls/:callId/wrap-up {disposition, note}`, `GET /campaigns/:id/session` (board). Audit (D19). Commit `[CM-T3]`.

### CM-T4 — Team dialing (SIP + WhatsApp)

- `dispatcher.ts` / `whatsapp-line.ts`: when `talkMode === 'team'`, dial count = ready agents (D12), human call via `CallManager.startOutboundCall({ mode:'human', initiatedBy: agent })` / WhatsApp `startOutbound(mode:'human')`; push `campaign.call_assigned` (D8); timeouts + requeue; results and retries like AI calls. Commit `[CM-T4]`.

### CM-T5 — Wrap-up, outcomes, billing

- Outcome on call + contact (D9), billing without AI (D10), estimate text. Commit `[CM-T5]`.

### CM-T6 — API + docs

- Campaign create / update / view fields, session routes in OpenAPI (dashboard tags), `PUBLIC_DOCS` text for `talkMode`, `gen:openapi`, `gen:postman`, `gen:guides`, error codes, `docs/api/campaigns.md` "Team calling". Commit `[CM-T6]`.

### CM-T7 — Frontend

- Wizard Basics: **"Who talks?"** — _AI (flow / agent)_ | _My team (agents in the browser)_ for SIP / Normal and WhatsApp call; team → agent picker (`teamApi.list`) + wrap-up seconds; review shows "No AI minutes".
- Campaign detail: **"Join calling session"** (mic check) → agent panel: state chip, current contact card, auto-connected `CallBar`, wrap-up form with outcome + note + countdown, Pause / Leave; supervisors see the live agent board.
- Live controller: handle `campaign.call_assigned` (auto `connectLeg`, transport sip / whatsapp).
- WhatsApp settings: route "Team → AI", copy "AI answers every call".
- Admin cards (D18).
- Commit `feat(campaigns): team calling sessions and who-talks choice [CM-T7]`.

### CM-T8 — Reports

- Per-agent stats (D17), calls filter "Talked by", export column. Commit `[CM-T8]`.

### CM-T9 — Checks + sign-off

- Backend: lint, typecheck, build, `openapi:check`, `docs:audit`, `docs:smoke`, full suite once (serial; Mongo crash → rerun failed files). Frontend: lint, typecheck, build, full suite once. Known pre-existing failures: WhatsApp campaign recurrence, inbox "Retry a failed send".
- `docs/phases/CALL_MODES_SIGNOFF.md` (tasks, numbers, deviations, live checks: one SIP team campaign with 2 agents in the SIP lab; one WhatsApp team call on a real number when allowed). Commit `docs(campaigns): record call modes sign-off [CM-DONE]`.

## 4. Rules

1. Branch `feature/call-modes` in both repos from current `main`.
2. One commit per task per repo, Conventional Commit + `[CM-Tn]`, hooks must pass.
3. Every query `accountId`-scoped; agents can act only on their own session / calls.
4. Existing AI campaigns and single calls must behave bit-for-bit the same (existing tests stay green).
5. Catalogue / schema changes with docs + generated contracts in the same task.
6. No `.env` edits; no real customer calls; lab / fakes only.

## 5. Tests (only these)

| File                                                                   | Covers                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| backend `tests/calls-wa/inbound-team-then-ai.test.ts`                  | team rings, timeout → AI answers (not missed); nobody online → AI at once; capacity full everywhere → rejected after 3 s, missed `line_busy`, bell + webhook                                            |
| backend `tests/campaigns/team-session.test.ts`                         | join / heartbeat / leave, atomic reserve (2 agents, 5 contacts → max 2 live), call_assigned only to that agent, socket timeout → contact back to pending + agent paused, wrap-up → ready, outcome saved |
| backend `tests/campaigns/team-dialing.test.ts`                         | SIP team campaign on fake ARI (human call, no AI minutes billed), WhatsApp team campaign on fake Meta (permission respected), waiting-for-agents state, stop leaves live calls running                  |
| frontend `src/features/campaigns/wizard/who-talks.test.tsx`            | Who talks choice per line, agent picker, POST body                                                                                                                                                      |
| frontend `src/features/campaigns/team-session.test.tsx`                | join (mic), call_assigned → bar connects, wrap-up form → ready, leave                                                                                                                                   |
| frontend `src/features/whatsapp-calling/settings` (existing test file) | Team → AI route + program required                                                                                                                                                                      |
| existing                                                               | phase15 route matrix snapshot, catalogue counts, rbac snapshot — update, not weaken                                                                                                                     |

## 6. Final report (short Hinglish)

Har task ✅ / ⚠️ / ❌ + 1 line · commits dono repos · test / build numbers + pre-existing failures · deviations · live checks baaki · push / deploy: "nahi kiya" (unless asked).
