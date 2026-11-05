# SIP trunk — what we need and test results

Phone calls go out through the client's SIP trunk to Asterisk ([ADR 0050](../adr/0050-sip-shared-server.md)). This page is the questionnaire for the client (Gate S) and the record of the real test calls.

## 1. Questionnaire (Gate S)

Send passwords through a secure channel, never chat or e-mail. On our side they go into `~/.cav-sip/trunk.secret.env` (mode 600) or the server's env file, and nowhere else.

| #   | Item                                                                                        | Why we need it                                                          | Env key                                    |
| --- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| 1   | SIP host / IP, port, transport (UDP / TCP / TLS)                                            | Where Asterisk sends calls                                              | `SIP_HOST`, `SIP_PORT`, `SIP_TRANSPORT`    |
| 2   | Auth: registration (username + password) or IP-based                                        | Template mode; for IP-based, our server's public IP must be whitelisted | `SIP_AUTH`, `SIP_USERNAME`, `SIP_PASSWORD` |
| 3   | Trunk signaling and media IP ranges                                                         | Firewall: SIP and RTP open to these only (toll fraud, scanners)         | `SIP_TRUNK_IPS`                            |
| 4   | Codecs (G.711 μ-law / A-law), DTMF mode (RFC 4733 / INFO / in-band)                         | No transcoding; keypad input must arrive once                           | `SIP_CODECS`, `SIP_DTMF`                   |
| 5   | Concurrent channel limit, calls per second                                                  | Our dialer never asks for more than the trunk allows                    | `SIP_MAX_CHANNELS`, `SIP_MAX_CPS`          |
| 6   | Caller ID numbers (1600-series), how to send them (From / P-Asserted-Identity), DLT details | The number customers see; regulatory                                    | `SIP_CALLER_IDS`                           |
| 7   | Rate per minute, pulse, CDR access (portal / CSV)                                           | Billing check and margin report                                         | `SIP_RATE_PAISE_PER_MIN`, `SIP_PULSE_SEC`  |
| 8   | Transfer: is SIP REFER allowed, or only a second call?                                      | How we hand a call to a human agent                                     | —                                          |
| 9   | Test window and allowed test numbers                                                        | Real test calls go only to the owner's phones                           | `SIP_TEST_NUMBERS`                         |
| 10  | Support contact at the trunk provider                                                       | One-way audio and registration problems need their side                 | —                                          |

### Example (fake values)

```bash
# ~/.cav-sip/trunk.env (600) — example only
SIP_HOST=sip.example.net
SIP_PORT=5060
SIP_TRANSPORT=udp
SIP_AUTH=ip
SIP_TRUNK_IPS=203.0.113.10,203.0.113.11
SIP_CODECS=ulaw,alaw
SIP_DTMF=rfc4733
SIP_MAX_CHANNELS=30
SIP_MAX_CPS=2
SIP_CALLER_IDS=+911600000000
SIP_RATE_PAISE_PER_MIN=40
SIP_PULSE_SEC=60
SIP_TEST_NUMBERS=+919800000000,+919700000000
```

## 2. Results (T18.18)

Each check on 10 calls to the owner's phones on two networks. Numbers are shown by their last 4 digits only.

| #   | Check                                         | Target              | Result |
| --- | --------------------------------------------- | ------------------- | ------ |
| 1   | Trunk registered / identified; OPTIONS ping   | OK                  | —      |
| 2   | Phone rings, caller ID is the assigned number | Shown               | —      |
| 3   | Audio both ways; first bot word after answer  | Clear; ≤ 1.5 s      | —      |
| 4   | Barge-in stops the bot                        | ≤ 300 ms            | —      |
| 5   | DTMF 0–9, `*`, `#`                            | Each received once  | —      |
| 6   | Busy, reject, switched off, invalid number    | Right cause         | —      |
| 7   | Transfer to a second phone                    | Connects; AI leaves | —      |
| 8   | Recording and transcript                      | Present, audible    | —      |
| 9   | Charge vs trunk CDR                           | Pulse rule; match   | —      |
| 10  | AMD on, phone with voicemail                  | Machine detected    | —      |

**Status 3 Nov 2026: not run.** No trunk details (Gate S) and no server (Gate P). Everything above was exercised in the Mac lab with SIPp as the trunk (`npm run test:sip`, 11 checks) — real carriers, handsets, DTMF over RFC 4733 from a phone, caller-ID display and the CDR comparison wait for the trunk.

## 3. Incoming calls (Phase 20)

Trunk calls to the account's DIDs are handled by the inbound app — setup, provider questions and what callers hear: [sip-inbound.md](sip-inbound.md).
