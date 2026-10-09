# Security conventions

Rules for code that talks to the outside world on a client's behalf. Secrets handling in general lives in [secrets.md](secrets.md); this page covers outgoing requests (SSRF) and the secrets those requests carry.

## 1. Outgoing requests (SSRF guard)

Any request whose address a client can influence — AI agent custom functions (Phase 5), knowledge-base URL sources (Phase 5) and anything similar later — goes through `src/core/ai/http-tool.ts` / `src/core/ai/ip-guard.ts`. Never call `fetch` / `axios` with a client-supplied URL.

| Rule            | Detail                                                                                                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheme          | `https` only in production; `http` or `https` elsewhere. No user name / password in the URL.                                                                                                                                                                                                         |
| Ports           | 80, 443, 8000–8999. Outside production also the backend port (5100 / 3100, for the dev mock API).                                                                                                                                                                                                    |
| DNS first       | The host is resolved **before** connecting (`dns.lookup(host, { all: true })`); **every** address must pass — a mixed answer (public + private) is refused.                                                                                                                                          |
| Pinned connect  | The request connects to the checked IP (TLS still verifies the host name via SNI) — no DNS-rebinding window.                                                                                                                                                                                         |
| Always blocked  | `0.0.0.0/8`, `169.254.0.0/16` (cloud metadata), `224.0.0.0/4`, `240.0.0.0/4`, `255.255.255.255`, `::`, `fe80::/10`, `ff00::/8` — even when private hosts are allowed.                                                                                                                                |
| Private ranges  | `10/8`, `100.64/10`, `127/8`, `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, `::1`, `fc00::/7`, `localhost` — blocked unless `AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS=true` (default outside production; the env refuses it in production). IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is checked as IPv4. |
| Redirects       | Manual, at most 2; every hop is re-checked. Secret / custom headers are dropped when a redirect leaves the origin; 301 / 302 / 303 become `GET` without a body.                                                                                                                                      |
| Caps            | Time limit per function (1–10 s, the whole call incl. redirects); response body cut at 64 KB (`too_large`); the model sees at most 2,000 characters.                                                                                                                                                 |
| Save-time check | Function URLs are checked when saved (scheme, port, literal IPs, `localhost`, no placeholders in the host) → `422 FUNCTION_URL_BLOCKED`. Names are checked again at call time.                                                                                                                       |
| Errors          | Request problems are **tool results** (`{ ok: false, error: 'blocked' \| 'timeout' \| 'too_large' \| 'invalid_json' \| 'network' \| 'too_many_redirects' \| 'invalid_request' \| 'secret_unavailable' \| 'http_<status>' }`), never thrown to the user.                                              |
| Tests           | No network: a local stub server, a fake resolver (`resolve`) and a dial map (`dial`, fake public IP → stub) are injected (`AppDeps.aiHttp`). The SSRF table runs in production and development policy.                                                                                               |

## 2. Templates in requests

- Placeholders: `{{args.x}}` (from the model, validated by the function's parameter list first), `{{contact.x}}` (any contact field — full phone / external id are filled **server-side** and never sent to the model), `{{agent.name}}`, `{{company}}`. Unknown placeholders and undeclared `args` are refused at save time.
- URL: every value is URL-encoded, so a value can never change the path / query structure or the host.
- Body: rendered on the parsed JSON tree (never string concatenation); a leaf that is exactly one placeholder keeps the value's JSON type.
- Headers: plain text; CR / LF / NUL after rendering is refused (header injection). `Host`, `Content-Length`, `Content-Type`, `Connection`, `Transfer-Encoding` are set by the executor and cannot be configured.

## 3. Secrets inside requests

- Header values marked `secret` are sealed with `src/core/ai/secret-box.ts` (AES-256-GCM, key derived from `ENCRYPTION_KEY`) and opened only in memory for the request.
- The API is write-only for them: responses show `valueHint` (`••••1234`); a PATCH with `value: null` keeps the stored value, a new string replaces it.
- Never in logs, audit meta (`agent.updated` lists field names only), tool-call logs (no headers; arguments and the 500-char preview are redacted — phone-like numbers keep the last 4 digits, e-mail local parts masked), playground traces, exports, OpenAPI examples or test snapshots. A test greps every captured response, audit row and tool-call row for the secret values.

## 4. Dev-only mock APIs

`GET /api/v1/mock/payment-status` stands in for a client's payment API so templates and E2E work without one. It is mounted only when `MOCK_APIS_ENABLED=true` (default outside production; the env refuses it in production → the route is a 404) and needs no auth. Its data (`mockPaymentRecords`) is dev data, not tenant data.
