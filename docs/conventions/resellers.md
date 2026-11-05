# Resellers (Phase 19)

- **Accounts:** `kind` = `platform` | `reseller` | `business`; a business may have `parentAccountId` = its reseller (one level only). Resellers sign up themselves (`/signup` → Reseller) or a superadmin creates them; `signup.resellerSignup: approval` makes new resellers `pending_approval` until a superadmin approves them.
- **Permissions:** `reseller.read` (owner, admin, manager) and `reseller.manage` (owner, admin), only meaningful on reseller accounts — `/reseller/*` answers 404 on any other account.
- **What a reseller can do:** add customers (owner name, e-mail, password — no e-mail is sent; optional starting credit), rename, suspend / enable them, set the owner's password, log in as them (act mode, 1 h, sensitive actions refused, audited on both sides), give credit and take back unused credit, read its statement (JSON / CSV), choose whether customers may top up by Razorpay themselves (`customersCanTopUp`, default off → `TOPUP_NOT_ALLOWED`).
- **What a reseller sees:** per customer only name, status, owner, wallet, spend in the last 30 days and last sign-in. Contacts, chats, calls and campaigns only through **Log in as** (audited).
- **Money:** customers pay platform prices from their own wallet; the reseller funds it with credit transfers (`credit_transfer_out` / `_in` pair, zero-sum). What the reseller charges its customer is outside the platform. A customer's low-balance alert also reaches the reseller (`wallet.customer_low_balance`).
- **Superadmin:** creates resellers / businesses (optionally under a reseller), moves a business between resellers, approves resellers, can suspend all of a reseller's customers, opens / closes signup and reseller signup, and can **View as** or **Log in as** any account.

## Campaign channels

Customer capabilities and calling consent are evaluated inside that customer account.
A reseller login-as act session can edit ordinary campaign settings; direct calling and
sensitive actions retain existing impersonation guards. View mode stays read-only.
[Channel guide](campaign-channels.md) describes the three campaign types and sender caps.

Signup and login default to `/reseller` for reseller accounts; a valid same-app `next` path is preserved. The auth-page guard uses the same default, preventing a competing dashboard redirect. Returning from customer act mode restores the saved reseller session and customer detail.
