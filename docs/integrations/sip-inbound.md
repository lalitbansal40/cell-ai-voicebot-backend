# Incoming phone calls (Phase 20)

Customers call an account's number; the number's settings decide who answers. Design: [ADR 0051](../adr/0051-inbound-sip.md). Outgoing calls and the trunk itself: [sip-trunk.md](sip-trunk.md).

## What we need from the trunk provider (Cell24x7)

1. The **DID numbers** for incoming calls, routed to our Asterisk (same trunk / IPs as outgoing calls).
2. **Where the DID is sent**: the request URI (`INVITE sip:<did>@…`, preferred) or only the `To` header. Formats we accept: `+91XXXXXXXXXX`, `91XXXXXXXXXX`, `0XXXXXXXXXX`, 10 digits.
3. The **source IPs** of incoming calls (they go in `SIP_TRUNK_IPS`; other sources get no dialplan).
4. **Codec** (ulaw / alaw, same as outgoing) and the **channel limit** for incoming + outgoing together.
5. The **price per incoming minute** (for the rate card).

## Turning it on

1. Migration `0026-inbound-sip` (part of the release).
2. Asterisk: redeploy the container so the new dialplan renders (`asterisk.env` needs `ARI_APP`, same as the backend; default `cav`).
3. Backend env: `SIP_INBOUND_ENABLED=true` (with `TELEPHONY_PROVIDER=sip`). Optional: `SIP_INBOUND_PER_CALLER_PER_HOUR` (10), `SIP_INBOUND_RESERVED_CHANNELS` (0), `SIP_INBOUND_RING_MAX_SEC` (120).
4. Superadmin: **Admin → Phone numbers** — add the DID, "Used for" = Incoming (or Outgoing + incoming), give it to the account; set the incoming minute price on the rate card (empty = the call price).
5. Account: **Settings → Phone numbers** — turn the number on, choose who answers, call hours and after-hours behaviour. The card lists anything still missing.

## What callers hear

| Situation                          | Caller hears                                      | Charged | Recorded as                                   |
| ---------------------------------- | ------------------------------------------------- | ------- | --------------------------------------------- |
| Number unknown / off / account off | "Call rejected" (21)                              | no      | nothing                                       |
| Too many calls from one caller     | Busy (17)                                         | no      | missed `spam` (not to call back)              |
| All trunk channels busy            | Busy (17)                                         | no      | missed `line_busy`                            |
| After hours — message              | The account's message                             | no      | missed `after_hours`                          |
| After hours — do not answer        | "Call rejected" (21)                              | no      | missed `after_hours`                          |
| Wallet too low                     | "Service not available" line                      | no      | missed `wallet_low`                           |
| AI route                           | The flow / agent                                  | yes     | call                                          |
| Team route, someone accepts        | Ringing (or greeting + ringback), then the person | yes     | call (answered by them)                       |
| Team route, nobody in time         | "Nobody free, we will call back" (or the AI)      | yes*    | missed `no_answer` / `no_agents` (or AI call) |
| Caller hangs up while it rings     | —                                                 | no      | missed `caller_hung_up`                       |

\* the short line is answered, so carrier minutes apply.

## Lab check

`npm run sip:lab`, then `bash deploy/asterisk/lab/call-in.sh 911600000001 919000000001` with a backend on `TELEPHONY_PROVIDER=sip`, `SIP_INBOUND_ENABLED=true` and `+911600000001` set up as an incoming number.

## Live check (owner's approval and phone only)

1. Owner's phone → DID with route **AI**: the flow / agent speaks; the call shows as Incoming with the number called; the wallet is charged once.
2. Route **Team**: a team member's browser rings, Accept, both sides hear each other.
3. Call hours closed: the message plays; Calls → Missed lists it; the bell rings; `call.missed` reaches a webhook endpoint.
