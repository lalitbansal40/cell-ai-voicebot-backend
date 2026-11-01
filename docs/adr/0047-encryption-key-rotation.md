# ADR 0047: Encryption layers and key rotation

**Status:** Accepted (Phase 16)

## Context

Secrets at rest were sealed with one key and a format that didn't say which key was used. Replacing `ENCRYPTION_KEY` would have broken every sealed value at once, and secrets were shared in chat during setup, so at least one rotation is required.

## Decision

**Format.** `v2:<keyId>:<iv>:<tag>:<data>`, AES-256-GCM. `keyId` is the first 8 hex characters of the SHA-256 of the derived key, so it names the key without revealing it. `v1` values still open; each configured key is tried.

**Keys.** `ENCRYPTION_KEY` seals. `ENCRYPTION_KEYS_OLD` (comma list) only opens.

**Registry.** `sealed-registry.ts` lists every sealed field, including nested arrays. A test fails when a model gains a sealed field that isn't listed.

**Re-seal.** `npm run keys:reseal` works in pages and writes a value only if it still equals what was read, so a save during the run wins. Stopping and rerunning is safe. A value it can't open stays untouched and the command exits 1.

**Layers.**

| Data                                                                 | Protection                                    | Why                                                 |
| -------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------- |
| Tokens, PINs, webhook secrets, API header secrets, raw Meta payloads | Sealed                                        | Useless to the app in search; high harm if leaked   |
| Custom fields marked sensitive (T16.4)                               | Sealed per value                              | Loan data, chosen by the customer                   |
| Phone, name, e-mail                                                  | Plain, covered by database encryption at rest | Needed for search, dedupe and dialling (plan §7 #1) |
| Suppression records                                                  | One-way HMAC with `SUPPRESSION_HMAC_KEY`      | Must match a number without storing it              |

`SUPPRESSION_HMAC_KEY` is never rotated, because a new key would lose every suppression.

## Sensitive fields

A custom field marked sensitive is stored as `{ $enc: 'v2:…' }`. `modules/privacy/sensitive.ts` is the one read and write path, and a guard test enforces it. Lists show `••••`; the contact page and exports need `contacts.export`; API keys never get the value. Copies on calls and campaign rows leave the value out, and run state and queued messages hold sealed text.

What the bot says or a template sends is stored as conversation, so a spoken or sent value appears in transcripts and messages until retention or erase removes it.

## Consequences

- Rotating needs no downtime; steps are in `docs/ops/secret-rotation.md`.
- Keep a backup of keys apart from database backups: an old backup needs its old key. Losing the key loses the sealed values.
- Local signed file links also derive from `ENCRYPTION_KEY`, so links in flight stop working at rotation. They last 15 minutes by default.
