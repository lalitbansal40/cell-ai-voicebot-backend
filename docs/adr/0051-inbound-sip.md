# ADR 0051: Incoming phone calls on the SIP line

**Status:** Accepted (Phase 20)

## Context

Customers must be able to call the account's numbers (DIDs on the client's SIP trunk) and reach a flow, an AI agent or the team in the browser — like WhatsApp incoming calls (Phase 12). Until now `[cav-in]` hung up every trunk call (`Hangup(21)`). Each process has its own ARI app ([ADR 0050](0050-sip-shared-server.md)), so a trunk call must be handed to exactly one process.

## Decision

**Dialplan.** `[cav-in]` sends the call to the Stasis app `<ARI_APP>-inbound` with two arguments: the dialed number (request URI, else the `To` header) and the caller number. When no process has that app (`SIP_INBOUND_ENABLED=false`) Stasis fails and the caller hears "unavailable" (cause 34). `extensions.conf` becomes a template (only `${ARI_APP}` is substituted).

**One process takes calls.** Only the API process (`WORKERS_ENABLED=false`; a single dev process too) adds `<ARI_APP>-inbound` to its ARI socket. A Redis claim per Asterisk channel (`sip:in:<channelId>`, NX, 5 min) keeps a second node from taking the same call.

**The leg.** `SipCallLeg` gets an inbound mode: the channel already exists (Asterisk's id, not `cav-<callId>`), `ring()` sends 180, `dial()` answers and runs the same bridge + ExternalMedia path as outgoing calls, `reject()` refuses before the answer (busy 17, rejected 21, unavailable 34). The provider routes events by an `Asterisk id → call id` map; orphans are found through the `CAV_CALL_ID` channel variable.

**Routing (per number, `phoneNumbers.inbound`).** `ai` · `team` · `ai_then_team` (the program's transfer step rings the team) · `team_then_ai` (nobody in time → AI). Checks in order: number + account (refuse, no record) → spam guard per caller per hour → trunk channel (incoming calls may use channels outgoing calls leave free, `SIP_INBOUND_RESERVED_CHANNELS`) → call hours (message / AI / hang up) → wallet hold at the incoming minute price (else a fixed line, never charged) → contact by caller number (made when new; hidden callers have none) → call doc → route.

**Team ring.** The WhatsApp ring rules: eligible = `calls.answer`, active, available, online, not on another call, on the number's ring list. First answer wins over the call bus (`claimAgent` + `claimAnswer`); the winner's browser joins through `/ws/media` and the call is answered then (or at once when the number has a greeting, with ringback until someone takes it).

**Missed calls.** A call nobody (person or AI) took gets `missed: { reason, callback }`, a bell `call.sip_missed`, the webhook `call.missed`, and appears in Calls → Missed until someone marks it done or calls the customer back.

## Consequences

- Live use needs the client's DID routed to our Asterisk and the DID position confirmed; everything else runs in the lab (`deploy/asterisk/lab/call-in.sh`) and on the fake ARI in tests.
- Incoming and outgoing calls share the trunk channels; reserving some for incoming calls lowers campaign concurrency.
- Voicemail, queue positions and IVR menus outside flows are not part of this decision.
