# Release notes — Phase 16 (security, compliance, QA) for the client's deploy

**What's new:**

- Sensitive custom fields, sealed at rest and masked by role.
- Contact erasure, with a suppression list that keeps an erased or opted-out number blocked.
- Whole-account export and deletion, with 7 days to cancel.
- Compliance page under Settings, with a CSV of changes.
- Two-step sign-in for superadmins, and API key limits per account.
- Encryption key rotation without downtime.
- Two load fixes: inbound messages and delivery statuses no longer scan an account's messages,
  and wallet changes no longer fail with 500 when many sends hit one account.

## Before deploying

- **Back up the database** (`backup.sh` or an Atlas snapshot).
- **New environment variables:**

| Name                      | Needed                 | What to set                                                  |
| ------------------------- | ---------------------- | ------------------------------------------------------------ |
| `SUPPRESSION_HMAC_KEY`    | Yes, for erasure       | A new random secret. Never change it later without a plan.   |
| `ENCRYPTION_KEYS_OLD`     | Only during a rotation | Previous keys, see `docs/ops/secret-rotation.md`.            |
| `HSTS_BY_PROXY`           | If nginx sends HSTS    | `true`, so the header is sent once.                          |
| `MFA_ENFORCED_FOR_ADMINS` | Later                  | Leave `false` until every superadmin has set up their codes. |

- **Nginx:** apply the block in `docs/ops/nginx-security-headers.md`. Keep CSP in report-only until the
  Meta sign-up popup and Razorpay have been checked with it.
- **DNS:** `wa.notifynow.in` has shown a second address, `45.114.245.71`. Remove it or make sure it
  serves the same HTTPS site.

## Deploy steps

1. Deploy the backend and run the migrations (`deploy.sh` does it; otherwise `npm run db:migrate`).
   The migration is **`0018-security-privacy`**. It adds indexes and defaults and rewrites no data.
2. The system roles pick up the new permissions on the same run: `contacts.erase` (owner, admin),
   `account.export` and `account.delete` (owner).
3. New jobs start by themselves. Maintenance gains `account-purge` and `account-exports-cleanup`.
4. Deploy the frontend.

## Check after deploy

- `GET /api/v1/health`: `uptimeSec` is small and `commit` is the new one.
- `npm run check:headers -- https://wa.notifynow.in`: one HSTS header, on every DNS address.
- In production, `/api/v1/openapi.json` lists only the public API.
- **Settings → Compliance** opens and shows the rules in force.
- **Contacts → Fields:** a test field can be marked sensitive. Its value shows as a mask to a viewer.
- On a test contact only: **Erase permanently** works, and adding the number again is refused if it
  had opted out.
- **Settings → Account → Export all data:** the file downloads on a test account.
- **Settings → Security** as superadmin: **Set up** shows the codes. Keep the recovery codes safe.

Never try account deletion on a real account. It can be canceled for 7 days, then it is permanent.

## Rollback

Roll back the release (`rollback.sh`). The new collections stay but are unused. If needed, revert
migration `0018` with `node dist/ops/migrate.js down` after reading what it removes.

**Rolling back after sensitive fields are in use:** the old build cannot read sealed values. Turn the
fields back to normal first and wait for the job to finish. Rolling back after a key rotation: keep the
old keys available until the old build is gone.

## Owner actions, not part of the deploy

- Rotate the secrets listed in `docs/ops/secret-rotation.md`.
- Have a lawyer confirm the policy drafts.
- Fix the DNS record and decide on the repository's visibility.
