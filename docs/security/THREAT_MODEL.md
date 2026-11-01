# Threat model

What we protect, from whom, and which control and test cover it. A row with no test is a task in Phase 16 or an open item.

## Assets

Customer phones and names · loan data in custom fields · call recordings and transcripts · WhatsApp chats · wallet money · Meta tokens and other sealed secrets · team logins and API keys.

## Threats and controls

| Actor                               | Threat                                         | Control                                                                                                                         | Evidence                                                                |
| ----------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Outsider                            | Password guessing                              | Argon2, lockout, auth rate limit, same timing for unknown users                                                                 | `tests/auth/*`, T16.9 inventory                                         |
| Outsider                            | Forged Meta / Razorpay webhooks                | HMAC over raw bytes                                                                                                             | `tests/whatsapp/*`, `tests/payments/*`                                  |
| Outsider                            | Reading route structure                        | Public spec only in production                                                                                                  | T16.2, `tests/http/docs.test.ts`                                        |
| Outsider                            | Clickjacking, script injection                 | Security headers, CSP                                                                                                           | T16.2, `check:headers`                                                  |
| Another customer                    | Reading or changing our records                | `accountId` from auth only, 404 for foreign ids                                                                                 | `tests/security/{tenant-scope,phase14-routes,phase15-routes,phase16-*}` |
| Staff user                          | More access than the role                      | Permission matrix snapshots                                                                                                     | `tests/security/*`, `tests/rbac/*`                                      |
| Staff user                          | Taking data out in bulk                        | Masked phones, `contacts.export`, audit, session-only erase and export                                                          | T16.4–T16.6                                                             |
| Superadmin                          | Stolen admin login                             | TOTP (T16.9), impersonation limits, audit on both sides                                                                         | T16.9                                                                   |
| Leaked API key                      | Using it from anywhere                         | Scopes, IP allowlist, expiry, per-key limits, revoke within 30 s, request log                                                   | `tests/public-api/access.test.ts`                                       |
| Malicious webhook target or sheet   | SSRF into our network                          | URL guard, DNS re-check, no redirects                                                                                           | `tests/webhooks/routes.test.ts`, `delivery.test.ts`                     |
| Customer's words / client documents | Prompt injection                               | Data blocks, guardrails, schema-checked output                                                                                  | `core/ai/guardrails.test.ts`, insights tests                            |
| Uploaded file                       | Zip bomb, script, formula injection            | Type by content, limits, neutralised CSV cells                                                                                  | T16.9                                                                   |
| Database dump                       | Reading secrets or loan data                   | Sealed secrets, sensitive fields sealed, keys outside the DB; **phones stay plain** (plan §7 #1), covered by encryption at rest | T16.3, T16.4, owner confirms §7 #11                                     |
| Lost or leaked `ENCRYPTION_KEY`     | All sealed data readable or lost               | Rotation, `keys:reseal`, key backup                                                                                             | T16.3, `docs/ops/secret-rotation.md`                                    |
| Bug or retry                        | Double charge, or data coming back after erase | Idempotency keys, ledger guards, leak scan                                                                                      | `tests/security/money-writes.test.ts`, T16.5                            |
| Load                                | One account starving others                    | Global and per-key limits, call capacity, queue separation                                                                      | T16.8                                                                   |

## Known gaps (accepted or owned)

- Phones and names aren't encrypted at application level (plan §7 #1).
- No external pen test in this phase (plan §7 #6).
- The client's server, nginx and DNS are outside this repo: see `docs/ops/nginx-security-headers.md` and Phase 17.
