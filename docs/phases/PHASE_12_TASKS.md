# Phase 12 — Tasks (tracker)

Plan: [PHASE_12_PLAN.md](PHASE_12_PLAN.md) · Overview: [BUILD_PLAN_V2.md](../plans/BUILD_PLAN_V2.md)

| ✓   | #      | Task                                                                                                                                                         | Repo | Size |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---- |
| [x] | T12.1  | **PoC:** werift + Opus + resampling, loopback with a Meta-like ICE-lite peer, DTMF, keep-alive, CPU / latency numbers; ADR 0040; plan B gate                 | BE   | M    |
| [x] | T12.2  | Models (channel calling, call permissions, Call / Message / contact / user / account fields, calling rate card), migration 0013, limits, env, catalogue      | BE   | M    |
| [x] | T12.3  | Meta core: Graph calling + settings + call permissions API, schemas + fixtures, error mapping, `account_settings_update`; fake Meta calling + `FakeWaUser`   | BE   | L    |
| [x] | T12.4  | `WhatsAppCallLeg` (media, codec, pacer, DTMF, keep-alive, metrics) + call-control bus (owner registry, pub / sub, inbound claim, cross-process hangup)       | BE   | L    |
| [x] | T12.5  | Calling settings service + permissions service (request, reply, status API, counters, sweep, streak, restrictions) + webhooks                                | BE   | M    |
| [ ] | T12.6  | Outbound calls: dial guard, provider `whatsapp`, agent leg bridge, AI calls, statuses, end / settle, call bubbles, call button sends                         | BE   | L    |
| [ ] | T12.7  | Inbound calls: claim, routing (team ring / AI / AI → team), answer race, missed calls, call hours, transfer                                                  | BE   | L    |
| [ ] | T12.8  | Billing (calling rate card, pulses, holds, settle, margin), API + OpenAPI, simulator, seed, `dev:calls-wa`, hardening, ADR 0041, docs, real-device checklist | BE   | M    |
| [ ] | T12.9  | FE foundation, number Calling settings, contact panel calling section, permission bubbles                                                                    | FE   | M    |
| [ ] | T12.10 | FE call experience: Call button, call bar + agent media, incoming popup, Call with AI, availability, call bubbles                                            | FE   | L    |
| [ ] | T12.11 | FE Calls list / detail, wallet, superadmin calling rates, notifications, dashboard, bundle; Playwright E2E (4 specs, twice)                                  | FE   | L    |
| [ ] | T12.12 | Gap audit, security / money checklist, docs, Phase 12 sign-off                                                                                               | both | M    |

Checkpoints: T12.1 PoC gate before everything else · `[P12-B1-DONE]` after T12.4 · `[P12-B2-DONE]` after T12.8 · `[P12-B3-DONE]` after T12.12.
