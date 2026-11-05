# Phase 19 local release notes

This is a local implementation checkpoint, not approval to deploy or send real traffic.
Use [the sign-off](../phases/PHASE_19_SIGNOFF.md) for current verification evidence.

The release includes account kinds/reseller credit, no-code-email signup, audited view/act,
and three campaign types. Message campaigns share a per-number 18/75 Redis pacer, fresh
recurring audiences, durable media, wallet estimates, retry-safe tracking and reports.
WhatsApp calls reuse the existing media/session runtime for incoming/outgoing AI agents
and published flows, including campaign delegation, per-sender consent and ask-first.
Template approval/media and call confirmation preserve the selected number.

Apply additive migrations 0021/0022, then 0023/0024 before starting workers. Migration
0023 backfills `sentCounted` also for failed rows with a historical send timestamp.
Keep Redis queues/budgets across normal restarts. Refresh Meta number metadata:
legacy unknown classification stays at 18/sec until explicitly confirmed. Optional
`WA_CAMPAIGN_MPS` only lowers that cap; `WA_CAMPAIGN_MAX_RECIPIENTS` defaults to 100000.

No new catalogue type is introduced by this continuation. The historical
`auth.email_verified` action is retained as retired because signup no longer verifies
email; password reset and other auth paths keep their existing behavior.

Rollback uses the previous compatible application build and does not run down-migrations.
Before any separately authorized production rollout, complete real-device Meta inbound /
outbound agent and flow checks, carrier SIP calls, server readiness, migrations/backups
and a small campaign to the owner's test numbers. White-label, reseller commissions,
click tracking and Phase 20 incoming SIP remain separate planned features.
