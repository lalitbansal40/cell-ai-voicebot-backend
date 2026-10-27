# Audit log

Who did what in an account — an immutable, append-only log (`auditLogs`, [data-model.md](data-model.md) §2.1). Owners and admins read it (`audit.read`, `GET /api/v1/audit-logs`); a daily job deletes entries older than **365 days**.

## Rules

1. Write through `recordAudit()` / `auditRequest(req, action, { target, meta })` (`src/modules/audit/audit.service.ts`). It never throws — a failed write is logged and the request continues.
2. `action` must be one of `AUDIT_ACTIONS` (`src/modules/audit/audit-actions.ts`) — typed, and a test keeps this table identical to the code. New action → add it in both places in the same PR.
3. `meta` holds **no secrets and no PII values**: keys matching `pass|token|secret|code|otp|cookie|authorization|hash` are dropped, e-mail values are masked (`a***@example.com`). Record field **names**, not values (`{ fields: ['timezone'] }`).
4. Actor: `user` (with `impersonatorId` when a superadmin acts as the user), `api_key`, or `system`; `platform: true` marks superadmin actions (suspend / enable).
5. Entries can't be updated or deleted (model hooks); only the purge job deletes, with `{ allowPurge: true }`.

## Actions

| Action                               | Actor             | Target              | Meta                                                                                                                          |
| ------------------------------------ | ----------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `account.created`                    | user (owner)      | account             | —                                                                                                                             |
| `account.updated`                    | user              | account             | `fields`                                                                                                                      |
| `account.ownership_transferred`      | user (old owner)  | user (new owner)    | `from`, `to` (user ids)                                                                                                       |
| `account.suspended`                  | user (platform)   | account             | `reason`                                                                                                                      |
| `account.enabled`                    | user (platform)   | account             | —                                                                                                                             |
| `auth.email_verified`                | user              | user                | —                                                                                                                             |
| `auth.login`                         | user              | —                   | —                                                                                                                             |
| `auth.login_failed`                  | user              | —                   | `reason` (`bad_password`)                                                                                                     |
| `auth.logout`                        | user              | —                   | —                                                                                                                             |
| `auth.logout_all`                    | user              | —                   | —                                                                                                                             |
| `auth.session_revoked`               | user              | session             | —                                                                                                                             |
| `auth.refresh_reuse_detected`        | user              | session             | —                                                                                                                             |
| `auth.password_reset_requested`      | user              | —                   | —                                                                                                                             |
| `auth.password_reset`                | user              | —                   | —                                                                                                                             |
| `auth.password_changed`              | user              | —                   | —                                                                                                                             |
| `team.invited`                       | user              | user (invitee)      | `roleKey`                                                                                                                     |
| `team.invite_resent`                 | user              | user                | —                                                                                                                             |
| `team.invite_revoked`                | user              | user                | `email` (masked)                                                                                                              |
| `team.invite_accepted`               | user (invitee)    | user                | —                                                                                                                             |
| `team.role_changed`                  | user              | user                | `from`, `to` (role keys)                                                                                                      |
| `team.disabled`                      | user              | user                | —                                                                                                                             |
| `team.enabled`                       | user              | user                | —                                                                                                                             |
| `team.removed`                       | user              | user                | `email` (masked)                                                                                                              |
| `apikey.created`                     | user              | api_key             | `name`, `scopes`, `prefix`                                                                                                    |
| `apikey.revoked`                     | user              | api_key             | `name`, `prefix`                                                                                                              |
| `admin.impersonation_started`        | user (platform)   | account             | `ownerId`, `expiresAt`                                                                                                        |
| `admin.impersonation_stopped`        | user (platform)   | account             | —                                                                                                                             |
| `contacts.import_started`            | user              | import_job          | `kind`, `rows`                                                                                                                |
| `contacts.import_completed`          | user / system     | import_job          | `kind`, totals (`created`, `updated`, …)                                                                                      |
| `contacts.import_canceled`           | user              | import_job          | `processed`                                                                                                                   |
| `contacts.exported`                  | user              | export_job          | `scope`, `rows`                                                                                                               |
| `contacts.deleted`                   | user              | contact (single)    | `count`, `mode` (`single` / `ids` / `filter`)                                                                                 |
| `contacts.bulk_updated`              | user              | —                   | `action`, `count`, `mode`                                                                                                     |
| `contact.opted_out`                  | user              | contact             | —                                                                                                                             |
| `dnd.added`                          | user              | dnd_entry (single)  | `count`, `source`                                                                                                             |
| `dnd.removed`                        | user              | dnd_entry           | `optOutCleared`                                                                                                               |
| `custom_field.created`               | user              | custom_field        | `key`, `type`                                                                                                                 |
| `custom_field.updated`               | user              | custom_field        | `key`, `fields`                                                                                                               |
| `custom_field.deleted`               | user              | custom_field        | `key`                                                                                                                         |
| `contact_list.deleted`               | user              | contact_list        | `name`                                                                                                                        |
| `segment.deleted`                    | user              | segment             | `name`                                                                                                                        |
| `wallet.topup_paid`                  | user / system     | topup_order         | `amountMicros`, `invoiceNumber`                                                                                               |
| `wallet.adjusted`                    | user (platform)   | account             | `direction`, `amountMicros`, `reason`                                                                                         |
| `wallet.settings_updated`            | user              | wallet              | `fields`, `from`, `to`                                                                                                        |
| `wallet.credit_limit_updated`        | user (platform)   | wallet              | `from`, `to`                                                                                                                  |
| `billing.profile_updated`            | user              | account             | `fields`                                                                                                                      |
| `rate_card.updated`                  | user (platform)   | rate_card           | `scope`, `changes`                                                                                                            |
| `agent.created`                      | user              | agent               | `name`, `templateKey`                                                                                                         |
| `agent.updated`                      | user              | agent               | `fields` (names only)                                                                                                         |
| `agent.deleted`                      | user              | agent               | `name`                                                                                                                        |
| `agent.duplicated`                   | user              | agent               | `sourceAgentId`, `name`                                                                                                       |
| `agent.activated`                    | user              | agent               | —                                                                                                                             |
| `agent.deactivated`                  | user              | agent               | —                                                                                                                             |
| `kb.created`                         | user              | knowledge_base      | `name`                                                                                                                        |
| `kb.updated`                         | user              | knowledge_base      | `fields`                                                                                                                      |
| `kb.deleted`                         | user              | knowledge_base      | `name`, `unlinkedAgents`                                                                                                      |
| `kb.source_changed`                  | user              | knowledge_base      | `change`, `kind`, `title`                                                                                                     |
| `flow.created`                       | user              | flow                | `name`, `source` (`blank` / `template` / `import` / `duplicate`), `templateKey`                                               |
| `flow.updated`                       | user              | flow                | `fields` (`name` / `description`)                                                                                             |
| `flow.published`                     | user              | flow                | `version`, `notes`, `nodesAdded`, `nodesRemoved`, `nodesChanged`, `edgesChanged`                                              |
| `flow.restored`                      | user              | flow                | `fromVersion`                                                                                                                 |
| `flow.duplicated`                    | user              | flow                | `sourceFlowId`, `name`                                                                                                        |
| `flow.imported`                      | user              | flow                | `name`, `warnings` (count)                                                                                                    |
| `flow.exported`                      | user              | flow                | `version` (number or `draft`)                                                                                                 |
| `flow.archived`                      | user              | flow                | —                                                                                                                             |
| `flow.unarchived`                    | user              | flow                | —                                                                                                                             |
| `flow.deleted`                       | user              | flow                | `name`                                                                                                                        |
| `flow_audio.changed`                 | user              | flow_audio          | `change` (`uploaded` / `renamed` / `deleted`), `name`, `durationMs`                                                           |
| `call.test_started`                  | user              | call                | `source` (`flow` / `agent`), `version` (`draft` / number, flows only)                                                         |
| `call.recording_accessed`            | user              | call                | —                                                                                                                             |
| `call.hung_up_remotely`              | user              | call                | —                                                                                                                             |
| `call.triggered`                     | user              | call                | `source` (`flow` / `agent`), `provider` (`dryrun` …) — single "Call now"                                                      |
| `campaign.created`                   | user              | campaign            | `mode`, `flowId`                                                                                                              |
| `campaign.updated`                   | user              | campaign            | `fields` (names only)                                                                                                         |
| `campaign.scheduled`                 | user              | campaign            | `startAt` (ISO)                                                                                                               |
| `campaign.started`                   | user / system     | campaign            | `contacts` (snapshot size), `flowVersion`                                                                                     |
| `campaign.paused`                    | user / system     | campaign            | `reason` (`manual`, `wallet_empty`, `budget_reached`, `account_suspended`, `too_many_failures`, `flow_not_runnable`, `admin`) |
| `campaign.resumed`                   | user / system     | campaign            | `auto` (true after a top-up); a superadmin lifting an `admin` pause: target account, `campaignId`, `admin: true` (both sides) |
| `campaign.canceled`                  | user              | campaign            | `hangUpLive`                                                                                                                  |
| `campaign.deleted`                   | user              | campaign            | —                                                                                                                             |
| `campaign.exported`                  | user              | campaign            | `format` (`csv` / `xlsx`), `rows`, `includePhone`                                                                             |
| `campaign.admin_paused`              | superadmin        | account             | `campaigns` (count) — written on the account and on the platform account                                                      |
| `account.limits_updated`             | superadmin        | account             | `fields` (`maxConcurrentCalls`, `dialsPerMinute`)                                                                             |
| `whatsapp.channel_connected`         | user / superadmin | whatsapp_channel    | `mode`, `phoneLast4`, `wabaId`, `metaPayer`, `manual` (superadmin manual connect)                                             |
| `whatsapp.channel_reconnected`       | user              | whatsapp_channel    | `mode`, `phoneLast4`, `wabaId`                                                                                                |
| `whatsapp.channel_setup_failed`      | user / system     | whatsapp_channel    | `step`, `reasonCode`                                                                                                          |
| `whatsapp.channel_registered`        | user / system     | whatsapp_channel    | `phoneLast4`                                                                                                                  |
| `whatsapp.credit_line_attached`      | user / system     | whatsapp_channel    | `wabaId` (allocation id kept on the channel)                                                                                  |
| `whatsapp.channel_renamed`           | user              | whatsapp_channel    | —                                                                                                                             |
| `whatsapp.channel_disconnected`      | user / superadmin | whatsapp_channel    | `phoneLast4`, `reason` (superadmin) — superadmin: on the account and on the platform account                                  |
| `whatsapp.channel_status_changed`    | system            | whatsapp_channel    | `from`, `to`, `reasonCode`                                                                                                    |
| `whatsapp.billing_mode_changed`      | superadmin        | account             | `metaPayer` — on the account and on the platform account                                                                      |
| `whatsapp.event_replayed`            | superadmin        | meta_webhook_event  | `field` (platform account)                                                                                                    |
| `meta.deauthorized`                  | system            | account             | `channels` (count)                                                                                                            |
| `meta.data_deletion_requested`       | system            | account             | `channels` (count)                                                                                                            |
| `inbox.conversation_assigned`        | user              | conversation        | `assignedTo` (user id or null), `channelId`                                                                                   |
| `inbox.conversation_closed`          | user              | conversation        | `channelId`                                                                                                                   |
| `inbox.conversation_reopened`        | user              | conversation        | `channelId` (a reopen by an inbound message is not audited)                                                                   |
| `inbox.contact_opted_out`            | system            | contact             | `conversationId`, `channelId`, `kind: 'opt_out'` (never the keyword text)                                                     |
| `inbox.contact_opted_in`             | system            | contact             | `conversationId`, `channelId`, `kind: 'opt_in'`, `dndKept` (a person-added DND entry stays)                                   |
| `inbox.contact_blocked`              | user              | conversation        | `channelId`                                                                                                                   |
| `inbox.contact_unblocked`            | user              | conversation        | `channelId`                                                                                                                   |
| `inbox.history_imported`             | system            | whatsapp_channel    | `conversations`, `messages`, `skippedOld`, `duplicates` (counts)                                                              |
| `inbox.messages_purged`              | system            | account             | `messages`, `media`, `uploads` (counts — retention job)                                                                       |
| `inbox.settings_updated`             | user              | account             | `fields` (names only)                                                                                                         |
| `whatsapp.profile_updated`           | user              | whatsapp_channel    | `fields` (names only), `photo` (boolean)                                                                                      |
| `template.created`                   | user              | whatsapp_template   | `name`, `language`, `category`, `draft` (boolean)                                                                             |
| `template.submitted`                 | user              | whatsapp_template   | `name`, `language`, `category`                                                                                                |
| `template.updated`                   | user              | whatsapp_template   | `name`, `language`, `fields` (names only)                                                                                     |
| `template.deleted`                   | user              | whatsapp_template   | `name`, `language`, `status` (before)                                                                                         |
| `template.synced`                    | system / user     | whatsapp_channel    | `wabaId`, `created`, `updated`, `deleted` (counts), `reason`                                                                  |
| `template.status_changed`            | system            | whatsapp_template   | `name`, `language`, `from`, `to`, `reasonCode`                                                                                |
| `template.category_changed`          | system            | whatsapp_template   | `name`, `language`, `from`, `to`                                                                                              |
| `template.variables_updated`         | user              | whatsapp_template   | `name`, `keys` (variable keys + source kinds, never values)                                                                   |
| `whatsapp.rate_card_saved`           | superadmin        | whatsapp_rate_card  | `source`, `markets` (count), `effectiveFrom` (platform account)                                                               |
| `whatsapp.billing_settings_updated`  | superadmin        | platform_settings   | `fields` (names only) (platform account)                                                                                      |
| `account.whatsapp_billing_updated`   | superadmin        | account             | `fields` (names only) — on the account and on the platform account                                                            |
| `contact.whatsapp_marketing_changed` | system / user     | contact             | `stopped` (boolean), `source` (`user_preferences` / `error_131050` / `manual`)                                                |
| `whatsapp.calling_settings_updated`  | user              | whatsapp_channel    | `fields` (names only), `status`                                                                                               |
| `whatsapp.call_permission_requested` | user              | contact             | `channelId`, `kind` (`interactive` / `template`)                                                                              |
| `whatsapp.call_permission_granted`   | system            | contact             | `channelId`, `permanent` (boolean), `source`                                                                                  |
| `whatsapp.call_permission_declined`  | system            | contact             | `channelId`, `source`                                                                                                         |
| `whatsapp.call_permission_revoked`   | system            | contact             | `channelId`, `reason` (`unanswered` / `meta`), `unanswered` (count)                                                           |
| `call.whatsapp_started`              | user              | call                | `channelId`, `direction`, `mode` (`ai` / `human`)                                                                             |
| `call.whatsapp_answered`             | user              | call                | `channelId`, `ringCount` (count)                                                                                              |
| `call.whatsapp_transferred`          | user / system     | call                | `from` (`ai` / user id), `to` (user id)                                                                                       |
| `whatsapp.calling_restricted`        | system            | whatsapp_channel    | `type`, `until` (ISO or null)                                                                                                 |
| `call.disposition_updated`           | user              | call                | `from`, `to` (outcome keys — never summary text)                                                                              |
| `call.insights_regenerated`          | user              | call                | `version`                                                                                                                     |
| `account.insights_updated`           | user              | account             | `enabled`, `chatSummaryOnClose`, `transcribeHumanCalls` (the changed ones)                                                    |
| `account.dispositions_updated`       | user              | account             | `keys`, `removed`, `inactive` (outcome keys)                                                                                  |
| `account.retention_updated`          | user              | account             | `from`, `to` (`recordingsDays`, `callsDays`, `inboxDays` — numbers / null)                                                    |
| `account.retention_cap_updated`      | user (platform)   | account             | `from`, `to` (`callsDays`, `inboxDays`); both accounts                                                                        |
| `conversation.summary_created`       | user              | conversation        | `summaryId` (never the summary text)                                                                                          |
| `report.exported`                    | user              | —                   | `kind` (`calls` / `messages` / `report`), `format`, `rows` (count), `includePhone`, `includeSummary`                          |
| `report_subscription.created`        | user              | report_subscription | `frequency`, `tabs`, `hour`                                                                                                   |
| `report_subscription.updated`        | user              | report_subscription | the changed fields (`frequency`, `tabs`, `hour`, `active`)                                                                    |
| `report_subscription.deleted`        | user              | report_subscription | —                                                                                                                             |

Contact actions never carry phone numbers, names or variable values in `meta` — counts, ids, keys and list / segment names only (Phase 3).

WhatsApp calling actions (Phase 12) carry ids, kinds and counts — **never** phone numbers, names, SDP, ICE data or DTMF digits.

Template actions carry the template **name / language / category / status / reason code**, counts and changed field names — **never** body text, samples or variable values (Phase 11).

Wallet actions (Phase 4) carry amounts in micros and field **names**; billing profile values (GSTIN, address) are never put in `meta`. `wallet.adjusted` is written on the target account **and** on the platform account.

AI actions (Phase 5) carry field **names** only — never persona / line text, function header values (secrets) or file content. Function changes appear as `functions.<name>.<field>`.

Campaign actions (Phase 8) never carry phone numbers, contact names, variable values or scenario texts — counts, ids, reasons and field **names** only.

Flow actions (Phase 6) never carry node texts, URLs, header values or variable values. Draft graph saves are **not** audited one by one — the `flow.published` row carries the change summary.

Login failures for e-mails that don't exist are not audited (there is no account) — they only count towards the per-email lockout.

## API

`GET /api/v1/audit-logs?limit=50&cursor=…&action=team.*&actorId=…&targetType=user&from=…&to=…` — newest first, cursor pagination (`meta: { nextCursor, hasMore }`), actor names joined. Times are UTC ISO-8601; the dashboard shows them in the account timezone.
