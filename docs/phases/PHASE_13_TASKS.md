# Phase 13 — Tasks (tracker)

Plan: [PHASE_13_PLAN.md](PHASE_13_PLAN.md) · Branch: `feature/phase-13-staging-app-review`

| ✓   | #      | Task                                                                                                                                       | Repo | Size |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---- |
| [x] | T13.1  | Meta 2026 changes: Embedded Signup v4, Graph v26.0, account-model audit (`waac_id`), webhook fields, calling subscription; fake + fixtures | both | M    |
| [x] | T13.2  | Legal + public pages: privacy, terms, contact, data deletion instructions, footer links, app icon set                                      | FE   | M    |
| [x] | T13.3  | Deploy artifacts: Dockerfile, staging compose, nginx config, env template, health version, CI image build + scan                           | both | M    |
| [x] | T13.4  | Ops tooling: demo seed, smoke, backup / restore, healthwatch, GitHub Actions deploy + rollback, local production rehearsal                 | both | M    |
| [ ] | T13.5  | Staging server: provision, harden, firewall + UDP media range, DNS, TLS, mail DNS, backup target, monitors                                 | ops  | M    |
| [ ] | T13.6  | First deploy: env, migrations, superadmin, demo seed, Razorpay test, SMTP, OpenAI, backup + restore drill, drain check                     | ops  | M    |
| [ ] | T13.7  | Real Meta app: business verification, settings, ES v4 config, webhooks + fields, callbacks, roles, §11 smoke                               | ops  | M    |
| [ ] | T13.8  | Real checks: setup guide §12, §13, §14, §15 on real phones (latency), staging log grep, fixes                                              | both | L    |
| [ ] | T13.9  | App Review pack: permissions, texts, per-permission screencasts, reviewer instructions, demo account, pre-submit checklist                 | docs | M    |
| [ ] | T13.10 | Submit + follow up until Advanced Access; app Live; Tech Provider steps; client's real number via ES; rate cards; billing mode             | ops  | M    |
| [ ] | T13.11 | Gap audit, runbook, ADR 0025 / 0042, setup guides, READMEs, CHANGELOGs, BUILD_PLAN_V2, sign-off                                            | both | M    |

Checkpoints: `[P13-B1-DONE]` after T13.4 · `[P13-B2-DONE]` after T13.7 · `[P13-B3-DONE]` after T13.11.
