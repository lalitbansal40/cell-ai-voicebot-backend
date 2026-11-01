# ADR 0048: Erasure and suppression

**Status:** Accepted (Phase 16)

## Context

Deleting a contact was a soft delete, and the person's data stayed in chats, calls, webhooks and files. A customer who asks to be erased must really be gone, but their number must not return with the next import, and the wallet and reports must stay correct.

## Decision

**One map.** `modules/privacy/erase-map.ts` has one entry for each store in `docs/security/DATA_MAP.md`, and a test fails if one is missing. Erase and the account purge use the same code.

**Delete, scrub or keep.** Chats, transcripts, insights, recordings and webhook events are deleted. Calls, campaign rows, call events and ledger notes are scrubbed: ids, status, duration, cost and amounts stay, so money and reports don't change. Audit rows, invoices and daily stats are kept.

**Files.** A file holding the person is removed whole, even if it holds others. A compressed file can't be searched, so it counts as holding them.

**Suppression.** `suppressions` stores an HMAC of the phone, with `SUPPRESSION_HMAC_KEY`, which is never rotated.

| Reason             | File, sheet or API key adds the number | Added by hand | Calls and templates   | The person writes first             |
| ------------------ | -------------------------------------- | ------------- | --------------------- | ----------------------------------- |
| `erased`           | Refused                                | Allowed       | Allowed if added back | New contact                         |
| `opted_out`, `dnd` | Refused                                | Refused       | Blocked               | New contact, outreach still blocked |

**Order.** Suppression is written first and the contact row is removed last, so a stopped run can start again and the number can't come back meanwhile.

**Access.** `contacts.erase`, sessions only, never while impersonating, and never an API key. A contact on a live call answers 409; a bulk job tries it again later. Without `SUPPRESSION_HMAC_KEY` in production, erase answers 503, and an existing deploy still starts.

## Consequences

- Erasure can't be undone.
- Chats on the customer's phone, data held by Meta, data already sent to a webhook receiver, and backups aren't reached. The privacy policy says so.
- Removing a whole file can take other people's export with it. They can export again.
- Cached speech audio can't be linked to a person and ages out.
