# Public API docs (DOCS) — local sign-off

5 Nov 2026. **Implemented and verified locally.** Branch `feature/public-api-docs` in both
repos; nothing pushed, merged or deployed. Prompt: [PUBLIC_API_DOCS_PROMPT.md](../prompts/PUBLIC_API_DOCS_PROMPT.md).

## Tasks

| Task                                                                                         | Result                                                                                                          |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| T1 audit script, quality guard, route matrix fix (`calling/quote`)                           | ✅                                                                                                              |
| T2 `/resources/*` (8 read-only routes), scope `resources:read`                               | ✅ — new paths under `/resources` instead of opening dashboard routes (no clash with dashboard views / OpenAPI) |
| T3 WhatsApp bulk campaigns with keys, 2 scopes, 2 webhook events, `campaign.completed.line`  | ✅ — also fixed `createdBy` / audit actor for API keys                                                          |
| T4 every public route documented (72): operationId, description, `x-scope`, examples, errors | ✅ — `POST /campaigns/{id}/estimate` opened to keys; 3 named examples on `POST /campaigns`                      |
| T5 16 guides, generated scope / error tables                                                 | ✅                                                                                                              |
| T6 docs page download bar + options, Postman collection, in-app links                        | ✅ — nginx unchanged (`/api/` already proxied)                                                                  |
| T7 examples smoke                                                                            | ✅ 72 / 72 (43 answered 2xx and matched their schema)                                                           |
| T8 changelogs, conventions, DATA_MAP, release note                                           | ✅                                                                                                              |
| T9 final checks                                                                              | ✅ with the notes below                                                                                         |

## Final checks

- Backend: lint ✅, typecheck ✅, build ✅, `openapi:check` ✅ (after formatting `postman.json` with the repo config).
- Backend suite: the in-memory MongoDB dropped mid-run (`ECONNREFUSED`, 129 files cascaded). Rerun of those files: 123 passed; the other 5 heavy files passed serially. Remaining: `tests/whatsapp-campaigns/campaigns.test.ts` recurrence case — clock-dependent, fails on `main` too.
- Frontend: lint ✅, build ✅, suite 1582 / 1583 — `inbox-page.test.tsx` "Retry a failed send" fails on `main` too.
- `npm run docs:audit`: 72 operations, 0 problems. `npm run docs:smoke`: 72 / 72.

## Live checks (after deploy)

Open `/api/docs` on production (public mode), download OpenAPI and Postman, call `whoami` and
`GET /resources/flows` with a real key that has `resources:read`.
