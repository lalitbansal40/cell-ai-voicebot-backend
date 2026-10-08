# Cell AI Voicebot — Docs

Source of truth for plans, decisions and conventions. (PDF exports are kept outside the repo.)

| Folder                       | What's inside                                                     |
| ---------------------------- | ----------------------------------------------------------------- |
| [plans/](plans/)             | Product build plan (v2) and the archived v1 overview              |
| [phases/](phases/)           | Detailed per-phase plans and task trackers                        |
| [prompts/](prompts/)         | Autonomous run prompts and the task prompt template               |
| [adr/](adr/)                 | Architecture Decision Records                                     |
| [conventions/](conventions/) | Definition of Done, secrets policy, API / data / code conventions |
| [setup/](setup/)             | Machine prerequisites and setup notes                             |
| [poc/](poc/)                 | Proof-of-concept results (Voice AI, SIP lab)                      |
| [client/](client/)           | Questions sent to the client and their answers                    |
| [cost/](cost/)               | Cost model                                                        |
| [compliance/](compliance/)   | Compliance research notes                                         |

## Key files

- [plans/BUILD_PLAN.md](plans/BUILD_PLAN.md) — phase-wise build plan (v2, SIP based)
- [plans/OVERVIEW_PLAN.md](plans/OVERVIEW_PLAN.md) — v1 overview (archived)
- [phases/PHASE_0_PLAN.md](phases/PHASE_0_PLAN.md) — Phase 0 detailed plan
- [phases/PHASE_0_TASKS.md](phases/PHASE_0_TASKS.md) — Phase 0 task tracker
- [phases/PHASE_0_SIGNOFF.md](phases/PHASE_0_SIGNOFF.md) — Phase 0 sign-off
- [phases/PHASE_1_PLAN.md](phases/PHASE_1_PLAN.md) · [phases/PHASE_1_TASKS.md](phases/PHASE_1_TASKS.md) — Phase 1 detailed plan + tracker
- [prompts/PHASE_0_BATCH_1_PROMPT.md](prompts/PHASE_0_BATCH_1_PROMPT.md) — Phase 0 batch 1 run prompt
- [prompts/PHASE_0_BATCH_2_4_PROMPT.md](prompts/PHASE_0_BATCH_2_4_PROMPT.md) — Phase 0 batches 2–4 run prompt (T0.11–T0.20)
- [prompts/PHASE_1_BATCH_1_PROMPT.md](prompts/PHASE_1_BATCH_1_PROMPT.md) — Phase 1 batch 1 run prompt (T1.1–T1.6)
- [prompts/TASK_PROMPT_TEMPLATE.md](prompts/TASK_PROMPT_TEMPLATE.md) — template for task-wise prompts
- [adr/README.md](adr/README.md) — ADR index
- [conventions/api.md](conventions/api.md) — REST API conventions
- [conventions/error-codes.md](conventions/error-codes.md) — error code catalogue
- [conventions/websocket.md](conventions/websocket.md) — WebSocket conventions + event catalogue
- [conventions/data.md](conventions/data.md) — MongoDB data conventions + PII inventory
- [conventions/data-model.md](conventions/data-model.md) — core data model draft (ERD, entities, indexes)
- [conventions/code-style.md](conventions/code-style.md) — code style
- [conventions/definition-of-done.md](conventions/definition-of-done.md)
- [conventions/secrets.md](conventions/secrets.md) — secrets policy
- [setup/prerequisites.md](setup/prerequisites.md)
- [setup/github-settings.md](setup/github-settings.md) — manual GitHub settings (push, branch protection, security)
- [client/CLIENT_QUESTIONS.md](client/CLIENT_QUESTIONS.md) · [client/answers.md](client/answers.md)
- [client/server-audit.md](client/server-audit.md) — read-only client server audit (blocked: SSH key pending)
- [poc/voice-ai-poc-results.md](poc/voice-ai-poc-results.md) — Voice AI PoC results
- [poc/sip-lab-notes.md](poc/sip-lab-notes.md) — SIP lab notes
- [cost/cost-model.md](cost/cost-model.md) — per-minute cost model draft
- [compliance/compliance-notes.md](compliance/compliance-notes.md) — TRAI / RBI / DPDP research notes
- [poc/README.md](poc/README.md) · [cost/README.md](cost/README.md) · [compliance/README.md](compliance/README.md)
