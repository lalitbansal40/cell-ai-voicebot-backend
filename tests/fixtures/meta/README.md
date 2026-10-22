# Meta fixtures (Phase 9)

Shapes copied from Meta's documented sample payloads; every id, number, name and text is a **test value** (`+91 90000 …`, `Test Business`, `Test Customer`). No real data, no AutoChatix data. Re-check against the docs when bumping `META_GRAPH_VERSION`.

| File                                      | Source (developers.facebook.com/docs/…)                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `graph-oauth-token.json`                  | whatsapp/embedded-signup/implementation (exchange the code)                  |
| `graph-debug-token.json`                  | graph-api/reference/debug_token                                              |
| `graph-me-wabas.json`                     | whatsapp/embedded-signup/manage-accounts (`/me/whatsapp_business_accounts`)  |
| `graph-me-businesses.json`                | graph-api/reference/user/businesses + `owned_whatsapp_business_accounts`     |
| `graph-waba.json`                         | graph-api/reference/whatsapp-business-account                                |
| `graph-phone-numbers.json`                | graph-api/reference/whatsapp-business-account/phone_numbers                  |
| `graph-phone-number.json`                 | graph-api/reference/whatsapp-business-phone-number                           |
| `graph-success.json`                      | `subscribed_apps` POST / DELETE, `assigned_users`, `register`                |
| `graph-me.json`                           | graph-api/reference/user (`/me?fields=id`)                                   |
| `graph-credit-line-attach.json`           | whatsapp/solution-providers/share-and-revoke-credit-lines                    |
| `graph-allocation.json`                   | same page (verify the allocation `receiving_credential`)                     |
| `graph-smb-app-data.json`                 | whatsapp/embedded-signup/custom-flows/onboarding-business-app-users          |
| `graph-error-token-expired.json`          | graph-api/guides/error-handling (190 / 463)                                  |
| `graph-error-rate-limit.json`             | whatsapp/cloud-api/support/error-codes (80007)                               |
| `graph-error-pin-mismatch.json`           | whatsapp/cloud-api/support/error-codes (133005)                              |
| `webhook-account-update-*.json`           | whatsapp/business-management-api/webhooks/components (`account_update`)     |
| `webhook-quality-update.json`, `-flagged` | same page (`phone_number_quality_update`)                                    |
| `webhook-name-update.json`, `-rejected`   | same page (`phone_number_name_update`)                                       |
| `webhook-capability-update.json`          | same page (`business_capability_update`)                                     |
| `webhook-smb-message-echoes.json`         | whatsapp/embedded-signup/custom-flows/onboarding-business-app-users (echoes) |
| `webhook-history-*.json`                  | same page (`history`: chunks, final chunk, declined `2593109`)               |
| `webhook-smb-app-state-sync.json`         | same page (`smb_app_state_sync` contacts)                                    |
| `webhook-messages-text.json`, `-status`   | whatsapp/cloud-api/webhooks/payload-examples                                 |
| `webhook-calls-connect.json`              | whatsapp/cloud-api/calling/user-initiated-calls (`calls` connect)            |
| `webhook-template-status.json`            | whatsapp/business-management-api/webhooks/components (template status)      |
