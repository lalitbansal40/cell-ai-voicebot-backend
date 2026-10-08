# 0030 — Email delivery

- **Status:** accepted
- **Date:** 2026-10-08

## Context

Phase 2 needs transactional email (email verification OTP, password reset, team invites); Phase 4 adds receipts and low-balance alerts. The client has not chosen an email provider yet, local development must work without one, and a slow SMTP server must never slow down API requests.

## Options considered

1. **SMTP via nodemailer, sent from a BullMQ queue** — works with any provider (SES SMTP, Zoho, Google Workspace, Postmark…), no vendor lock-in.
2. **Provider HTTP API/SDK** (SES SDK, Resend, Postmark) — nicer delivery webhooks, but ties us to a vendor the client hasn't picked.
3. **Send inside the request** — simplest, but the request waits for SMTP and a failure loses the email.

## Decision

Option 1.

- `EmailProvider` interface (`src/core/email/`): `SmtpEmailProvider` (nodemailer 10, pooled, timeouts, `requireTLS` in production), `LogEmailProvider` (dev without SMTP — logs masked recipient + subject only), `MemoryEmailProvider` (tests). Selected by `EMAIL_DRIVER` (`smtp` | `log`); **production requires `smtp`**.
- Templates are TypeScript functions returning `{ subject, html, text }` with every value HTML-escaped; a typed registry maps template keys to their variables.
- `getEmail().enqueue(template, to, vars, { dedupeKey })` adds a job to the BullMQ **`email`** queue (job data = template key + recipient + vars, never rendered HTML). Worker concurrency 2, 5 attempts with exponential backoff from 5 s; SMTP **5xx** responses are permanent (`UnrecoverableError`, no retry). `dedupeKey` uses BullMQ deduplication for 24 h. Jobs are removed on success; failed jobs are kept 24 h.
- SMTP is verified at startup without blocking it; `/ready` does not depend on email. Shutdown hook `email` (order 35) closes the pool after the queues.
- Local development uses **Mailpit** (`docker-compose.yml`, SMTP 1025, UI 8025); tests use an in-process `smtp-server`.

## Consequences

- **Positive:** provider-agnostic; requests never wait on SMTP; retries are automatic; nothing sensitive (bodies, OTPs, credentials) reaches logs.
- **Negative / trade-offs:** no delivery/bounce webhooks with plain SMTP; recipient + variables sit in Redis until the job completes.
- **Follow-ups:** client to pick the SMTP provider and set up the sender domain (SPF, DKIM, DMARC) before production (Phase 12). Bounce handling / a provider-API driver can be added behind `EmailProvider` later.
