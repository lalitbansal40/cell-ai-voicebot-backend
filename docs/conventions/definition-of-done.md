# Definition of Done

A task / PR is **done** only when every item below is true.

- [ ] `npm run lint` passes (0 errors, 0 warnings)
- [ ] `npm run typecheck` passes
- [ ] Tests added for new logic, and `npm test` passes
- [ ] `npm run build` passes
- [ ] New env vars added to `.env.example` (with comment + phase) and the README env table
- [ ] Docs / README updated for any new behaviour, script or convention
- [ ] No secrets in code, docs, commits or logs
- [ ] Tenant scoping: every DB query is scoped by `accountId` (Phase 1+)
- [ ] PR template filled (what, why, how tested, screenshots for UI)
- [ ] Follows the conventions: [API](api.md), [error codes](error-codes.md), [WebSocket](websocket.md), [data](data.md), [code style](code-style.md)
- [ ] Reviewed and merged into `dev`
