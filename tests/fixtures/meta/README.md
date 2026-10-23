# Meta fixtures (Phases 9–11)

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
| `messages-*.json` (Phase 10) | whatsapp/cloud-api/webhooks/payload-examples — text (link), image, video, audio, voice (`audio.voice: true`), document, sticker (+ animated), location, contacts, interactive `button_reply` / `list_reply` / `nfm_reply`, template `button`, reaction (+ removed), reply `context`, forwarded, ad `referral`, order, system (number changed), unsupported (`errors`) |
| `statuses-*.json` (sent, delivered, read, played, failed, deleted) | same page (status webhooks with `conversation` / `pricing`, `errors` on failed) |
| `graph-message-sent.json`, `graph-error-window-closed.json`, `graph-error-throughput.json` | whatsapp/cloud-api/reference/messages + support/error-codes (131047, 130429) |
| `graph-media-upload.json`, `graph-media-url.json` | whatsapp/cloud-api/reference/media (upload, retrieve URL — `lookaside.fbsbx.com`) |
| `graph-business-profile.json` | whatsapp/cloud-api/reference/business-profiles |
| `graph-block-users.json`, `graph-unblock-users.json` | whatsapp/cloud-api/block-users |
| `graph-upload-session.json`, `graph-upload-handle.json` | graph-api/guides/upload (resumable upload → handle for the profile photo) |
| `templates-status-*.json` (approved, rejected, paused, disabled) (Phase 11) | whatsapp/webhooks/reference/message_template_status_update (`reason`, `other_info`, `rejection_info`, `disable_info`, `message_template_category`) |
| `templates-quality.json` | whatsapp/webhooks/reference/message_template_quality_update |
| `templates-category-*.json` (pending, changed) | whatsapp/webhooks/reference/template_category_update (pending: `correct_category` + `category_update_timestamp`; done: `previous_category`) |
| `templates-components.json` | whatsapp/webhooks/reference/message_template_components_update |
| `user-preferences-*.json` (stop, resume) | whatsapp/webhooks/reference/user_preferences (`marketing_messages` stop / resume) |
| `webhook-account-update-volume-tier.json` | whatsapp/webhooks/reference/account_update (`VOLUME_BASED_PRICING_TIER_UPDATE`, `volume_tier_info`) |
| `pricing-*.json` (template billable, service free, `paid_exempt` subtype, free entry point) | docs/whatsapp/pricing (status webhook `pricing`) |
| `graph-templates-page1.json`, `graph-templates-page2.json`, `graph-template-created.json` | whatsapp/business-management-api/message-templates (list with paging, create answer) |
| `graph-error-template-exists.json` | same page (code 100, subcode 2388023) |
| `graph-pricing-analytics.json` | whatsapp/business-management-api/analytics (`pricing_analytics` data points) |

`media/sample.{jpg,png,webp,mp4,ogg,pdf}` — tiny generated files (no real content) for sniffing / download tests; `sample.ogg` is a valid mono OGG / Opus (OpusHead, OpusTags, 50 × 20 ms silent packets, CRCs computed).
