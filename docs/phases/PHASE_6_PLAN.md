# Phase 6 — Call Flow Engine & Builder — Detailed Plan

**Status:** ready to start · **Prev:** [Phase 5 sign-off](PHASE_5_SIGNOFF.md) · **Source:** [BUILD_PLAN §Phase 6](../plans/BUILD_PLAN.md) · **Tracker:** [PHASE_6_TASKS.md](PHASE_6_TASKS.md)
**Branch:** `feature/phase-6-flows` (both repos, from `main` with Phase 5 merged — backend `4038c8b`, frontend `603ae49`) · **Commit tag:** `[P6-T6.x]`, checkpoints `[P6-Bx-DONE]`

---

## 0. Is phase ka goal

Phase 6 ke end tak client apna **call flow** (IVR + AI) ek visual **builder** mein bana sake — nodes drag-drop karke, edges se branches jodkar — use **validate → publish** kare (versions ke saath), aur ek **text simulator** mein har branch chala kar dekh sake. Yahi **flow engine** Phase 7 (live voice call), Phase 8 (campaigns), Phase 10 (API trigger) aur Phase 14 (inbound) seedha use karenge — engine ek baar banega, har channel par same chalega.

1. **Flow** per account — naam, description, settings (default language, error message, max duration), declared **flow variables**, status `draft | published | archived`.
2. **Versions** — ek editable **draft** (optimistic `revision`), har publish ek **immutable version** (v1, v2 …); purana version draft mein restore; campaigns (Phase 8) ek version pin karenge.
3. **15 node types** — `start`, `speak`, `play_audio`, `gather_dtmf`, `gather_speech`, `ai_agent`, `api_request`, `condition_router`, `set_variable`, `set_disposition`, `transfer_to_agent`, `send_sms`, `send_whatsapp`, `wait`, `hangup` — har node ke **named exits** (handles), har node par `error` exit.
4. **Engine (interpreter)** — event-driven state machine: input (DTMF / speech / silence / timer / transfer result) → nodes chalao jab tak koi node customer ka wait na kare → outputs (say / play / listen / transfer / hangup). Side effects (API call, AI turn, intent AI) **injected** — simulator aur Phase 7 voice same engine.
5. **Safety** — loop guard (steps / visits / auto-steps), har node ka error exit + flow-level error handler, max duration, per-node **trace**, **node analytics** (entered / exits / errors / time).
6. **Validation** — start missing, dangling / unreachable nodes, unconnected required exits, unconfigured nodes, unknown variables, missing agent / audio, silent loops, unsafe URLs, no ending — **publish blocked** on errors.
7. **AI agent node** — Phase 5 agent, step goal, max turns; agent ke built-in tool **outcomes → exits** (`paid`, `promise_to_pay`, `callback`, `transfer`, `wrong_number`, `resolved`, `no_response`, `error`); outcome flow variables mein.
8. **API request node** — client system call (Phase 5 SSRF-safe executor, encrypted secret headers), response → variables, `success / failure / error` exits.
9. **Text simulator** — speak = text bubble, audio = player card, DTMF = keypad buttons, speech = text box, silence / transfer result buttons; AI node par asli agent turn (fake / OpenAI provider, wallet charge); trace + variables + outcome live; canvas par current node highlight.
10. **Templates** — Loan recovery, Payment reminder, Feedback survey, Inbound support (graph + texts ready, agent picker).
11. **Builder (frontend, `@xyflow/react`)** — palette, custom nodes with labelled exits, inspector forms per node, variable picker, edge rules, validation panel, auto-layout, undo / redo, copy / paste, save / publish / versions / duplicate / import / export JSON, simulator panel, node stats overlay.
12. **Audio library** — `play_audio` ke liye MP3 / WAV upload (size + duration checked), browser preview.

**Done when (BUILD_PLAN):** Loan recovery flow builder mein bane aur simulator mein **har branch (1 press, 2 press, AI path) chale** — **Playwright se proven** (fake AI provider + mock payment API), plus no-input / invalid-key branches.

### Phase 6 mein kya NAHI hoga

| Kaam                                                                               | Kaunse phase mein                                                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Real audio: TTS for `speak`, playing uploaded audio on a call, DTMF tone detection | Phase 7 — Phase 6 engine outputs `say` / `play` / `listen_*` actions; simulator shows them as text     |
| Live call sessions (Redis state, call lifecycle, Web Call Tester, recording)       | Phase 7 — Phase 6 gives a serialisable `FlowRunState` + `advance()`                                    |
| Real human transfer (SIP REFER / bridge)                                           | Phase 13 — Phase 6 `transfer_to_agent` returns a `transfer` action; simulator asks "answered / failed" |
| Real SMS / WhatsApp sending, DLT template registration, payment links              | Phase 10 — Phase 6 records **queued post-call messages** on the run                                    |
| Campaign picking a flow version, calling windows, retries                          | Phase 8 — Phase 6 gives `publishedVersionId` + `isFlowInUse()` hook (stub)                             |
| Inbound number → flow mapping, API-triggered calls                                 | Phase 14 / Phase 10 — Phase 6 stores `start.triggers` + validates                                      |
| Call reports per flow / node analytics on live calls, Excel export of node stats   | Phase 9 — Phase 6 counts stats (simulator now, `call` mode later) and shows a canvas overlay           |
| Multi-user live co-editing (cursors, merge)                                        | Never (scope) — one draft, optimistic revision, conflict dialog                                        |
| Sub-flows / "go to flow" node, A/B split node, schedule / business-hours node      | Later (Phase 14 inbound candidate) — open question §7                                                  |
| Visual diff between versions                                                       | Later — versions are viewable read-only + restorable                                                   |
| Post-call waits (hours / days), follow-up call scheduling                          | Phase 8 (campaign retries, callback scheduling) — `wait` is an in-call pause only                      |
| Public API for flows                                                               | Phase 10                                                                                               |

### Conventions to follow

- Same as Phases 1–5: zod → OpenAPI (ADR 0029), tenant-scoped models (`accountId` from auth only), audit service, `idempotency()` where money moves, money in **micros** via the Phase 4 engine only (`chargeUsage`), no secrets / PII / prompts / customer text in logs, every external call with timeout + error log (BUILD_PLAN §7).
- Engine code is **pure where possible** (graph schema, validator, condition evaluator, templating, interpreter core) — side effects only through an injected `FlowEffects` object → table tests without Mongo.
- Text an LLM reads (API results, customer speech, flow variables) is **data, never instructions** (Phase 5 framing).
- Every page: loading / error (retry) / empty states, permission-aware actions, keyboard accessible, labels, works at 375 px (builder editing needs ≥ 900 px — smaller screens get a read-only view, §1l).
- Real bugs found while building → separate `fix(...)` commit with a regression test. Tests never touch the network; timeouts are never raised (split tests instead).

---

## 1. Locked decisions (pehle se tay — implementation me dobara debate nahi)

### 1a. Flow & versions model

| Area          | Decision                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Flow`        | `{ accountId, name (1–80, unique per account case-insensitive among non-deleted), description (≤ 300), status: draft \| published \| archived, draft: FlowGraph, revision (int, +1 per save), publishedVersionId?, publishedVersion (number \| null), hasUnpublishedChanges, templateKey?, stats { nodes, agents[] }, createdBy, updatedBy, timestamps, deletedAt }`                |
| Draft         | **Embedded** on the flow (`draft = { nodes, edges, variables, settings, viewport }`) — one document, one write; **deviation from data-model §2.4** (`draftVersionId`) — data-model updated in T6.1. `PUT /flows/:id/draft { revision, graph }` succeeds only when `revision` matches → else **409 `FLOW_REVISION_CONFLICT`** with the current revision + `updatedBy` / `updatedAt`. |
| `FlowVersion` | `{ accountId, flowId, version (1, 2, … unique per flow), graph (snapshot), checksum (sha256 of canonical JSON), notes (≤ 200), agentIds[], audioIds[], publishedBy, publishedAt }` — **immutable** (no update route; model hooks refuse updates). All versions kept (campaigns / calls pin them).                                                                                   |
| Publish       | `POST /flows/:id/publish { revision, notes? }` → validate draft (§1e) → errors → 422 `FLOW_INVALID` with `details.issues[]` → else new version, `status = published`, `publishedVersionId`, `hasUnpublishedChanges = false`. Same checksum as the latest version → 409 `CONFLICT_INVALID_STATE` ("Nothing changed since v3").                                                       |
| Restore       | `POST /flows/:id/versions/:version/restore { revision }` → copies the version graph into the draft (revision +1, `hasUnpublishedChanges` recomputed by checksum). Rollback = restore + publish.                                                                                                                                                                                     |
| Archive       | `archive` → `status = archived` (hidden from Phase 8 pickers; pinned campaigns / running calls keep working); `unarchive` → back to `published` (or `draft` if never published).                                                                                                                                                                                                    |
| Delete        | Soft delete (`deletedAt`), name freed; refused **409 `RESOURCE_IN_USE`** when `isFlowInUse(flowId)` (Phase 8 hook, stub → false; Phase 14 inbound numbers too). Purge after 30 days (versions, simulator runs, stats, unused audio) — `flows.purge` cron.                                                                                                                           |
| Duplicate     | Copies the **draft** only (name "… (copy)", unique suffix), status draft, no versions, same audio ids (audio is account-level).                                                                                                                                                                                                                                                     |
| Limits        | `FLOW_LIMITS` (new in `config/limits.ts`): 100 flows / account, 150 nodes, 300 edges, graph ≤ 512 KB JSON, 50 flow variables, exact numbers per node in §1d.                                                                                                                                                                                                                        |

### 1b. Graph format (`FlowGraph`, `schemaVersion: 1`)

```ts
interface FlowGraph {
  schemaVersion: 1;
  nodes: FlowNode[]; // ≤ 150
  edges: FlowEdge[]; // ≤ 300
  variables: FlowVariable[]; // ≤ 50
  settings: FlowSettings;
  viewport?: { x: number; y: number; zoom: number }; // builder only, ignored by the engine
}
interface FlowNode {
  id: string;
  type: NodeType;
  label?: string;
  position: { x: number; y: number };
  config: NodeConfig[type];
}
interface FlowEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
}
interface FlowVariable {
  name: string;
  type: 'text' | 'number' | 'boolean' | 'date';
  label?: string;
  default?: string | number | boolean | null;
}
interface FlowSettings {
  language: 'hi' | 'en' | 'hinglish'; // default for speak / speech nodes
  voice: AgentVoice; // Phase 5 voice list — Phase 7 TTS voice
  errorMessage: string; // ≤ 300, spoken by the flow error handler
  onError: 'hangup' | 'transfer'; // after the error message
  errorTransferPhone?: string; // E.164, required when onError = transfer
  maxDurationSec: number; // 60–3,600, default 900 (engine ends with reason max_duration)
}
```

- **Ids:** node / edge ids `^[A-Za-z0-9_-]{1,40}$`, unique in the graph (builder makes `n_<nanoid8>` / `e_<nanoid8>`).
- **Exits are handles, not free-text conditions.** Every node type declares its exits (§1d); an edge connects one `sourceHandle` (exit key) to a target node. **At most one edge per (source, sourceHandle)**; many edges may enter a node; self-loops allowed only into waiting nodes (validated as loops, §1e).
- Dynamic handles: `key_<digit>` (DTMF), `intent_<id>` (speech), `rule_<id>` (router) — ids `^[a-z0-9]{1,12}$`, generated by the builder, kept stable when labels change.
- Unknown node types / extra keys → 422 (`z.strictObject` everywhere). Positions are numbers within ±100,000.
- **Canonical JSON** (sorted keys, no viewport) for checksums, export and "changed since publish".

### 1c. Variables & templating

- **One flat namespace** in every `{{…}}` template (speak text, prompts, SMS, conditions, API templates): `{{name}}`, `{{amount}}`, `{{promise_date}}` — matches Phase 5 agent variables and BUILD_PLAN.
- **Sources, in resolution order:**
  1. **Contact (read-only):** built-ins `name`, `phone_last4` + every custom field key (Phase 3), formatted for reading like Phase 5 `contactVariables` (₹ amounts, readable dates).
  2. **Flow variables** declared in `graph.variables` — must not collide with contact keys or system names (validation error `variable_name_taken`).
  3. **System (read-only, set by the engine):** `company`, `today` (account timezone, `YYYY-MM-DD`), `now_time` (`HH:mm`), `last_dtmf`, `last_speech`, `last_intent`, `last_api_status`, `disposition`, `promise_date`, `promise_amount`, `callback_date`, `callback_time`, `transfer_result`.
- **Server-only tokens:** `{{contact.phone}}` (full E.164) and `{{contact.external_id}}` are allowed **only** inside `api_request` URL / headers / body (validation error `contact_token_not_allowed` anywhere spoken / sent to the customer / to the AI). Never logged.
- **Typed values** in the run (`string | number | boolean | null`); rendering converts to text; conditions compare typed (§1d router).
- **Templating code:** Phase 5 `http-tool.ts` renderer is generalised into `core/templating/` (`renderText`, `renderUrl`, `renderJson`, `templateTokens`) with a pluggable token resolver; Phase 5 behaviour unchanged (its tests stay green), flows plug in their resolver. Missing value → `""` + run warning `missing_variable:<name>` (trace), never an exception.
- **Variable picker catalogue** endpoint returns contact fields + flow variables + system variables with types and labels (`GET /flows/:id/variables`).

### 1d. Node catalogue (15 types)

`error` exit exists on **every** node (except `start` / `hangup`); unconnected → flow error handler (`settings.errorMessage` → `onError`). "Waits" = the engine stops and waits for an input.

| Type                | Config (all validated; limits in `FLOW_LIMITS`)                                                                                                                                                                                                                                                                                                                                          | Exits                                                                                                                 | Waits                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `start`             | `triggers: ('campaign' \| 'inbound' \| 'api' \| 'test')[]` (≥ 1, default all four) — exactly one start node, no incoming edges                                                                                                                                                                                                                                                           | `next`                                                                                                                | no                              |
| `speak`             | `text` (1–1,000, `{{vars}}`), `language: 'flow' \| hi \| en \| hinglish`, `interruptible` (default true — Phase 7 barge-in)                                                                                                                                                                                                                                                              | `next`, `error`                                                                                                       | no (Phase 7 waits for playback) |
| `play_audio`        | `audioId` (account audio, §1h), `fallbackText?` (≤ 500, spoken if the file is missing)                                                                                                                                                                                                                                                                                                   | `next`, `error`                                                                                                       | no                              |
| `gather_dtmf`       | `prompt { kind: speak \| audio, text?, audioId? }`, `mode: menu \| digits`; **menu:** `keys [{ id, key 0-9*#, label }]` (1–12, unique keys), `repeatKey?` (replays the prompt); **digits:** `minDigits 1–20`, `maxDigits 1–20`, `finishKey: '#' \| none`, `saveAs` (flow var); `timeoutSec 3–30` (7), `maxRetries 0–5` (2), `invalidText`, `noInputText` (≤ 300 each, defaults Hinglish) | menu: `key_<id>` per key, `no_input`, `invalid`, `error`; digits: `next`, `no_input`, `invalid`, `error`              | **yes** (dtmf)                  |
| `gather_speech`     | `prompt` (as above), `saveAs` (flow var, text), `language: 'flow' \| hi \| en \| hinglish \| auto`, `timeoutSec 3–30` (8), `maxRetries 0–5` (2), `noInputText`, `intents [{ id, label, keywords[] (≤ 20 × ≤ 60) }]` (≤ 10), `matchMode: keywords \| ai`                                                                                                                                  | no intents: `next`, `no_input`, `error`; with intents: `intent_<id>` each, `no_match`, `no_input`, `error`            | **yes** (speech)                |
| `ai_agent`          | `agentId` (Phase 5 agent of the account), `goal?` (≤ 1,000 — "this step" instructions appended to the persona), `passVariables[]` (flow vars the AI may see, ≤ 10), `maxTurns 1–50` (20), `speakOpeningLine` (default true)                                                                                                                                                              | `paid`, `promise_to_pay`, `callback`, `transfer`, `wrong_number`, `resolved` (required), `no_response`, `error` — §1g | **yes** (speech, per turn)      |
| `api_request`       | `method GET\|POST\|PUT\|PATCH`, `url` (template; host never templated), `headers [{ name, value, secret }]` (≤ 10, secret sealed — Phase 5 rules), `bodyTemplate?` (JSON template), `timeoutMs 1,000–10,000` (6,000), `saveResponse [{ path (dot path ≤ 5 levels), variable }]` (≤ 10), `successStatuses: '2xx'`                                                                         | `success`, `failure` (non-2xx), `error` (timeout / blocked / network / bad JSON)                                      | no                              |
| `condition_router`  | `rules [{ id, label, match: all \| any, conditions [{ variable, operator, value? }] (1–5) }]` (1–10, evaluated **in order**, first true wins); operators `equals, not_equals, contains, not_contains, starts_with, gt, gte, lt, lte, is_empty, is_not_empty, in_list, date_before, date_after`; `value` is a template                                                                    | `rule_<id>` each, `else` (required)                                                                                   | no                              |
| `set_variable`      | `assignments [{ variable (flow var), op: set \| increment \| clear, value? (template, coerced to the var type) }]` (1–10)                                                                                                                                                                                                                                                                | `next`, `error` (coercion failure)                                                                                    | no                              |
| `set_disposition`   | `disposition` (Phase 5 enum: `paid, promise_to_pay, callback_requested, wrong_number, refused_to_pay, dispute, not_interested, language_barrier, other`), `note?` (≤ 200, template) — last one wins on the run                                                                                                                                                                           | `next`                                                                                                                | no                              |
| `transfer_to_agent` | `phone` (E.164 IN, or `{{var}}` holding one), `announcement?` (≤ 300, spoken before transferring), `timeoutSec 10–60` (30)                                                                                                                                                                                                                                                               | `connected` (run ends, reason `transferred`), `failed`, `no_answer`, `error`                                          | **yes** (transfer result)       |
| `send_sms`          | `text` (1–500, template, `{{contact.*}}` refused), `dltTemplateId?` (≤ 30) — **queued post-call** (Phase 10 sends), never blocks the call                                                                                                                                                                                                                                                | `next`                                                                                                                | no                              |
| `send_whatsapp`     | `templateName` (≤ 60), `language` (`hi`/`en`), `params[]` (≤ 10 templates) — queued post-call like SMS                                                                                                                                                                                                                                                                                   | `next`                                                                                                                | no                              |
| `wait`              | `seconds 1–60` — in-call pause (silence); simulator skips instantly with a trace note                                                                                                                                                                                                                                                                                                    | `next`                                                                                                                | **yes** (timer)                 |
| `hangup`            | `text?` (≤ 500 goodbye line), `disposition?` (sets it if none yet)                                                                                                                                                                                                                                                                                                                       | — (terminal)                                                                                                          | ends                            |

**Gather retry semantics (both gathers):** timeout → if retries left: say `noInputText` + replay prompt, else `no_input` exit; invalid key / digits / no intent match (with intents) → if retries left: say `invalidText` + replay, else `invalid` / `no_match` exit. `repeatKey` never counts as a retry. Retries are per node **visit**. The pressed key / digits → `last_dtmf` (+ `saveAs`); recognised text → `last_speech` (+ `saveAs`), matched intent id → `last_intent`.

**Intent matching:** `keywords` mode is deterministic — text normalised (lower case, Unicode NFKC, punctuation stripped, Devanagari kept), whole-word / phrase match, first intent in order wins. `ai` mode asks the text model to classify into the intent ids or `none` (JSON-only reply, temperature 0, ≤ 50 output tokens, customer text in a data block) — billed like a playground turn (§1k); provider failure → keywords fallback, then `no_match`. The fake provider classifies by keyword overlap (deterministic).

### 1e. Validation (pure `validateFlow(graph, ctx) → Issue[]`)

`Issue = { severity: 'error' | 'warning', code, message, nodeId?, edgeId?, field? }` — returned by every draft save (`issues[]`), by `POST /flows/:id/validate` and by a failed publish. **Publish needs zero errors**; warnings allowed. The **server is the single source** of validation; the builder only does instant **local structural checks** (handles, dangling nodes) for UX and shows the server issues after each save.

| Code                                                   | Severity        | Rule                                                                                                                                                                                                      |
| ------------------------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start_missing` / `start_multiple` / `start_has_input` | error           | exactly one `start`, no incoming edges                                                                                                                                                                    |
| `node_unreachable`                                     | error           | every node reachable from start ("dangling node")                                                                                                                                                         |
| `exit_required`                                        | error           | required exits connected: `next`, every `key_*` / `intent_*` / `rule_*`, `else`, `resolved`, `success`; optional: `error`, `no_input`, `invalid`, `no_match`, `failure`, other AI exits (fallbacks below) |
| `no_ending`                                            | error           | at least one path from start reaches `hangup` or `transfer_to_agent`                                                                                                                                      |
| `node_unconfigured` (+ `field`)                        | error           | config fails the node schema (empty text, no keys, no agent …)                                                                                                                                            |
| `edge_invalid`                                         | error           | unknown source / target / handle, duplicate handle edge, edge into `start`                                                                                                                                |
| `variable_unknown` (+ name)                            | error           | `{{x}}` / condition / `saveAs` not in the catalogue (§1c)                                                                                                                                                 |
| `variable_name_taken`                                  | error           | flow variable collides with a contact / system name                                                                                                                                                       |
| `contact_token_not_allowed`                            | error           | `{{contact.*}}` outside `api_request`                                                                                                                                                                     |
| `agent_missing` / `agent_inactive`                     | error / warning | agent deleted / not in account → error; turned off → warning (runtime → `error` exit with `fallback.agentOff`)                                                                                            |
| `audio_missing`                                        | error           | audio deleted / not ready                                                                                                                                                                                 |
| `dtmf_duplicate_key` / `dtmf_repeat_conflict`          | error           | keys unique, `repeatKey` not a menu key                                                                                                                                                                   |
| `silent_loop`                                          | error           | a cycle made only of non-waiting nodes (it would never wait for the customer) — detected with SCCs                                                                                                        |
| `url_blocked`                                          | error           | `api_request` URL fails the Phase 5 static address rules (scheme / literal private IP / metadata / port)                                                                                                  |
| `transfer_phone_invalid`                               | error           | not E.164 IN and not a single known `{{var}}`                                                                                                                                                             |
| `error_exit_unconnected`                               | warning         | (info-level) node errors go to the flow error handler                                                                                                                                                     |
| `sms_long` / `speak_long`                              | warning         | SMS > 160 chars (multi-part) / speak > 400 chars (long for a call)                                                                                                                                        |
| `limits_exceeded`                                      | error           | node / edge / variable / size limits                                                                                                                                                                      |

### 1f. Engine — interpreter (`core/flow/engine.ts`)

- **Shape:** `advance(graph, state, input, effects, ctx) → Promise<{ state, outputs[], waiting }>` — runs from the current position until a **waiting** node or the end. `state` (`FlowRunState`) is plain JSON (Phase 7 keeps it in Redis, the simulator in Mongo).
- **`FlowRunState`:** `{ status: 'running' | 'waiting' | 'ended', nodeId, waitingFor: null | 'dtmf' | 'speech' | 'ai' | 'transfer' | 'timer', retries, visits { [nodeId]: n }, steps, autoSteps, variables { … }, outcome { disposition, dispositionNote, promiseToPay, callback, transfer, messages[] }, ai: { nodeId, agentId, turns[], turnCount } | null, startedAt, endedAt?, endReason? }`.
- **Inputs:** `start { trigger }`, `dtmf { digits }`, `speech { text }`, `no_input`, `timer`, `transfer_result { result: connected | failed | no_answer }`, `hangup` (customer hung up → `endReason: customer_hangup`).
- **Outputs (actions for the host):** `say { text, language, voice, interruptible }`, `play { audioId, fallbackText }`, `listen_dtmf { timeoutSec, maxDigits, finishKey }`, `listen_speech { timeoutSec, language }`, `ai_reply { text, toolCalls, knowledge, costMicros }`, `transfer { phone, timeoutSec }`, `message_queued { channel, preview }`, `pause { seconds }`, `hangup { reason }`, plus `trace` entries (§ below).
- **`FlowEffects` (injected):** `callApi(spec)` (Phase 5 SSRF-safe executor + secrets), `aiTurn({ agent, session, userText, goal, variables })` (wraps `runAgentTurn`), `classifyIntent(...)`, `loadAgent(id)`, `loadAudio(id)`, `now()`. Simulator, tests (fakes) and Phase 7 pass their own.
- **Loop guard:** `steps ≤ 300` per run, `visits[node] ≤ 25`, `autoSteps ≤ 50` between two inputs (non-waiting chain) → run ends with `endReason: loop_guard` after the flow error message. `maxDurationSec` checked on every input (`endReason: max_duration`).
- **Errors:** a node failing (bad coercion, API error, AI failure, missing agent / audio at runtime) → its `error` exit if connected, else **flow error handler** (say `errorMessage` → hangup or transfer). Engine bugs (exceptions) are caught → `endReason: engine_error`, logged with run id + node type only.
- **Trace:** every step adds `{ seq, at, nodeId, type, event: entered | exited | error | input | output, handle?, durationMs?, detail? }` — detail is redacted (no customer text in call mode, phones masked; simulator may show texts to its own user). ≤ 600 trace rows per run (then a "trace truncated" row).
- **Node analytics:** on exit `FlowNodeStats` `$inc` `{ flowId, version (or 'draft'), nodeId, day (account tz), mode: simulator | call }` → `entered`, `exits.<handle>`, `errors`, `totalMs`. Builder overlay reads them (§1l).
- **Determinism:** same graph + inputs + effect results → same outputs (tested); no `Math.random`, time only from `effects.now()`.
- **Performance target:** `advance` of a 150-node graph with no effects ≤ 2 ms p95 (bench in T6.9).

### 1g. `ai_agent` node (Phase 5 contract)

- **Entry:** load the agent (account-scoped; deleted → `error`), compile with `compileAgent(agent, { company, variables: allowed contact vars + passVariables, channel: 'text' (simulator) | 'voice' (Phase 7), now, timezone, extraInstructions: goal })` — **`extraInstructions`** is a new optional `CompileOptions` field (a `## Task in this step` block after the persona; snapshot tests added, existing snapshots unchanged). Opening line output (no model call) unless `speakOpeningLine = false`.
- **Turns:** each `speech` input → `runAgentTurn` (same gates: agent off, wallet, caps, guardrails, tools, billing, `clientTurnId` = run input id) with a **flow-backed `TurnSession`** (run's `ai.turns`). Built-in tools run in **simulated mode** in Phase 6 (live in Phase 7); custom functions run for real (as in the playground).
- **Exit mapping (checked after every turn, first match wins):** `transferRequested` → `transfer`; disposition `paid` → `paid`; `promiseToPay` → `promise_to_pay`; `callback` → `callback`; disposition `wrong_number` → `wrong_number`; `endRequested` (or any other disposition + end) → `resolved`; `maxTurns` reached or 2 consecutive `no_input` → `no_response`; agent off / wallet empty / cap / AI failure fallback turn → `error` (the fallback text is still said). **Unconnected outcome exits fall back to `resolved`.**
- **Outcome → run:** disposition / promise / callback / transfer copied to `state.outcome` and system variables (`disposition`, `promise_date`, `promise_amount`, `callback_date`, `callback_time`); `smsTemplate` → `messages[]` queued post-call.
- **`isAgentInUse(agentId)`** (Phase 5 stub) → true when the agent is in any non-deleted flow's **draft** or **current published version** (`FlowVersion.agentIds` + draft scan via `Flow.stats.agents`). Effects: agent **purge skipped**; agent **DELETE → 409 `RESOURCE_IN_USE`** with `details.flows[{ id, name }]` (Phase 5 frontend dialog shows them); deactivation allowed with a warning chip ("used by 2 published flows").

### 1h. Audio library (`play_audio`, audio prompts)

- `FlowAudio { accountId, name (1–80), fileKey (accounts/<id>/flow-audio/<audioId>.<ext>), format: mp3 | wav, bytes, durationMs, sampleRate, channels, uploadedBy, createdAt, deletedAt }` — account-level (reusable across flows), ≤ 200 per account.
- Upload `POST /flow-audio` (multipart, 1 file, ≤ 5 MB, ≤ 120 s): magic bytes (`RIFF…WAVE`, `ID3` / MPEG frame sync), **own small parsers** for WAV header + MP3 frame scan (duration, sample rate) — no new dependency; bad / too long → 415 / 422 with a reason. Conversion to G.711 is Phase 7 / 13.
- Preview: signed URL (`GET /flow-audio/:id/url`, Phase 1 storage signing, 10 min). Delete refused (409 `RESOURCE_IN_USE`) while referenced by a draft or a published version.

### 1i. Simulator (text mode of the engine)

- `FlowRun` model (`mode: 'simulator'` now, `'call'` from Phase 7): `{ accountId, flowId, versionRef: 'draft' | number, graph (snapshot for draft runs — editing the draft never changes a running simulation), graphChecksum, contactId?, manualVariables?, testPhone? (only `{{contact.phone}}` in API templates sees it), state (FlowRunState), transcript [{ seq, role: bot | customer | system, kind: say | play | dtmf | speech | ai | note, text, nodeId, at, meta }], trace[], costMicros, createdBy, createdAt, endedAt }` — TTL **30 days**.
- Start: `POST /flows/:id/simulations { version: 'draft' | number | 'published', contactId? , variables?, testPhone?, trigger: 'test' }` → run → `advance(start)` → response with transcript slice, `waiting`, current node, variables, outcome.
- Input: `POST /flows/:id/simulations/:runId/inputs { clientInputId, kind: dtmf | speech | no_input | transfer_result | hangup, value? }` — **idempotent by `clientInputId`** (replay returns the stored result, no second AI charge); 409 when the run ended; 422 when the input kind doesn't match `waitingFor`.
- `wait` and `timer` advance instantly (trace note "waited 5 s"). Max 200 inputs per run.
- Read: `GET /flows/:id/simulations` (latest 20 of the user / all for managers), `GET …/:runId` (full transcript + trace).
- Rate limit 60 inputs / min / user; AI turns + AI intent classification billed (§1k); everything else free.

### 1j. Templates (create-from)

All four ship graph + Hinglish texts + flow variables + layout positions; `{{amount}}` / `{{due_date}}` / `{{loan_id}}` are **optional** custom fields — template creation adds missing ones as **flow variables** with defaults (never creates account custom fields silently) and reports them.

| Key                | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loan_recovery`    | start → speak (disclosure + "Namaste {{name}}, aapki EMI ₹{{amount}} {{due_date}} ko due thi") → **gather_dtmf** "payment ho gaya ho to 1, abhi payment karna hai to 2, kisi se baat karni hai to 3" → **1:** api_request (mock `payment-status?phone={{contact.phone}}`) → router `status = paid` → speak thanks → set_disposition paid → hangup · else → speak "record mein nahi dikh raha" → **ai_agent** · **2:** send_sms payment link → speak "link bhej diya" → set_disposition promise_to_pay → hangup · **3:** **ai_agent** (loan recovery agent, goal "collect payment date or transfer") → `paid` / `promise_to_pay` (speak "{{promise_date}} tak note kar liya") / `callback` / `transfer` (transfer_to_agent) / `resolved` → hangup · `no_input` / `invalid` → speak "hum baad mein call karenge" → set_disposition callback_requested → hangup · api `failure` / `error` → ai_agent |
| `payment_reminder` | speak reminder → gather_dtmf (1 = paid, 2 = pay later → gather_dtmf digits "kitne din mein" → set_variable → speak confirm) → set_disposition → hangup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `feedback_survey`  | speak → gather_dtmf rating 1–5 (`saveAs rating`) → router (≤ 2 → gather_speech "kya problem hui?" saveAs `feedback`) → speak thanks → hangup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `inbound_support`  | start (inbound) → speak welcome → gather_speech with intents (`balance`, `payment`, `agent`) + keywords → api_request balance / ai_agent (support) / transfer_to_agent → hangup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

`POST /flows { name, templateKey?, agentIds?: { [nodeId]: agentId } }` — ai_agent nodes get the chosen agent; none chosen → node left unconfigured (validation error until picked). The UI picker pre-selects an agent whose `templateKey` matches (Phase 5 `loan_recovery_hinglish` etc.) and offers "Create the matching agent" (calls the Phase 5 create-from-template API first).

### 1k. Pricing & billing

- **No new rate-card fields.** Simulator AI turns = Phase 5 text-AI pricing via `runAgentTurn` (`chargeUsage`, `ai_charge`, breakdown `kind: 'flow_simulator'`, `ref: { type: 'usage', id: runId }`, idempotency `aiturn:<runId>:<clientInputId>`), agent caps + wallet gates unchanged. AI intent classification: same pricing, key `aiintent:<runId>:<clientInputId>`, `kind: 'flow_intent'`.
- Ledger `kind` enum + OpenAPI gain `flow_simulator`, `flow_intent`. Speak / audio / DTMF / API / SMS in the simulator: free (TTS + call minutes are Phase 7, SMS Phase 10).
- Wallet empty / cap on an AI node → the agent fallback line + `error` exit (no charge) — visible in the simulator.

### 1l. Frontend (builder)

| Area          | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependencies  | `@xyflow/react` (ADR 0014) + `@dagrejs/dagre` (auto-layout, ADR 0014 follow-up updated). Builder route **lazy-loaded** (own chunk; main bundle size must not grow > 5 KB gzip).                                                                                                                                                                                                                                                                                                                                                                |
| Routes        | `/flows` (list), `/flows/new` (template picker), `/flows/:id` (builder), `/flows/:id/versions` (list + read-only view `?v=3`), `/flows/:id/simulations/:runId` (run detail, deep link); `/flow-audio` lives in the builder (dialog), no page. `LIVE_PHASE = 6`.                                                                                                                                                                                                                                                                                |
| Flows list    | Table: name, status chip (Draft / Published v3 / Archived), "Unpublished changes" badge, nodes count, agents used, updated by / at; search + status filter; row actions open / duplicate / export / archive / delete (confirm; `RESOURCE_IN_USE` message); **Import JSON** button; empty state → templates.                                                                                                                                                                                                                                    |
| Builder shell | Top bar (name inline edit, status, revision "Saved 2 min ago", **Save** (Ctrl/Cmd+S), Validate, **Publish** (notes dialog, `flows.publish`), Versions, More: duplicate / export / auto-layout / flow settings / variables — import never replaces a draft, it always creates a new flow from the list page) · left **palette** (grouped: Start, Say & listen, AI, Logic, Actions, End; drag **or** click-to-add for keyboard users) · canvas · right **inspector** · bottom **issues panel** (click → focus node).                             |
| Canvas        | Custom node components per type: icon, label, one-line summary ("Press 1 / 2 / 3", agent name, `GET /payment…`), **labelled exit handles** (one per exit, colour for error), issue badge, stats badge (overlay); MiniMap, Controls, snap-to-grid 16 px, fit view, multi-select, delete key, **undo / redo (50 steps)**, **copy / paste** (new ids, offset), connection rules (one edge per handle, no edge into start), edge delete button.                                                                                                    |
| Inspector     | One react-hook-form + zod schema **per node type** (mirrors backend schemas via OpenAPI types); `VariablePicker` (moved from `features/agents/fields` to `components/` — shared) inserts `{{var}}`; agent picker (with "open agent" link + inactive warning); audio picker + upload + play; DTMF key table; intents editor (keywords chips); router rule builder (variable / operator / value); API request editor (reuses the Phase 5 function editor parts: headers with secret toggle, JSON body template field, result paths → variables). |
| Save model    | Local graph state (zustand-free: React state + reducer in a context); dirty flag; **unsaved-changes guard** (Phase 5 hook); Save sends the whole draft with `revision`; `409 FLOW_REVISION_CONFLICT` → dialog "Changed by X at …" with **Reload** / **Save as a copy**; WS `flow.updated` from another session → banner "Updated elsewhere — reload".                                                                                                                                                                                          |
| Simulator     | Right drawer (resizable) inside the builder: version select (draft / published / vN), contact picker or manual variables, Start / Restart; transcript (bot bubbles, audio cards with player, AI replies with Phase 5 tool cards + knowledge refs, system notes); input area switches by `waiting`: **DTMF keypad** (0–9 * #), text box (speech / AI), **Silence** button, transfer **Answered / Failed / No answer**; live variables + outcome panel; trace tab; cost; current node **highlighted + auto-centred** on the canvas.              |
| Stats overlay | Toggle "Show stats" → per-node entered / exit counts / errors (simulator now; "live calls" option appears from Phase 7) for the selected version and date range (7 / 30 days).                                                                                                                                                                                                                                                                                                                                                                 |
| Small screens | < 900 px: builder opens **read-only** (pan / zoom, inspector read-only) with a note; list, versions and simulator usable at 375 px.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Phase 5 touch | Agent delete dialog shows `RESOURCE_IN_USE` flows; agents list / editor show a "Used in N flows" chip (from `GET /agents/:id/usage` gaining `flows[]`).                                                                                                                                                                                                                                                                                                                                                                                        |

### 1m. Permissions & roles

| Permission        | Who (system roles)                   | Allows                                                                                                                          |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `flows.read`      | owner, admin, manager, agent, viewer | List / view flows, versions, stats, own simulator history read-only, audio preview                                              |
| `flows.write`     | owner, admin, manager                | Create / edit draft / duplicate / import / export / archive / delete, upload audio, **run the simulator** (AI turns cost money) |
| `flows.publish`   | owner, admin, manager                | Publish, restore a version into the draft                                                                                       |
| (impersonation)   | superadmin viewing as owner          | Read everything; **writes, publish, simulator blocked** (`blockWhenImpersonating`)                                              |
| suspended account | —                                    | Read-only; simulator refused                                                                                                    |

No new permission keys (catalogue already has `flows.read / write / publish`; matrix test verifies). Export needs `flows.write` (it reveals the API request configuration; secret header values are never exported).

### 1n. API surface (all `/api/v1`, Bearer, tenant-scoped)

| Route                                                                                                           | Permission     | Notes                                                                                          |
| --------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `GET /flows` · `POST /flows` · `GET·PATCH·DELETE /flows/:id`                                                    | read / write   | list (search, status, page); create blank / from template; PATCH = name, description           |
| `PUT /flows/:id/draft`                                                                                          | write          | `{ revision, graph }` → `{ revision, issues[], hasUnpublishedChanges }`; 409 on stale revision |
| `POST /flows/:id/validate`                                                                                      | read           | issues of the current draft (or a posted graph)                                                |
| `POST /flows/:id/publish` · `GET /flows/:id/versions[/:version]` · `POST …/versions/:version/restore`           | publish / read | publish notes; immutable versions                                                              |
| `POST /flows/:id/duplicate` · `POST /flows/:id/archive` · `POST /flows/:id/unarchive`                           | write          |                                                                                                |
| `GET /flows/:id/export[?version=]` · `POST /flows/import` (JSON body ≤ 512 KB)                                  | write          | format §3 T6.4; secrets stripped; refs mapped by id / name                                     |
| `GET /flows/templates` · `GET /flows/catalog`                                                                   | read           | node types with exits / limits / defaults, operators, dispositions, languages, voices          |
| `GET /flows/:id/variables`                                                                                      | read           | picker catalogue (§1c)                                                                         |
| `GET /flows/:id/stats?version=&from=&to=&mode=`                                                                 | read           | per-node counts                                                                                |
| `POST /flows/:id/simulations` · `GET /flows/:id/simulations[/:runId]` · `POST …/:runId/inputs`                  | write / read   | §1i; 60 inputs / min / user                                                                    |
| `GET /flow-audio` · `POST /flow-audio` (multipart) · `GET /flow-audio/:id/url` · `PATCH·DELETE /flow-audio/:id` | read / write   | §1h; 20 uploads / h / account                                                                  |

- **WS events** (`/ws/events`, account): `flow.updated { flowId, revision, by }`, `flow.published { flowId, version }`.
- **Audit actions (+11 → 68):** `flow.created` (template / blank / import), `flow.updated` (name / description / settings field names — **draft graph saves are not audited one by one**; the publish row carries the change summary), `flow.published` (version, notes, `nodesAdded / removed / changed` counts), `flow.restored`, `flow.duplicated`, `flow.imported`, `flow.exported`, `flow.archived`, `flow.unarchived`, `flow.deleted`, `flow_audio.changed` (`change: uploaded | renamed | deleted`, name, duration). Never node texts, URLs with values, headers.
- **Error codes (+2 → 41):** `FLOW_REVISION_CONFLICT` (409), `RESOURCE_IN_USE` (409, `details` lists users). Existing reused: `FLOW_INVALID` (422, `details.issues[]`), `CONFLICT_INVALID_STATE` (409 — publish with no change, input to an ended run), `FUNCTION_URL_BLOCKED` (422 at save of a literal blocked URL), `VALIDATION_FAILED`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `AI_SPEND_CAP_REACHED`, `AGENT_INACTIVE`.

### 1o. Contract for later phases

| Function / data                                                                                  | Used by                                                                   |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `advance(graph, state, input, effects, ctx)` + `FlowRunState` (JSON) + output actions            | Phase 7 voice runtime (Redis state; `say` → TTS, `listen_*` → STT / DTMF) |
| `FlowEffects` interface (`callApi`, `aiTurn`, `classifyIntent`, `loadAgent`, `loadAudio`, `now`) | Phase 7 live hooks (built-in tools live mode, Realtime AI)                |
| `FlowVersion` immutable + `Flow.publishedVersionId` + `isFlowInUse(flowId)` stub                 | Phase 8 campaign pinning / delete guard, Phase 14 inbound mapping         |
| `start.triggers` (`campaign`, `inbound`, `api`, `test`)                                          | Phase 8 / 14 / 10 pickers filter flows by trigger                         |
| `FlowRun` (`mode: 'call'`) + trace rows → `CallEvent` (`node_entered` / `node_exited`)           | Phase 7 timeline, Phase 9 call detail                                     |
| `FlowNodeStats` (`mode: 'call'`)                                                                 | Phase 9 flow / node reports                                               |
| `state.outcome.messages[]` (queued SMS / WhatsApp)                                               | Phase 10 post-call sending                                                |
| `state.outcome` (disposition, promise, callback, transfer)                                       | Phase 8 retries / callbacks, Phase 9 reports, Phase 10 webhooks           |

---

## 2. Tasks ka overview

| #     | Task                                                                                                                                                                                    | Repo | Size | Depends on |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- | ---------- |
| T6.1  | Models, migration 0007, `FLOW_LIMITS`, error codes, audit / WS catalogue, ledger kinds, data-model docs                                                                                 | BE   | M    | Phase 5    |
| T6.2  | Graph schema + node catalogue (zod per type, exits, defaults), shared templating refactor, variables catalogue, condition evaluator                                                     | BE   | L    | T6.1       |
| T6.3  | Validator (all §1e rules, SCC silent-loop check, URL rules) + issue messages                                                                                                            | BE   | M    | T6.2       |
| T6.4  | Flows API: CRUD, draft save with revision, validate, publish / versions / restore, duplicate, archive, delete, import / export, catalog, templates, `isAgentInUse` + agent delete guard | BE   | L    | T6.3       |
| T6.5  | Audio library: upload, WAV / MP3 parsers, signed preview, in-use guard                                                                                                                  | BE   | S    | T6.1       |
| T6.6  | Engine interpreter: state, inputs / outputs, all non-AI nodes, gather retries, intents (keywords), loop guard, error handler, trace, stats                                              | BE   | L    | T6.2       |
| T6.7  | Effects: `api_request` (Phase 5 executor), `ai_agent` (runAgentTurn, exits, `extraInstructions`), AI intent classifier, billing                                                         | BE   | L    | T6.6       |
| T6.8  | Simulator API: runs, inputs (idempotent), snapshots, TTL, rate limit, stats endpoint, purge crons                                                                                       | BE   | M    | T6.7       |
| T6.9  | 4 templates, seed, OpenAPI, ADR 0034, engine bench, docs                                                                                                                                | BE   | M    | T6.1–T6.8  |
| T6.10 | FE foundation: deps, gen:api, clients, keys, routes, `LIVE_PHASE = 6`, WS, shared `VariablePicker`, graph store + undo / redo                                                           | FE   | M    | T6.9       |
| T6.11 | Flows list, template picker, import / export, versions page, Phase 5 agent "used in flows" touches                                                                                      | FE   | M    | T6.10      |
| T6.12 | Builder canvas: palette, custom nodes + handles, edges, toolbar, save / conflict, validation panel, auto-layout, copy / paste, read-only mode                                           | FE   | L    | T6.10      |
| T6.13 | Inspector forms for all 15 node types + flow settings / variables dialogs + audio upload + agent / API editors                                                                          | FE   | L    | T6.12      |
| T6.14 | Simulator panel + canvas highlight + run detail page + node stats overlay                                                                                                               | FE   | M    | T6.12      |
| T6.15 | Playwright E2E, gap + security audit, docs, Phase 6 sign-off                                                                                                                            | both | M    | all        |

Batches: **Batch 1 = T6.1–T6.5** (`[P6-B1-DONE]`), **Batch 2 = T6.6–T6.9** (`[P6-B2-DONE]`), **Batch 3 = T6.10–T6.15** (`[P6-B3-DONE]`).

---

## 3. Tasks — step by step

### T6.1 — Models, migration 0007, catalogue

- [x] Models (tenant plugin): `Flow` (§1a; unique collation index `{ accountId, name }` partial `deletedAt: null`; `{ accountId, deletedAt, updatedAt: -1 }`, `{ accountId, status }`), `FlowVersion` (`{ flowId, version }` unique, `{ accountId, agentIds }`, `{ accountId, audioIds }`; update hooks throw), `FlowRun` (`{ accountId, flowId, createdAt: -1 }`, TTL 30 d on `expiresAt` for `mode: simulator` only), `FlowNodeStats` (`{ flowId, version, nodeId, day, mode }` unique), `FlowAudio` (`{ accountId, deletedAt }`).
- [x] `minimize: false` on schemas holding free objects (`variables`, `config`, `state`) — Phase 5 lesson (empty objects dropped).
- [x] Migration **0007**: collections + indexes; idempotent up; down refuses when flows exist.
- [x] `FLOW_LIMITS` (every number of §1); error codes `FLOW_REVISION_CONFLICT`, `RESOURCE_IN_USE` (39 → 41); audit actions (+11 → 68); WS events `flow.updated`, `flow.published` (map + `WS_EVENT_TYPES` + websocket.md); ledger breakdown `kind` += `flow_simulator`, `flow_intent`.
- [x] Permissions unchanged — matrix test asserts `flows.*` per role (§1m).
- [x] Docs: data-model §2.4 (Flow with embedded draft — deviation noted, FlowVersion, FlowRun, FlowNodeStats, FlowAudio, retention), data.md retention rows (simulator runs 30 d, stats kept with the flow), audit.md, error-codes.md, websocket.md.
- [x] Tests: model validation, unique names (case-insensitive, deleted ignored), version immutability, TTL index present, migration up / down / idempotent, catalogue sync tests (errors, audit, WS).

### T6.2 — Graph schema, node catalogue, templating, conditions

- [x] `core/flow/schema.ts`: `FlowGraphSchema` (strict zod), per-type `NodeConfigSchemas` (§1d with defaults), `NODE_CATALOG` (type → label, group, exits (static + dynamic rule), waits, limits) — exported to OpenAPI (`/flows/catalog`).
- [x] `core/flow/exits.ts`: `exitsOf(node)` (dynamic handles from keys / intents / rules), `requiredExits(node)`.
- [x] `core/templating/`: move the Phase 5 renderer (tokens, URL encode, JSON-tree rendering, warnings) behind a resolver interface; Phase 5 `http-tool.ts` uses it with its `args / contact / agent / company` resolver — **no behaviour change** (all Phase 5 tests green).
- [x] `core/flow/variables.ts`: catalogue builder (contact built-ins + custom fields + flow vars + system), typed coercion (`text / number / boolean / date`), reading format (₹, dates) shared with Phase 5 `formatValue`.
- [x] `core/flow/conditions.ts`: pure evaluator for all operators (typed compare: numbers when both sides numeric, dates `YYYY-MM-DD`, case-insensitive text, `in_list` comma split).
- [x] `core/flow/intents.ts`: normaliser (NFKC, lower, punctuation, Devanagari kept) + keyword matcher.
- [x] Tests: schema accept / reject table per node type (every limit edge), exits per type, templating (missing var warning, URL encoding, JSON escaping, `contact.*` server-only), coercion table, operator table (incl. `"10" gt "9"` numeric, empty values, dates), Hinglish + Devanagari keyword matching.

### T6.3 — Validator

- [x] `core/flow/validate.ts` (pure, ctx = account variables, agents { id → active }, audios, URL policy): every §1e rule, deterministic issue order (by node order, then code), human messages ("Press 2 has no next step").
- [x] Silent-loop detection (Tarjan SCC over non-waiting nodes), reachability (BFS from start), `no_ending` (reverse BFS from terminals).
- [x] URL rule reuses Phase 5 `urlBlockReason` (static checks only; DNS checks happen at run time).
- [x] Tests: one failing fixture per code + one clean fixture per template; large graph (150 nodes / 300 edges) validates < 20 ms.

### T6.4 — Flows API

- [x] `modules/flows/` schema / service / routes per §1n; list with search (name), status filter, pagination (Phase 3 pattern); `stats` (nodes count, agent ids) recomputed on save.
- [x] Draft save: strict schema, size limit, revision check with an atomic `findOneAndUpdate({ _id, revision })`, issues returned, `hasUnpublishedChanges` by checksum, WS `flow.updated`.
- [x] Publish (`flows.publish`): validate with live context (agents / audio exist), create version in a transaction with the flow update, audit summary (counts), WS `flow.published`. Restore, versions list / get.
- [x] Duplicate, archive / unarchive (state rules → `CONFLICT_INVALID_STATE`), delete (`isFlowInUse` stub → `RESOURCE_IN_USE`), 30-day purge job (`flows.purge` in maintenance: versions, runs, stats; audio untouched).
- [x] Export: `{ format: 'cell-ai-flow', schemaVersion: 1, exportedAt, name, description, graph, refs: { agents: [{ id, name }], audios: [{ id, name }] } }` — secret header values replaced by `null` (+ `secretRemoved: true`). Import: strict parse, size ≤ 512 KB, new ids kept, refs remapped (same account by id → else by name → else cleared + issue), always **creates a new flow** (name de-duplicated), audit `flow.imported`.
- [x] Templates + catalog endpoints; create-from-template with `agentIds` map (§1j); missing optional custom fields → flow variables.
- [x] Phase 5 integration: real `isAgentInUse` (§1g), agent DELETE → 409 `RESOURCE_IN_USE` with flows, `GET /agents/:id/usage` adds `flows[]`, purge skip test.
- [x] Tests: CRUD, permissions (viewer / agent read-only, manager publish, impersonation + suspended blocked), isolation (other account 404 incl. agent / audio ids in graphs), revision conflict, publish with errors → 422 issues, no-change publish 409, version immutability via API, restore, duplicate, archive rules, export / import round trip (incl. cross-account remap and secret stripping), templates create valid graphs, agent delete blocked while used, audit meta has no texts.

### T6.5 — Audio library

- [x] `modules/flow-audio/`: multer memory upload (1 file, 5 MB), magic-byte check, `core/flow/audio-probe.ts` (WAV RIFF chunks; MP3 frame headers, Xing / Info VBR frames, ID3 skip) → duration / sample rate / channels; storage key §1h; signed URL; rename; delete guard (drafts + versions); per-account limit 200; rate limit 20 uploads / h.
- [x] Fixtures: tiny WAV (8 kHz mono, 16 kHz), MP3 CBR + VBR (generated by a script, committed byte-exact), fake `.mp3` text file, > 120 s header.
- [x] Tests: each fixture, oversize 413, wrong type 415, too long 422, isolation, in-use delete 409, signed URL expiry.
- [x] **`[P6-B1-DONE]`**: full verify (lint, typecheck, test with coverage gate, openapi:check, format), manual check on dev: create flow from template via API, save with a stale revision → 409, publish → v1, export / import, agent delete blocked; audit + logs clean; gitleaks; docs ticked.

### T6.6 — Engine interpreter

- [x] `core/flow/engine.ts` (§1f): `advance`, input / output types, node handlers in **one file per node type** under `core/flow/nodes/` (small, no 3,000-line switch — AutoChatix gap), shared gather retry helper.
- [x] Nodes: start, speak, play_audio, gather_dtmf (menu + digits + repeat key), gather_speech (save + keyword intents), condition_router, set_variable, set_disposition, transfer_to_agent, send_sms / send_whatsapp (queued), wait, hangup; `ai_agent` / `api_request` through effects (T6.7) with stub effects in tests.
- [x] Loop guard (steps / visits / autoSteps), max duration, error routing (node `error` → flow handler → `onError`), engine-error catch, trace builder (redaction mode `call | simulator`), stats recorder interface (Mongo `$inc` implementation + in-memory for tests).
- [x] Tests (table-driven, no Mongo): every node × every exit; gather retries (timeout, invalid, repeat key, retries exhausted); digits mode with finish key; intents order; router rules order + else; coercion error → error exit; loop guard (silent loop built bypassing the validator), max duration, customer hangup mid-gather, determinism (same inputs twice → identical outputs), state JSON round trip between every step (Phase 7 contract), seeded random-graph fuzz (no exceptions, always ends or waits).

### T6.7 — Effects: API request, AI agent, AI intents, billing

- [x] `api_request` effect: render with the flow resolver, secrets opened server-side, Phase 5 `executeFunction`-level executor (SSRF guard, pinned DNS, redirects, size / time caps), `saveResponse` paths → typed vars, `last_api_status`, exits success / failure / error; trace has method, host, status, duration — never headers, body or full URL query values.
- [x] `ai_agent` effect: `compileAgent` + new `extraInstructions` option (snapshot tests), flow `TurnSession` adapter, `runAgentTurn` with `source: 'flow'`, simulated built-ins, exit mapping (§1g) + outcome → state / system vars, `maxTurns`, no-input counting, opening line.
- [x] AI intent classifier (`matchMode: ai`): prompt with data block, JSON parse with schema, fallback to keywords, fake-provider rule, billing (§1k).
- [x] Billing: ledger kinds `flow_simulator` / `flow_intent`, idempotency keys per input, wallet-empty / cap → fallback + `error` exit, no charge on provider failure.
- [x] Tests: API success → vars saved; non-2xx → failure; timeout / blocked (169.254.169.254) / private host in prod mode → error; secret header never in trace / logs; AI path with the fake provider + mock payment API ("maine pay kar diya" → `paid` exit; "kal tak de dunga" → `promise_to_pay` with tomorrow IST; "insaan se baat" → `transfer`; "bye" → `resolved`); max turns → `no_response`; agent off → error exit; wallet empty → no model call; retry same `clientInputId` → one charge; intent AI + fallback.

### T6.8 — Simulator API

- [x] `modules/flows/simulator.*`: start (version resolution, graph snapshot for draft, variables from contact (Phase 5 `contactVariables` style, formatted) or manual (validated against the catalogue), test phone), inputs (kind vs `waitingFor` check, idempotent `clientInputId` with stored results, ≤ 200 inputs), get / list, transcript builder, cost sum.
- [x] Stats endpoint (`/flows/:id/stats`) aggregation by version / mode / range; maintenance cron `flowRuns.cleanup` safety net (TTL index is primary).
- [x] Rate limit 60 inputs / min / user; impersonation / suspended refused; runs visible to creator, managers see all.
- [x] Tests: **"Done when" scenario at API level** on the Loan recovery template — paid contact press 1 → thanks → ended `paid`; unpaid press 1 → AI path; press 2 → SMS queued + `promise_to_pay`; press 3 → AI "kal tak de dunga" → promise confirm → ended; silence ×3 → `no_input` branch → `callback_requested`; invalid key ×3 → invalid branch; draft edit during a run doesn't affect it; input kind mismatch 422; ended run 409; isolation; viewer read-only.

### T6.9 — Templates, seed, OpenAPI, ADR, docs (`[P6-B2-DONE]` after this)

- [x] `modules/flows/templates.ts`: 4 templates (§1j) with positions laid out (dagre-like columns), texts reviewed for RBI recovery tone, each passes the validator once an agent is set; mock API URL from `APP_URL` like Phase 5.
- [x] `db:seed`: Demo Finance — Loan recovery flow (published v1, linked to the seeded recovery agent) + Feedback survey (draft), one sample audio (WAV, generated), idempotent.
- [x] `gen:openapi` + `openapi:check`; every route documented with errors.
- [x] **ADR 0034 — Call flow engine**: context (AutoChatix gaps: session state inside contact attributes, free-text edge conditions with silent first-match fallback, 3,600-line node switch, hard-coded reset keywords, `console.log` of edges, fire-and-forget traces, no versioning / immutable publish, no static validation), decision (§1b handles, §1f interpreter + effects, §1e validator, versions, embedded draft + revision), consequences, Phase 7–10 contract. ADR 0014 follow-up (dagre).
- [x] `scripts/bench-flow.ts` (`bench:flow`): 150-node graph, 10,000 `advance` calls → p50 / p95; validator on the largest graph.
- [x] Docs: api.md (flows, simulator, import / export format), security.md (API node = function rules, secrets stripped from exports), README "Call flows", `src/README.md`, CHANGELOG, compliance note (recovery templates tone, AI disclosure as first speak).
- [x] **`[P6-B2-DONE]`**: full verify + manual run on the dev server (fake provider): build Loan recovery from the template → publish → simulate every branch via API → ledger rows for AI turns → stats counts → logs grep (no customer texts / phones / secrets) → gitleaks.

### T6.10 — Frontend foundation

- [x] Install `@xyflow/react`, `@dagrejs/dagre` (exact versions, no `--legacy-peer-deps`); `gen:api`; clients `src/services/api/{flows,flow-audio,flow-simulator}.ts`; keys `features/flows/keys.ts`; type aliases for node configs.
- [x] `LIVE_PHASE = 6`; routes §1l with `RequirePermission('flows.read')`, lazy builder chunk; WS `flow.updated` / `flow.published` in the event map + hooks.
- [x] Move `VariablePicker` to `src/components/` (agents keep working), `useUnsavedChangesGuard` shared.
- [x] `features/flows/graph/`: graph reducer (add / move / delete / connect / update config / paste), undo / redo stack (50), id generator, local structural checks, dagre layout helper — pure + unit tested.
- [x] Tests: menu visibility per role, route guards, clients, reducer + history, layout helper, bundle check (builder chunk separate).

### T6.11 — Flows list, templates, import / export, versions

- [x] List page (§1l) with filters, row actions, delete / archive confirms, `RESOURCE_IN_USE` message; template picker dialog (cards + agent pre-select + "create matching agent"); Import (file picker → validation errors listed → open new flow); Export (download JSON, version choice).
- [x] Versions page: table (version, notes, by, at, checksum short), read-only canvas view, Restore (confirm, `flows.publish`), export a version.
- [x] Phase 5 touches: agent delete dialog lists flows; "Used in N flows" chip.
- [x] Tests: list states (loading / error / empty), filters, template create payload, import errors, restore flow, read-only for viewers, agent delete in-use message.

### T6.12 — Builder canvas

- [x] Builder page: top bar, palette (drag + click-to-add), canvas (custom nodes per type with exit handles + summaries + issue badges), edges with labels + delete, MiniMap / Controls / snap, multi-select, keyboard shortcuts (Delete, Ctrl/Cmd+Z / Shift+Z / C / V / S), auto-layout button, fit view.
- [x] Save flow: dirty state, unsaved guard, revision conflict dialog (Reload / Save as copy), WS "updated elsewhere" banner, issues panel (server issues after save + local checks) with focus-on-click, Validate button, Publish dialog (notes, blocked with error count).
- [x] Read-only mode (viewer / agent role, impersonation, < 900 px, version view).
- [x] Tests: add node via click, connect handle rules (one per handle, not into start), delete, undo / redo, copy / paste ids, save payload with revision, 409 dialog, publish blocked by issues, read-only hides palette / save; React Flow mocked where JSDOM can't measure (documented).

### T6.13 — Inspector forms

- [x] One form per node type (§1d) with zod schemas mirroring the backend (types from OpenAPI), live summary on the node, field errors from server issues (`field` paths).
- [x] Shared fields: template text with `VariablePicker`, prompt (speak / audio), language select, retries / timeout sliders.
- [x] Special editors: DTMF key table (add / remove / reorder, stable ids), intents (keyword chips), router rules (variable / operator / value rows, any / all), set-variable assignments, API request (method, URL with variable chips + `contact.phone` hint, headers with secret toggle masked after save, JSON body field, response → variable rows; no separate Test button — the simulator runs it), agent picker (inactive warning, link), audio picker + upload dialog (progress, duration shown, player), transfer phone (E.164 helper), SMS counter (160 / multi-part), WhatsApp template fields.
- [x] Flow settings dialog (language, voice, error message, onError + phone, max duration) and Variables dialog (add / rename / type / default; rename updates references after confirm).
- [x] Tests: each form's payload + validation messages, variable insert, DTMF duplicates, router rule builder, secret header keep / replace, audio upload flow, variable rename propagation.

### T6.14 — Simulator panel, run detail, stats overlay

- [x] Simulator drawer (§1l): start options, transcript rendering per kind (bot / customer / audio card with signed-URL player / AI reply with Phase 5 tool cards + knowledge refs / notes), input area by `waiting` (keypad, text, silence, transfer buttons), variables + outcome panels, trace tab, cost, restart; current node highlight + auto-centre; ended state summary.
- [x] Run detail page (deep link) reusing the transcript + trace components; simulator history list.
- [x] Stats overlay toggle with range + version select.
- [x] Tests: start → DTMF press → next prompt rendering, speech input, silence, AI reply card, wallet-empty / cap banner, ended summary, highlight follows the node, viewer can open history but not start, overlay numbers.

### T6.15 — E2E, gap audit, docs, sign-off

- [x] Playwright scenarios (fake AI provider + mock APIs on; `E2E_FRONTEND_PORT=3150` locally):
  1. **"Done when"**: owner creates **Loan recovery** from the template (seeded recovery agent picked) → 0 errors → Publish v1 → simulator (published) with the **paid** contact: press **1** → "payment mil gaya" → ended, disposition Paid; **unpaid** contact: press 1 → "record mein nahi" → AI path; press **2** → SMS queued card + disposition Promise to pay; press **3** → AI: "kal tak de dunga" → promise exit → "{{promise_date}} tak note" with tomorrow's date → ended.
  2. **No input / invalid**: Silence ×3 → callback branch; wrong key ×3 → invalid branch; canvas highlight follows.
  3. **Builder editing**: blank flow → add speak + gather_dtmf + hangup from the palette, connect, variable picker inserts `{{name}}`, issues panel shows the dangling node → fix → Save → reload persists; undo / redo; auto-layout; stale revision (second save via API) → conflict dialog.
  4. **Versions & files**: publish v1 → edit → publish v2 → restore v1 → export JSON → import → new flow opens; duplicate; upload WAV → play_audio card in the simulator.
  5. **Logic & API**: gather_speech intents branch, router on an API response variable, API node with `http://169.254.169.254/` → blocked issue; failure edge on a 500 mock.
  6. **Roles & money**: viewer / agent read-only builder (no palette / save / simulator start); impersonating superadmin can't simulate; AI turn in the simulator adds an **AI usage** wallet row (kind flow simulator); agent used in a flow can't be deleted (dialog lists the flow).
- [x] All 21 existing scenarios stay green; whole suite **twice**; fresh clones without `.env`.
- [x] Gap audit (requirement → test), security checklist (SSRF table on the API node, secrets never exported / returned / logged — `E2E_BACKEND_LOGS=1` grep for phones, header values, customer texts; import of a hostile JSON (huge, unknown types, prototype keys) refused; tenant isolation of agent / audio ids inside graphs), coverage re-measured (never lower), bundle size check.
- [x] Docs: both READMEs, CHANGELOGs, PHASE_6_TASKS, BUILD_PLAN status, this plan ticked, **PHASE_6_SIGNOFF.md**; `[P6-B3-DONE]` (full verify both repos, E2E twice, fresh clones, gitleaks, actionlint, `infra:down`).

---

## 4. Deliverables checklist

- [x] Flows with embedded draft (revision-checked saves), immutable published versions, restore, duplicate, archive, delete guard, import / export JSON.
- [x] 15 node types with typed configs, named exits, error exits, defaults and limits; shared catalogue for the builder.
- [x] Validator with all §1e rules; publish blocked on errors.
- [x] Engine interpreter (pure core + injected effects), loop guard, max duration, error handler, trace, node stats — Phase 7-ready state.
- [x] `ai_agent` node on Phase 5 agents (exits from outcomes, billing, caps), `api_request` node on the Phase 5 secure executor, AI / keyword intents.
- [x] Text simulator API (idempotent inputs, snapshots, transcript, trace, cost).
- [x] Audio library (WAV / MP3, duration checks, preview).
- [x] 4 templates + seed; `isAgentInUse` live; agent delete guard.
- [x] UI: flows list, template picker, builder (palette, nodes, inspector, validation, auto-layout, undo / redo, copy / paste, conflict handling), versions, simulator panel, stats overlay, read-only modes.
- [x] Docs: ADR 0034 (+ ADR 0014 follow-up), data-model, conventions (api, security, data, websocket, audit, errors), READMEs, CHANGELOGs, sign-off.

## 5. Risks

| Risk                                                             | Mitigation                                                                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine designed for text breaks on real voice (timing, barge-in) | State machine with explicit `listen_*` / `say` actions, `interruptible`, timers as inputs; Phase 7 host only maps actions → no engine change |
| Infinite loops / runaway flows                                   | Static `silent_loop` check + runtime steps / visits / autoSteps guards + max duration; fuzz test                                             |
| Lost work from concurrent edits                                  | Revision check (409) + conflict dialog + WS banner + unsaved guard; never last-write-wins                                                    |
| Published flow changed under a running campaign                  | Versions immutable (model hooks + no route); campaigns pin `flowVersionId`                                                                   |
| SSRF / secrets through `api_request`                             | Phase 5 executor + static URL issue; secrets sealed, stripped from exports, never in trace / logs / audit; E2E log grep                      |
| Hostile import JSON                                              | Strict zod, size cap, prototype-key rejection, ids re-validated, refs remapped inside the account only                                       |
| AI node cost runaway in the simulator                            | Prepaid wallet + agent caps + rate limit + `maxTurns` + idempotent per-input billing                                                         |
| React Flow performance / bundle size                             | 150-node limit, memoised nodes, lazy builder chunk, bundle check                                                                             |
| JSDOM can't measure React Flow (tests)                           | Pure reducer / layout tested separately; canvas tests with a mocked ResizeObserver; real interactions in Playwright                          |
| Hindi / Hinglish intent matching misses                          | NFKC normaliser + Devanagari + Roman keywords, AI mode option, simulator to tune keywords                                                    |
| Low RAM on the dev machine during full runs                      | `--maxWorkers=2`, wait for other projects' runs, never raise timeouts                                                                        |
| Template texts not matching client script / compliance           | Templates editable, reviewed for RBI tone + AI disclosure; open question §7                                                                  |

## 6. Recommended order

| Day   | Tasks |
| ----- | ----- |
| 1     | T6.1  |
| 2–3   | T6.2  |
| 4     | T6.3  |
| 5–6   | T6.4  |
| 7     | T6.5  |
| 8–9   | T6.6  |
| 10    | T6.7  |
| 11    | T6.8  |
| 12    | T6.9  |
| 13    | T6.10 |
| 14    | T6.11 |
| 15–16 | T6.12 |
| 17–18 | T6.13 |
| 19    | T6.14 |
| 20    | T6.15 |

_Estimate — run batch-wise with one detailed run prompt (Batch 1 = T6.1–T6.5, Batch 2 = T6.6–T6.9, Batch 3 = T6.10–T6.15)._

## 7. Open questions (defaults used until answered)

| #   | Question                                                             | Who    | Default in Phase 6                                                         |
| --- | -------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------- |
| 1   | Real IVR script (Hindi / English texts, menu keys) for loan recovery | Client | Template texts (Hinglish) with placeholders                                |
| 2   | Custom field names for amount / due date / loan id                   | Client | `amount`, `due_date`, `loan_id` (flow variables if the fields don't exist) |
| 3   | Client payment-check API (URL, auth, response)                       | Client | Mock API (`/mock/payment-status`), as Phase 5                              |
| 4   | Human transfer numbers / queues                                      | Client | Stored per node, simulated (Phase 13 real)                                 |
| 5   | SMS DLT templates, WhatsApp templates, payment-link format           | Client | Stored + queued, not sent (Phase 10)                                       |
| 6   | Sub-flows, business-hours / schedule node, A/B split                 | You    | Not in Phase 6 (later candidates)                                          |
| 7   | Pre-recorded audio vs TTS for the main prompts                       | Client | TTS text (Phase 7); `play_audio` available                                 |
| 8   | Max call duration default                                            | Client | 900 s per flow (agent `maxCallDurationSec` still caps an AI node)          |

---

## Changelog

- 2026-10-10: Plan created after Phase 5 sign-off (Phase 5 merged to `main`: backend `4038c8b`, frontend `603ae49`).
- 2026-10-10: Run prompt [PHASE_6_PROMPT.md](../prompts/PHASE_6_PROMPT.md) added (one file, 3 batches). Precisions there: module layout (`src/core/engine/` placeholder reused, `src/core/templating/` moved out of `http-tool.ts` without behaviour change, `src/modules/flows/`, `src/modules/flow-audio/`), exact `FLOW_LIMITS`, error codes 39 → 41 (`ConflictError` union extended), audit 57 → 68 with meta shapes, canonical JSON (positions in, viewport out), revision rules, variable / system names and value rendering, operator semantics, intent normaliser, AI intent prompt + fake-provider rule, engine input / output types and end reasons, simulator JSON, dev mock additions (`/mock/http-status/:code`, `/mock/loan-balance`), locked Loan recovery texts, import hardening + ref remap, WAV / MP3 probe, `flows-purge` cron, `rl:flowsim:` / `rl:flowaudio:` limiters, frontend graph reducer + JSDOM helper; template graphs authored in T6.4 (T6.9 reviews + seeds); a draft with validation errors cannot be simulated (422); dependencies `@xyflow/react` 12.12.0 + `@dagrejs/dagre` 3.1.1 (frontend only).
- 2026-10-10: **Batch 1 done (T6.1–T6.5).** Deviations / precisions recorded while building:
  - Stats counter field is `errorCount` (Mongoose reserves `errors`); the API still answers `errors`.
  - Draft saves accept incomplete node configs (they are issues); only the graph shape is 422. `FLOW_INVALID` / `RESOURCE_IN_USE` / revision-conflict details use `ErrorDetail` with new optional fields (`issue`, `severity`, `nodeId`, `edgeId`, `id`) — `updatedBy` / `updatedAt` of a revision conflict are details too (no separate `meta`).
  - Validator issue messages live in `validate.ts` (no separate `messages.ts`); validator fixtures are built in the test file instead of JSON files under `tests/fixtures/flows/`. API-node header rules (reserved / repeated names, line breaks, missing secret value, GET with a body) are `node_unconfigured` issues.
  - `transfer_to_agent` has no `connected` handle (the run ends there); its exits are `failed`, `no_answer`, `error`.
  - Template graphs are authored in T6.4 (API + tests need them); Loan recovery uses the locked texts, a placeholder transfer number `+919000000000` and the mock payment API. The demo account has `emi_amount`, not `amount`, so Loan recovery adds `amount` (and `loan_id` where missing) as flow variables — reported in `addedVariables`.
  - Duplicates are named "… (copy)", "… (copy 2)"; imports / uploads with a taken name get " (2)", " (3)".
  - Audio uploads also need a `.wav` / `.mp3` name (api.md §11 convention); content is still probed. Deleted audio files are removed by `flows-purge` after 30 days (with storage), together with flows.
  - Agent DELETE now answers 409 `RESOURCE_IN_USE` while a flow draft or the current published version uses the agent (Phase 5 behaviour change, as planned).
- 2026-10-12: **Batch 2 done (T6.6–T6.9).** Deviations / precisions:
  - The engine lives in `src/core/engine/` with `runtime.ts` (handler interface) and `gather.ts`; `advance()` also takes the start contact values and optional flow-variable seeds (simulator manual values). `runValues()` gives display values for views.
  - The AI node waits with `waiting.kind = ai` and listens with an 8 s speech timeout; two silent turns → `no_response`; a promise also sets the disposition `promise_to_pay` when none is set.
  - Unconnected exits fall back: AI outcome exits → `resolved`; any other exit → the node's `error` edge → the flow error handler.
  - API nodes use a new `sendGuardedRequest` (same guard as functions; any HTTP status is an answer). A run-time block / timeout / bad JSON → `error` exit.
  - Phase 5 changes: `compileAgent` `extraInstructions` (new snapshots only), `runAgentTurn` `source: 'flow_simulator'` (ledger kind + tool-call log source) and the fake provider's intent rule.
  - Simulator runs are visible to every `flows.read` user (`mine=true` filters own) so viewers can open history; `testPhone` only with manual values; `wait` nodes are skipped with a note.
  - Bench: 149 nodes, 10,000 `advance` calls p50 77 µs · p95 96 µs · p99 163 µs; validate 2.3 ms.
  - Seed: the demo greeting uses `emi_amount` (the demo account has no `amount` field); `loan_id` becomes a flow variable.
  - The seeded recovery agent has `transfer_to_human` off (Phase 5 template), so its AI path ends on promise / bye; the API-level test turns transfer on to prove the transfer branch.
- 2026-10-12: **Batch 3 done (T6.10–T6.15) — Phase 6 complete** ([sign-off](PHASE_6_SIGNOFF.md)). Deviations / precisions:
  - Frontend: the builder is a lazy chunk (92 KB gzip); the flows list / new / versions / run-detail pages stay eager — lazy-splitting them saved only ~2 KB because shared UI code moved into preloaded chunks. Initial load grew **+9.1 KB gzip** vs `main` (target was ≤ 5 KB).
  - Flow settings and variables open from buttons above the canvas (`renderDialogs`); the inspector's step forms receive the field errors of the selected step (`config.` prefix stripped).
  - The simulator panel shows "Waiting for the flow…" while an input is handled (E2E waits on it) and capitalised disposition labels; a failed input is retried with the same `clientInputId`, definite 4xx answers are not retried.
  - Stats overlay asks for `mode: simulator` and computes the 7 / 30-day range in the account timezone.
  - A refused agent delete names the flows in a snackbar (not a dialog).
  - E2E: 11 tests in 5 specs (scenario 1 split per branch with one shared account; builder specs at a 1600 × 1000 viewport); the logic scenario imports a JSON graph (speech intents → API → condition, a 500 API) instead of drawing it.
  - Bugs found by Playwright and fixed with regression tests: canvas clicks never selected a step; new steps stacked and landed under the settings panel; restoring a version opened the old cached draft; Validate results were hidden with unsaved changes.
  - Gap test added: another account's audio id in a saved graph → `audio_missing`, no name leak, simulation refused.
