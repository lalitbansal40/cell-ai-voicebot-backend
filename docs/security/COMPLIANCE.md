# Compliance rules

Where each rule lives, the test that proves it, and what the client's legal team must confirm. These rules are settings and product behavior, not legal advice.

| Rule                                                                           | Code                                                                                 | Test                                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Calling window (account timezone, first and last minute, closed days)          | `modules/campaigns/{window,dial-guard}.ts`, `modules/whatsapp-calling/dial-guard.ts` | `tests/compliance/matrix.test.ts`, `tests/campaigns/dial-guard.test.ts`, `tests/calls-wa/outbound.test.ts` |
| Widest window an account may save                                              | `modules/compliance/compliance.service.ts`                                           | `tests/compliance/compliance.test.ts`                                                                      |
| Do-not-call, opt-out and suppression on calls                                  | `isPhoneOnDnd`, `decideDial`, `checkDial`                                            | `tests/compliance/matrix.test.ts`, `tests/privacy/erase-leak.test.ts`                                      |
| Opt-out words (Hindi, Hinglish, English)                                       | `modules/inbox/keywords.ts`                                                          | `tests/compliance/compliance.test.ts`, `tests/inbox/inbox-routes.test.ts`                                  |
| "Don't call me" on a call                                                      | Disposition `do_not_call` → `applyVoiceOptOut`                                       | `tests/compliance/compliance.test.ts`                                                                      |
| AI disclosure at call start                                                    | `core/ai/compile.ts`, `aiDisclosureEnabled`                                          | `src/core/ai/compile.test.ts`                                                                              |
| Recording notice                                                               | `recordingNotice`, `modules/calls/call.service.ts`                                   | `tests/calls/session.test.ts`                                                                              |
| Marketing frequency (1 per contact per 24 h)                                   | `assertMarketingFrequency`                                                           | `tests/templates/send.test.ts`                                                                             |
| 24-hour WhatsApp window                                                        | `assertCanSend`                                                                      | `tests/inbox/outbound.test.ts`                                                                             |
| Marketing consent: warning by default, refusal with `requireOptInForMarketing` | `consentWarnings`                                                                    | `tests/compliance/compliance.test.ts`                                                                      |
| Suppressed numbers on import and API                                           | `modules/privacy/suppression.ts`                                                     | `tests/privacy/erase-leak.test.ts`                                                                         |

## For the client's legal team to confirm

These are defaults so the product can run. Nothing here is decided by this code.

- The widest calling window: `08:00` to `19:00`, plan §7 #8. A superadmin can change it.
- Whether marketing templates must have recorded consent, plan §7 #7. Default: send with a warning.
- Retention periods and the wording of the Privacy Policy and Terms, which stay `status: draft`, plan §7 #9.
- What a flow must set for "don't call me": the disposition `do_not_call` adds the number to the do-not-call list. A flow that doesn't set it adds nothing, so scripts must be reviewed.
