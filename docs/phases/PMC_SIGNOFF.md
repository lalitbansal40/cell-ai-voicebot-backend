# PMC sign-off: calls via Meta direct for managed (Pinnacle) numbers

21 Nov 2026 · Prompt: [PINNACLE_META_CALLING_PROMPT.md](../prompts/PINNACLE_META_CALLING_PROMPT.md) · ADR: [0053](../adr/0053-managed-number-meta-direct-calling.md)

## Tasks

| Task                                                                             | Status    |
| -------------------------------------------------------------------------------- | --------- |
| T0 Call sites listed (calls ×9, settings ×2, permissions ×1, readiness)          | ✅        |
| T1 `metaCalling` field, migration `0032-wa-meta-calling`, DTO, privacy, reseal   | ✅        |
| T2 `callingClientFor` + every calling API through it                             | ✅        |
| T3 Enable / disable / check / daily sweep service                                | ✅        |
| T4 Routes + admin twins + OpenAPI + `metaCallingEnabled` config                  | ✅        |
| T5 Meta webhook keeps `calls` / `account_settings_update`; relay `calls` dropped | ✅        |
| T6 Settings sync / update + readiness (`meta_direct`)                            | ✅        |
| T7 Bell `whatsapp.meta_calling_broken`, healthwatch, Admin → System counts       | ✅        |
| T8 Frontend: drawer section, dialog, steps, card chip, labels                    | ✅        |
| T9 Tests (backend + frontend)                                                    | ✅        |
| T10 Docs                                                                         | ✅        |
| T11 Ship + live test                                                             | see below |

## Call sites moved to `callingClientFor` (T0)

- `calls.service.ts`:
  - `startCall`, `preAcceptCall`, `acceptCall`, `rejectCall` ×3 (two were `ctx.meta` before, now the number's calling client), `terminateCall` ×3.
- `settings.service.ts`:
  - `getPhoneSettings` (sync), `updateCallingSettings` (update).
- `permissions.service.ts`:
  - `getCallPermissions`.
- `readiness.ts`:
  - the scope check reads the Meta calling token for a managed number with Meta calling on.
- The permission-request **message** stays a partner send (inbox send job).

## Deviations from the prompt

- **Admin twins use the existing pattern** `/admin/whatsapp/channels/:id/meta-calling` (the channel id gives the account), like Webhook check / Fix.
- **Check needs the number to be `on` or `error`.** Check / Fix on a number that is `off` answers `CONFLICT_INVALID_STATE` (nothing to check).
- **WABA-level events are filtered too.** Meta's WABA-level changes (templates, account updates) for a WABA used only by Meta-direct managed numbers are dropped on the Meta route (the relay brings them), so no event is handled twice.
- **`debug_token` not valid means a bad token.** It is reported as `WHATSAPP_SIGNUP_FAILED` (step `verify`), so a check classifies it as `token_invalid`.

## Live checklist (fill in after the client deploy)

| #   | Check                                                                                    | Result |
| --- | ---------------------------------------------------------------------------------------- | ------ |
| 1   | Number details → Calling on karo → popup → same WABA / number → all steps ✅             |        |
| 2   | Test call → Admin → WhatsApp events: a `calls` event with source `meta`                  |        |
| 3   | Call from another phone → inbox rings → answer → audio both ways → hang up → `completed` |        |
| 4   | AI incoming ON → the AI answers; OFF → the team rings                                    |        |
| 5   | Inbox Call myself / Call with AI / Schedule AI call to a customer with permission        |        |
| 6   | A message goes via Pinnacle; no duplicate from the Meta webhook                          |        |
| 7   | Calling off → an inbound call doesn't ring; Calling on again works                       |        |
| 8   | Popup can't share the WABA → superadmin Advanced → System User token → steps 1–3         |        |

Client deploy: rebuild, migration `0032`, env `WA_META_CALLING_ENABLED=true` (the default).
