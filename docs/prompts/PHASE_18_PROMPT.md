# P18 RUN — SIP Telephony (T18.1 → T18.22) — One-Paste Autonomous Run Prompt

> **HOW TO RUN — ek hi paste, poora phase. Beech mein kahin nahi rukna.**
>
> **Ek paste = STEP 0 → Batch 1 → Batch 2 → Batch 3 → sign-off.** Checkpoint (`P18-B1-DONE`, `P18-B2-DONE`) pe sirf commit + 2 line progress note, aur **usi turn mein agla task**.
>
> **Paste this (working directory `/Users/lalitbansal/Documents/cell-ai-voicebot`):**
>
> `cell-ai-voicebot-backend/docs/prompts/PHASE_18_PROMPT.md padho aur STEP 0 se P18-B3-DONE tak POORA Phase 18 (teeno batches) step by step autonomously implement karo. Kahin mat ruko — saare decisions is prompt + PHASE_18_PLAN.md me pre-made hain (defaults §1). Har task ke baad sirf us task ke tests (prompt §2 rule 5 — test policy) + commit [P18-T18.x]. Full suite sirf checkpoint pe EK baar. Gate S / Gate P inputs na hon to sirf wo sub-step skip, open item, aage badho. End me final report Hinglish me.`
>
> **Claude Code "auto / accept edits" mode me chalao.** **Docker Desktop chalu.** **Mac charger par, lid khuli** — lambi runs `caffeinate -dims` ke saath, background mein. Doosre projects ke containers / processes **kabhi mat chhoona** (port 3100 aur Supabase containers doosre project ke hain).
>
> **Paste se pehle owner ke kaam (optional):** SIP trunk details `~/.cav-sip/trunk.env` (600) mein (§0 Inputs), plan §7 ke jawab alag hon to plan mein likh do. Kuch na ho to bhi run poora chalega — lab + code + load sab Mac par.

---

## 0. CONTEXT (verified facts on 3 Nov 2026 — dobara derive mat karna)

**Branches:** `main` = backend **`6b656bd`**, frontend **`60c5fe4`** (Phase 17 done, pushed to `origin/main` of both repos and to the client repo as tag `release-20261103-6b656bd`, commit `4afa0e8`, **not deployed**). `docs/phases/PHASE_18_PLAN.md`, `PHASE_18_TASKS.md` and this prompt are **uncommitted on backend `main`** — STEP 0 moves them to the branch. Create **`feature/phase-18-sip`** from `main` in both repos. **Never commit to `main`.**

**Numbers at start:** backend **3,790 tests (+1 skipped) / 357 files**, gate 95 / 85 / 95 / 95, coverage 96.06 / 87.38 / 95.6 / 97.58; frontend **1,471 tests / 136 files**, gate 95 / 90 / 90 / 95, coverage 96.12 / 92.33 / 93.66 / 96.81; **169 Playwright tests** (36 min); bundle main 1,089 kB (gzip 321 kB). Catalogue (`tests/calls-wa/catalogue.test.ts`): error codes **103**, audit actions **167**, notifications **36**. Migrations `0001` … `0018` (`src/db/migrations/`). Last ADR **0049**.

**Production today:** `wa.notifynow.in` on the client's server `154.210.160.233`, Phase 15 code live (Phase 16 + 17 pushed, not deployed). No SSH access, no staging (Phase 17 open items). **Never connect to `45.114.245.71` or `13.232.191.62`.** Live site: public GET / HEAD only.

**Inputs (Gate S — the owner may provide; if missing, skip only T18.18 / T18.20 sub-steps and record open items):**

| Input           | Where                                                                                                                                                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trunk facts     | `~/.cav-sip/trunk.env` (600): `SIP_HOST`, `SIP_PORT`, `SIP_TRANSPORT`, `SIP_AUTH` (`register` \| `ip`), `SIP_TRUNK_IPS` (comma list), `SIP_CODECS`, `SIP_DTMF`, `SIP_MAX_CHANNELS`, `SIP_MAX_CPS`, `SIP_CALLER_IDS` (comma list), `SIP_RATE_PAISE_PER_MIN`, `SIP_PULSE_SEC`, `SIP_TEST_NUMBERS` (owner's phones) |
| Trunk secret    | `~/.cav-sip/trunk.secret.env` (600): `SIP_USERNAME`, `SIP_PASSWORD` — **read by key name only**                                                                                                                                                                                                                  |
| Server (Gate P) | Phase 17 `~/.cav-prod/inputs.env` + SSH keys (still absent on 3 Nov)                                                                                                                                                                                                                                             |

Never `cat`, `echo`, print, log, commit or paste a secret. Read env files only by key name (`grep -c '^KEY='`, `cut -d= -f1`).

**Pehle padho (STEP 0 and after every context compaction):**

- [PHASE_18_PLAN.md](../phases/PHASE_18_PLAN.md) — **source of truth**: goal + Done-when §0, findings F1–F7 §1a, reuse §1b, gaps §1c, decisions D1–D16 §1d, tasks §3, risks §5, **test policy §6**, owner questions §7, client inputs §8, order §9.
- [PHASE_17_SIGNOFF.md](../phases/PHASE_17_SIGNOFF.md) §7 (flakes, product finding), §8 (open items).
- ADRs 0020 (telephony abstraction), 0022 (SIP media server, deferred), 0035 (voice runtime), 0036 (dialer), 0040 (WhatsApp call media), 0049 (production server).
- [sip-lab-notes.md](../poc/sip-lab-notes.md) + `poc/sip-lab/` (working Asterisk 20 + ARI + ExternalMedia + SIPp lab, 2026-10-08).
- Conventions: [secrets.md](../conventions/secrets.md), [security.md](../conventions/security.md), [definition-of-done.md](../conventions/definition-of-done.md); [src/README.md](../../src/README.md).

**What exists (use it, don't rebuild) — exact entry points:**

| Area            | Use                                                                                                                                                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telephony types | `src/core/telephony/types.ts`: `CallLeg` (`rate: 24_000 \| 8_000`, `onAudio`, `onDtmf`, `onStatus`, `onOutgoing`, `play`, `clearAudio`, `playing`, `transfer`, `notify`, `hangup`), `HangupCause` (has `busy`, `no_answer`, `rejected`, `invalid_number`), `TelephonyProvider { name: 'webcall' \| 'sip' }` |
| Dry run         | `src/core/telephony/dryrun.ts` (rate 24 kHz), `scenarios.ts` (simulated customer scripts), `webcall.ts`, `media-server.ts`                                                                                                                                                                                  |
| WhatsApp media  | `src/core/telephony/whatsapp/*` (codec, jitter, pacing patterns to copy), `src/modules/whatsapp-calling/*` (owner sweep, reaper, runtime)                                                                                                                                                                   |
| Voice runtime   | `src/core/voice/ai-session.ts`, `flow-host.ts`, `latency.ts`, `audio/pacer`, `providers/openai-realtime.ts` (8 kHz → `audio/pcmu`), `providers/fake-stt.ts` / `fake-tts.ts` (lab + tests, no key)                                                                                                           |
| Calls           | `src/modules/calls/call.service.ts` (`provider: 'dryrun' \| 'sip'` input, line 67; dry-run start ~286), `session.ts`, `recording.ts`, `billing.ts`, `lifecycle.ts`, `maintenance.ts`, `registry.ts`                                                                                                         |
| Call model      | `src/db/models/call.model.ts`: `CALL_PROVIDERS = ['webcall','sip','notifynow','dryrun','whatsapp']`, `providerCallId`, `hangupCause`                                                                                                                                                                        |
| Campaigns       | `src/modules/campaigns/{dispatcher,dial-guard,window,caps,slots,single-call,results,sweep}.ts`; pacing `concurrency` 1–200 (`campaigns.schema.ts:95`), capped by `account.limits.maxConcurrentCalls`                                                                                                        |
| Account limits  | `src/db/models/account.model.ts`: `DEFAULT_ACCOUNT_LIMITS = { maxConcurrentCalls: 10, dialsPerMinute: 60 }`                                                                                                                                                                                                 |
| Limits          | `src/config/limits.ts`: `CALL_LIMITS` (`recordingSampleRate: 8_000`, `concurrentPerAccount: 3`, `concurrentPerProcess: 20`, …)                                                                                                                                                                              |
| Env             | `src/config/env.ts:133` `TELEPHONY_PROVIDER: z.enum(['dryrun'])`; `.env.example` `SIP_HOST` / `SIP_PORT` / `SIP_TRANSPORT` / `SIP_USERNAME` / `SIP_PASSWORD` / `SIP_CALLER_ID` (unused; comments say "Phase 13")                                                                                            |
| Billing         | `src/core/billing/engine.ts` (`run`, Redis `wallet-lock.ts`), holds per call, reaper                                                                                                                                                                                                                        |
| Ops (Phase 17)  | `src/ops/live-calls.ts` (release waits for live calls), `health-rules.ts`, `health-check.ts`, `modules/admin/system.service.ts` (`GET /admin/system`), `deploy/production/` kit, `deploy/staging/scripts/*`                                                                                                 |
| Dev infra       | root `docker-compose.yml`: `cav-mongo`, `cav-redis`, `cav-mailpit`; `npm run infra:up`                                                                                                                                                                                                                      |
| Load            | `scripts/perf-common.ts` (`PERF_SPLIT=1` two processes), `perf:*`, `bench:voice`                                                                                                                                                                                                                            |
| Frontend        | `src/pages/admin/*` (incl. `AdminSystemPage.tsx`), campaign form, call detail, `src/services/api/*`, `schema.gen.ts`                                                                                                                                                                                        |

**Bugs to avoid:** binding RTP or ARI to `0.0.0.0` on a shared host; Asterisk RTP range overlapping WhatsApp's 40000–40999; `allowguest=yes` / an anonymous endpoint (toll fraud); logging the SIP or ARI password or full phone numbers; a port lease or a Redis channel lease not released on an error path; originate without the call id as channel id (duplicate calls on retry); billing from ring time instead of answer; a hangup that leaves the ExternalMedia channel or bridge alive; Docker Desktop UDP proxy quirks taken as real bugs (check on Linux CI); the lab containers not named `cav-sip-lab-*`.

---

## 1. LOCKED DECISIONS (exact literals — the plan has the prose)

**Owner defaults (plan §7 #1–#11) are in force.** Record "Defaults in use for §7 #1–#11; Gate S inputs: <present names / none>" in the plan changelog at STEP 0. If a default proves impossible, pick the closest safe option, write a deviation, continue.

**Media server:** Asterisk **22 LTS**, ARI + ExternalMedia (RTP/UDP). Image `cav-asterisk:<version>` built from `deploy/asterisk/Dockerfile` (Debian bookworm-slim base pinned by digest; Asterisk from the official source tarball with sha256 check; `menuselect` only the modules below); runs as user `asterisk`. Modules: `res_pjsip*`, `chan_pjsip`, `res_rtp_asterisk`, `res_ari*`, `res_stasis*`, `app_stasis`, `res_http_websocket`, `app_amd`, `codec_ulaw`, `codec_alaw`, `format_wav`, `res_musiconhold` off, everything else `noload`. If building from source is too slow on the Mac, use the lab image `andrius/asterisk:22` pinned by digest for the lab only and record a deviation; production still builds ours.

**Ports:** SIP **5060** udp + tcp (TLS **5061** only if the trunk supports it), **only from `SIP_TRUNK_IPS`**; Asterisk RTP **20000–20999**/udp; ARI HTTP **`127.0.0.1:8088`**; our app RTP **21000–21999**/udp on `127.0.0.1`. Containers: dev / lab `cav-sip-lab-asterisk`, `cav-sip-lab-sipp-uas`, `cav-sip-lab-sipp-agent`; staging `cav-stg-asterisk`; production `cav-prod-asterisk`; compose profile **`sip`**; `network_mode: host` on Linux; limits `cpus: 1`, `mem_limit: 512m`; logging `local` 20m × 5.

**ARI app name:** `cav`. Channel id = `cav-<callId>`; ExternalMedia id = `cav-<callId>-em`; bridge id = `cav-<callId>-br`; transfer leg `cav-<callId>-xfer`.

**Env (new / changed):** `TELEPHONY_PROVIDER` = `dryrun | sip` (default `dryrun`); `ARI_URL` (default `http://127.0.0.1:8088`), `ARI_USER` (default `cav`), `ARI_PASSWORD` (secret, ≥ 24 chars), `ARI_APP` (`cav`), `SIP_TRUNK_ENDPOINT` (`trunk`), `SIP_CALLER_ID` (E.164), `SIP_MAX_CHANNELS` (30), `SIP_MAX_CPS` (2), `SIP_RING_TIMEOUT_SEC` (40), `SIP_MEDIA_TIMEOUT_SEC` (10), `SIP_APP_RTP_PORTS` (`21000-21999`), `SIP_BILLING_PULSE_SEC` (60), `SIP_TRUNK_COST_PAISE_PER_MIN` (optional), `SIP_SPEND_MINUTES_PER_HOUR` (600). Asterisk render env (not read by Node): `SIP_HOST`, `SIP_PORT`, `SIP_TRANSPORT`, `SIP_AUTH`, `SIP_USERNAME`, `SIP_PASSWORD`, `SIP_TRUNK_IPS`, `SIP_EXTERNAL_ADDRESS`, `SIP_LOCAL_NET`, `ARI_PASSWORD`. Production boot check: `TELEPHONY_PROVIDER=sip` requires `ARI_PASSWORD`, `SIP_CALLER_ID`, valid `SIP_APP_RTP_PORTS`; message lists missing **names**.

**Cause table (`src/core/telephony/sip/causes.ts`):** 486, 600 / Q.850 17 → `busy`; 480, 408, ring timeout / 18, 19 → `no_answer`; 603, 403 / 21 → `rejected`; 404, 484, 410 / 1, 3, 22, 28 → `invalid_number`; 500, 502, 503 / 34, 38, 41, 42 → `media_error` (retryable); 16 after answer → `customer_hangup` if the far end hung up, else `normal`; AMD machine → **`machine`** (new). Unknown → `media_error` + raw codes kept. Saved on the call: `sip: { code, q850, codec, amd, amdMs, packetsIn, packetsOut, lossPct, jitterMs, firstAudioMs }`.

**Data model:** migration **`0019-sip-lines`**: `accounts.voiceLine: 'dryrun'` on every account; `accounts.sipSettings: { pulseSec: null, spendMinutesPerHour: null }`; collection `phoneNumbers` (`number` unique E.164, `kind` `1600|landline|mobile|other`, `accountId|null`, `purpose` `outbound|inbound`, `label`, `dltPrincipalEntityId|null`, `status` `active|disabled`, timestamps; indexes `{number:1}` unique, `{accountId:1,status:1}`); calls get `callerId`, `callerNumberId`, `sip`, `trunkCostPaise`; campaigns get `callerNumberId|null`, `amd: 'off'|'hangup'|'leave_message'` (default `off`), `voicemailText|null`. Expand-only (works with the previous release).

**Redis keys:** `sip:channels` (sorted set of call id → lease expiry, TTL refresh 30 s, lease 2 h), `sip:cps` (token bucket, Lua), `sip:spend:<accountId>:<yyyymmddhh>` (minutes counter, TTL 2 h).

**Catalogue additions (append at the end; update count tests in the same commit):**

- Error codes **+4 → 107:** `LINE_BUSY` (409), `NUMBER_NOT_ALLOWED` (422), `CALLER_NUMBER_INVALID` (422), `PHONE_NUMBER_EXISTS` (409).
- Audit actions **+6 → 173:** `account.voice_line_changed`, `account.sip_settings_changed`, `phone_number.created`, `phone_number.updated`, `phone_number.assigned`, `phone_number.released`.
- Notifications **+2 → 38:** `sip.spend_guard_paused` (account owners + admins, bell + e-mail), `sip.trunk_down` (superadmins, bell + e-mail).
- Migration **0019**. ADR **0050** "SIP on the shared server"; ADR 0022 → Accepted. No new permissions (writes are superadmin-only).

**APIs:** superadmin `GET/POST /admin/phone-numbers`, `PATCH /admin/phone-numbers/:id`, `POST /admin/phone-numbers/:id/assign` `{accountId}`, `POST /admin/phone-numbers/:id/release`, `PATCH /admin/accounts/:id/voice-line` `{voiceLine}`, `PATCH /admin/accounts/:id/sip-settings`; account `GET /phone-numbers` (own active outbound). `GET /admin/system` gains `sip: { enabled, ariConnected, registered: boolean|null, liveChannels, maxChannels, cps, causes24h: Record<cause, number>, avgLossPct, avgJitterMs } | null`.

**Numbers allowed (D13):** `^\+91[6-9]\d{9}$` (mobile) or `^\+91[1-9]\d{9}$` landline with STD (not `1` short codes / `140` / `1800` / `1860` / `1900`); everything else → `NUMBER_NOT_ALLOWED`. Patterns in `src/config/limits.ts` (`SIP_LIMITS.allowedNumber`), not inline.

**AMD literals:** `AMD(2500,1500,800,5000,100,50,3,256)`; result vars `AMDSTATUS` / `AMDCAUSE`; `leave_message` waits up to 4 s silence then plays `voicemailText` TTS once.

**Disposition grace (T18.12):** `CALL_LIMITS.turnGraceMs = 3000`; after grace → call `incomplete` with `endReason: 'turn_timeout'`.

**Test policy (plan §6 — owner request, binding):** see rule 5. Default suite never needs Docker for SIP (fake ARI + loopback UDP). Lab suite `npm run test:sip` (`vitest.sip.config.mts`, files `tests-sip/**`) only when SIP code changed, **once** per checkpoint.

---

## 2. RULES OF ENGAGEMENT

1. **NEVER STOP, NEVER WAIT, NEVER ASK.** Checkpoints are commits, not pauses. Output before the end: only a 2-line progress note per checkpoint, in the same turn.
2. **Blocked? Unblock yourself.** Unclear spec → plan §1d / §7 default → safest convention-consistent choice → deviation note. Missing Gate S / P input → skip only that sub-step, open item, continue. Tool problem → fix within the rules → still blocked → skip that sub-step, open item.
3. **Safety:**
   - Real SIP calls only to `SIP_TEST_NUMBERS` (owner's phones), max 20 calls in the whole run, inside 10:00–19:00 IST. Never a customer number, never a campaign on the real trunk.
   - No production change in this run unless Gate P inputs exist **and** it is inside the maintenance window; then only via Phase 17 `release.sh` with profile `sip`, account lines left `dryrun`, and only the owner's test account switched.
   - Never connect to `45.114.245.71` or `13.232.191.62`; live site public GET / HEAD only.
   - Mac Docker: only `cav-*` (incl. `cav-sip-lab-*`) and one-off `docker run --rm`. Never `docker system prune`, never `down -v` on `cav-mongo`.
   - Never print secrets (no `env`, `printenv`, `docker inspect`, `docker compose config`, `cat` of env files); Asterisk logs read filtered, never pasted raw.
4. **Git:** branch `feature/phase-18-sip` in both repos; never on `main`; one commit per task per repo; hooks must pass (no `--no-verify`, no `--force`); **no push / merge / tag** in our repos and **no client repo sync** unless the owner asks. Footer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; lines ≤ 100; message in a scratchpad file + `git commit -F`; tag `[P18-T18.x]`.
5. **Test policy — run only what is relevant (plan §6). Each command separately; read output + exit code; never chain `git commit` after checks.**
   - **While writing a task:** only the test files for the changed code: `npx vitest run <files>` (or `npx vitest related <changed src files> --run`). No full suite, no coverage.
   - **Before each task commit:** backend `npm run lint` · `npm run typecheck` · the task's tests; `npm run build` only if `src/` entry points, Dockerfile or scripts changed; `npm run gen:openapi` + `npm run openapi:check` only if routes / schemas changed; `shellcheck` (Docker one-off `koalaman/shellcheck:stable`) on changed `.sh`. Frontend: `npm run lint` · `npm run typecheck` · the changed test files; `npm run gen:api` after backend schema changes; `npx tsc -p tsconfig.e2e.json --noEmit` only if e2e files changed. `format:check` is covered by the pre-commit hook.
   - **Checkpoint B1 / B2:** backend full `npx vitest run --maxWorkers=2` **once, no coverage**; frontend full `npx vitest run` **once**; both builds; `openapi:check`; `npm run test:sip` **once** if SIP code changed in the batch. Playwright: only specs of pages changed in the batch (`npx playwright test <spec>`, `E2E_FRONTEND_PORT=3150`).
   - **Sign-off B3:** backend `--coverage --maxWorkers=2` **once**, frontend `--coverage` **once**, builds, `test:sip` **once**, Playwright whole suite **once** with `E2E_BACKEND_LOGS=1` + log grep (patterns in P18-B3-DONE). `perf:sip` once.
   - **Flake:** a known flake fails → re-run **only that file** once; passes → record it; fails again → treat as a real failure. **Never** re-run a whole suite to chase a flake, never 5× runs.
   - Full runs in the background with `caffeinate -dims`; **no code edits while a full run is going**; wait for the notification.
6. **Coverage gates stay green; never lower thresholds; never raise test timeouts; no dynamic `import()` in backend tests.** New SIP code ≥ 95 % lines in the default suite (fake ARI) — the lab suite does not count for coverage.
7. **No external network in tests.** ARI is faked in-process (HTTP + WS); RTP over loopback UDP; OpenAI faked (`fake-stt` / `fake-tts`).
8. **Docs in the same commit** as the code. **Catalogue / count tests** in the same commit that adds entries.
9. **Real bugs in committed code:** reproduce → failing regression test first → separate `fix(<area>)` commit → plan changelog + final report.
10. **Progress note** at each checkpoint: "P18-B1-DONE ✅ — <n> backend / <m> frontend tests; next: T18.x" — nothing more.

---

## 3. RESUME SAFETY (after a context compaction or a restart)

1. `git branch --show-current` in both repos → `feature/phase-18-sip`; `git log --oneline -15`.
2. Last `[P18-…]` tag = position; `PHASE_18_TASKS.md` ticks must agree (fix the tracker if a tick is missing).
3. Uncommitted work → `git status` + `git diff` → finish that task, run its tests, commit. Never discard work without reading it.
4. Lab state: `docker ps --filter name=cav-sip-lab` → if half up, `npm run sip:lab:down` then `sip:lab`.
5. A background full run may still be going: check before starting another; never two full runs at once.
6. `npm run infra:up` → lint + typecheck → the last task's tests → continue with the **next** task. Don't redo committed tasks.

---

## STEP 0 — P18-SETUP (before T18.1)

1. Backend: `git status` shows only the three Phase 18 docs untracked on `main` (`6b656bd`). `git switch -c feature/phase-18-sip`. Frontend: `git switch -c feature/phase-18-sip` from `60c5fe4`.
2. `git fetch origin` both; if `origin/main` moved, merge `main` into the branch (`git merge --no-ff main`) and run lint + typecheck.
3. Inputs check (names only): `~/.cav-sip/trunk.env` and `trunk.secret.env` exist? Keys present (`grep -c`)? Write present / missing names into the plan changelog.
4. Plan status → **Locked**; changelog: "Run prompt prepared — literals locked: ADR 0050 + 0022 Accepted, migration 0019, errors +4 → 107, audit +6 → 173, notifications +2 → 38, ports 5060 / 20000–20999 / 8088 / 21000–21999; defaults in use for §7 #1–#11; test policy §6."
5. Commit → `docs(plans): add and lock phase 18 plan and run prompt [P18-PLAN]` (plan + tracker + this prompt).
6. Baseline: `npm run infra:up`; backend + frontend lint / typecheck green. **No full test run here** (Phase 17 sign-off numbers are the baseline). **Continue straight into T18.1.**

---

# ═══════════ BATCH 1 — Media path works in the lab (T18.1 → T18.6, T18.17 start) ═══════════

## T18.1 — Inputs, questionnaire, ADRs → `docs(adr): accept asterisk and add sip architecture [P18-T18.1]`

1. `docs/integrations/sip-trunk.md`: Gate S questionnaire (plan §8, 10 items, why each matters), a filled example with fake values (`sip.example.net`, `203.0.113.10`, `+911600000000`), and an empty **§Results** table for T18.18.
2. `docs/poc/sip-lab-notes.md` §5: replace `13.232.191.62` with "the production host from the server audit (ADR 0049)"; add a line "never use the client's other EC2".
3. ADR 0022 → **Status: Accepted (Phase 18)**; decision Asterisk 22 LTS + ARI + ExternalMedia RTP; AudioSocket as fallback; FreeSWITCH only if T18.19 fails; link the lab.
4. ADR **0050** "SIP on the shared server": context, decision (container, host network, ports table, trunk auth both modes, firewall only from trunk IPs, worker owns ARI + RTP, API queues calls, limits D9 / D10, rollback D12), mermaid (trunk → Asterisk → ExternalMedia RTP → worker `SipCallLeg` → voice runtime; ARI REST + WS), alternatives (FreeSWITCH, AudioSocket, a separate media server, a hosted CPaaS), consequences. Index row in `docs/adr/README.md`.
5. No code. Verify: `npx prettier --check docs` (pre-commit runs it anyway).

## T18.2 — Asterisk kit → `feat(ops): add asterisk kit and sip lab [P18-T18.2]`

1. `deploy/asterisk/Dockerfile` per §1 literals; `.dockerignore`; build arg `ASTERISK_VERSION`, sha256 check of the tarball.
2. `deploy/asterisk/conf/*.conf.template`: `pjsip.conf` (transport udp/tcp on 5060 bound to `0.0.0.0` only for SIP, `external_media_address` / `external_signaling_address` = `SIP_EXTERNAL_ADDRESS`, `local_net` = `SIP_LOCAL_NET`; endpoint `trunk` with `context=cav-out`, `disallow=all`, `allow=ulaw,alaw`, `dtmf_mode=rfc4733`, `direct_media=no`, `rtp_symmetric=yes`, `force_rport=yes`, `rewrite_contact=yes`; `identify` with `match=${SIP_TRUNK_IPS}` when `SIP_AUTH=ip`; `registration` + `auth` when `SIP_AUTH=register`; **no** anonymous endpoint), `rtp.conf` (20000–20999, `strictrtp=yes`, `icesupport=no`), `http.conf` (`bindaddr=127.0.0.1`, `bindport=8088`), `ari.conf` (user `cav`, `password=${ARI_PASSWORD}`, `password_format=plain`), `extensions.conf` (`[cav-out]` with `exten => _X.` Stasis; `[cav-amd]` sub that runs `AMD(...)` when `CAV_AMD=1`; `[cav-in]` → `Hangup(1)` until Phase 19), `logger.conf` (console notice+warning+error, no `verbose` with SIP payloads), `modules.conf` (`autoload=no` + explicit list), `pjsip_notify.conf` off.
3. `deploy/asterisk/render.sh`: renders templates with `envsubst` limited to a fixed variable list, fails on any `${` left, writes into the container's `/etc/asterisk`; never echoes values.
4. Compose: service `asterisk` (profile `sip`) in `deploy/staging/compose.yaml` and `deploy/production/compose.yaml` per §1; env file `env/asterisk.env`; healthcheck; `env.example` / `ops.env.example` keys added (names, no values). Production `README.md` SIP section.
5. Lab: `deploy/asterisk/lab/compose.yaml` (project `cav-sip-lab`, containers per §1, bridge network on the Mac, Asterisk ARI published on `127.0.0.1:18088`, RTP ranges published on loopback), `lab/sipp/Dockerfile` (from `poc/sip-lab`), `lab/scenarios/*.xml` (start with `answer-speak.xml`, `busy-486.xml`, `noanswer.xml`; T18.17 adds the rest), `lab/trunk.env` (lab trunk = SIPp UAS, IP auth). npm scripts `sip:lab` (`docker compose -f deploy/asterisk/lab/compose.yaml up -d --wait`), `sip:lab:down`.
6. CI (`ci.yml`): `shellcheck` on `deploy/asterisk/**/*.sh`; a render test with sample env; `docker build` of the Asterisk image only on the `sip-lab` job (T18.17).
7. Test: `tests/ops/asterisk-render.test.ts` — renders both auth modes from a sample env, asserts no `${`, no anonymous endpoint, `allowguest`-equivalent absent, ARI bound to 127.0.0.1, RTP range 20000–20999, password not in any comment.
8. Verify: render test, shellcheck, `npm run sip:lab` comes up healthy once, `sip:lab:down`.

## T18.3 — ARI client → `feat(telephony): add asterisk ari client [P18-T18.3]`

1. `src/core/telephony/sip/ari-client.ts` per plan §3 T18.3 (REST via `fetch` with basic auth + 3 s `AbortSignal.timeout`; events WS with reconnect 0.5 s → 10 s, jitter; typed events; `connected` getter + `onState` callback).
2. Methods: `originate`, `answer`, `hangup`, `externalMedia`, `createBridge`, `addToBridge`, `removeFromBridge`, `destroyBridge`, `getVar`, `listChannels`, `info`.
3. Errors → `AriError { status, op }` (no URL with credentials, no body echo).
4. `tests/telephony/sip/fake-ari.ts` (in-process HTTP + WS server; scriptable events; records calls) and `ari-client.test.ts`: auth header, each method's path / body, timeout, reconnect + resubscribe, unknown events ignored, close.
5. Verify: those tests, lint, typecheck.

## T18.4 — RTP bridge → `feat(telephony): add rtp bridge with g711 and jitter buffer [P18-T18.4]`

1. `sip/g711.ts` (μ-law + A-law encode / decode tables), `sip/rtp-packet.ts` (parse / build, PT 0 / 8), `sip/jitter.ts` (60 ms target, 200 ms max, reorder, 1-frame concealment, RFC 3550 jitter), `sip/port-pool.ts` (lease / release / sweep, `SIP_APP_RTP_PORTS`), `sip/rtp-session.ts` (UDP socket on 127.0.0.1, SSRC lock-in, inbound → PCM16 frames, outbound 160-sample frames via the existing pacer, `clear()`, stats).
2. `audio/pcmu` pass-through flag `SIP_PCMU_PASSTHROUGH` (default off until measured in T18.19).
3. Tests: `g711.test.ts` (ITU vectors, round trip), `rtp-packet.test.ts`, `jitter.test.ts` (reorder, loss, late, jitter number), `port-pool.test.ts` (exhaustion → `limit`, release on error, sweep), `rtp-session.test.ts` (loopback send / receive, SSRC change ignored, clear drops queue).
4. Verify: those tests, lint, typecheck.

## T18.5 — SIP leg + provider → `feat(telephony): add sip call leg and provider [P18-T18.5]`

1. `sip/causes.ts` per §1 table + `toHangupCause({ sipCode, q850, answered, farEndHungUp, amd })`.
2. `sip/leg.ts` `SipCallLeg implements CallLeg` (`rate = 8_000`), `sip/provider.ts` `SipTelephonyProvider implements TelephonyProvider` per plan §3 T18.5 steps 1–8; ids per §1; ring timeout; idempotent hangup; transfer via second channel + bridge swap.
3. Add `'machine'` to `HangupCause` (types.ts) and everywhere causes are listed (call outcome mapping, analytics glossary, i18n labels) — same commit.
4. Tests (`tests/telephony/sip/provider.test.ts`, fake ARI + loopback RTP): answered call two-way frames, every cause row, DTMF dedupe, barge-in `clearAudio`, transfer connected / no_answer / failed, hangup from each side, double hangup, ARI error on originate → `media_error` + port released.
5. Verify: those tests + `tests/calls/*` files that import `HangupCause` lists, lint, typecheck.

## T18.6 — Config + line selection → `feat(calls): choose the sip line per account [P18-T18.6]`

1. Env per §1 in `src/config/env.ts` + `env.test.ts`; `.env.example` (comments say Phase 18; SIP trunk keys moved to "Asterisk render env" block); README env table; boot check.
2. `src/modules/calls/line.ts`: `effectiveProvider(account, env)` → `sip` only if env `sip` **and** `account.voiceLine === 'sip'`; otherwise `dryrun`. Call service, single call, dispatcher use it; WhatsApp unaffected.
3. Wire `SipTelephonyProvider` in the worker runtime (owner of ARI); API enqueues. Lazy-create (no ARI connection when `TELEPHONY_PROVIDER=dryrun`).
4. Migration `0019-sip-lines` per §1 (+ test: up on a seeded DB, idempotent, previous release's reads still work). Account model fields.
5. `PATCH /admin/accounts/:id/voice-line` + audit `account.voice_line_changed` (catalogue +1 here; the other 5 in T18.7 / T18.14).
6. Tests: env parsing + boot check, `line.test.ts`, migration test, route test (superadmin only, audit row), dispatcher picks sip for a sip account with fake ARI.
7. Verify: those tests, catalogue test, lint, typecheck, build, `gen:openapi` + `openapi:check`.

## T18.17 (part 1) — lab tests → `test(telephony): add sip lab suite [P18-T18.17]`

1. `vitest.sip.config.mts` (include `tests-sip/**`, `testTimeout` as the default suite, single worker), `npm run test:sip`.
2. `tests-sip/answer.test.ts`, `busy.test.ts`, `noanswer.test.ts` against `npm run sip:lab` with the real `SipTelephonyProvider` + fake STT / TTS: answered call receives SIPp's WAV energy and SIPp receives our tone; causes match.
3. CI job `sip-lab` (ubuntu-latest, `paths:` filter `src/core/telephony/sip/**`, `deploy/asterisk/**`, `tests-sip/**`, `vitest.sip.config.mts`): build image, `sip:lab`, `test:sip`, `sip:lab:down`.
4. Verify: `npm run test:sip` once.

## P18-B1-DONE — checkpoint → `docs: mark phase 18 batch 1 complete [P18-B1-DONE]` (both repos)

1. Backend full `npx vitest run --maxWorkers=2` **once** (background, no coverage); frontend `npx vitest run` **once**; both builds; `openapi:check`; `npm run test:sip` **once**.
2. A known flake → re-run that file only (rule 5).
3. Tracker ticks T18.1–T18.6; plan changelog line with numbers; progress note; **continue to T18.12**.

---

# ═══════════ BATCH 2 — Product on SIP (T18.7 → T18.13) ═══════════

## T18.12 — Disposition on mid-turn hangup → `fix(calls): keep the disposition when the customer hangs up mid-turn [P18-T18.12]`

1. Reproduce first on dry run: a test where the customer hangs up while the AI tool call `set_disposition` is in flight → today the disposition is lost (failing test, commit it with the fix).
2. Fix per §1 (`turnGraceMs` 3000): session waits for the pending turn's tool results, sends no audio after hangup, billing ends at hangup time; timeout → `incomplete` / `turn_timeout`.
3. Re-run `tests/calls/outbound.test.ts` and `tests/db/seed-calls.test.ts` (Phase 17 open flakes) **3 times each, those files only**; if green, remove them from the open-flake list in the plan changelog.
4. Verify: those files, `tests/calls/ai-call.test.ts`, lint, typecheck.

## T18.7 — Phone numbers + caller ID → backend `feat(calls): add phone numbers and caller id per account [P18-T18.7]`, frontend `feat(admin): add phone numbers page [P18-T18.7]`

1. Backend: model + routes + schemas per §1 APIs; audit +4 (`phone_number.*`); errors `PHONE_NUMBER_EXISTS`, `CALLER_NUMBER_INVALID`; caller ID resolution `campaign.callerNumberId → account default → SIP_CALLER_ID` stored on the call; 1600-series warning (not a block) from `SIP_LIMITS.callerSeriesWarn`.
2. Frontend: `src/pages/admin/AdminPhoneNumbersPage.tsx` (table, add dialog, assign to account, release, disable), nav item, route; account Settings → Phone line card (read-only); API client + types; `gen:api`.
3. Tests: backend route tests (superadmin only, duplicates, assign / release, audit rows, campaign validation); frontend page test + settings card test.
4. Verify: those tests, catalogue test, `gen:openapi` / `openapi:check`, `gen:api`, both lints / typechecks.

## T18.8 — Dialer on SIP → `feat(campaigns): respect trunk channels and cps on sip [P18-T18.8]`

1. `src/core/telephony/sip/capacity.ts`: Redis channel semaphore + CPS bucket per §1 (Lua scripts; leases refreshed by the owner; released on every end path).
2. Dispatcher: acquire before originate; full → slot waits (no retry used); single call → `LINE_BUSY` 409 (error +1).
3. Retries by cause (plan §3 T18.8 step 4); contacts flagged `invalid_number` / `rejected`.
4. `live-calls.ts` counts SIP calls — add a test.
5. Two-process test (`PERF_SPLIT`-style helper or two child processes with fake ARI): 50 queued, `SIP_MAX_CHANNELS=5`, never > 5 live; CPS ≤ limit.
6. Verify: those tests, `tests/campaigns/dispatcher*.test.ts`, catalogue, lint, typecheck.

## T18.13 — Reliability → `feat(telephony): recover sip calls after restarts and media loss [P18-T18.13]`

1. Reconnect reconciliation, sweep (media timeout, max duration, leaked leases / ports), Asterisk-down pause of the dispatcher, SIGTERM path, idempotent originate — plan §3 T18.13.
2. Tests with fake ARI for each case; lab test `tests-sip/restart.test.ts` (restart `cav-sip-lab-asterisk` mid-call → call ends `media_error`, settled, port + lease free).
3. Verify: those tests (lab test runs at the checkpoint), lint, typecheck.

## T18.10 — Billing → `feat(billing): bill sip calls by pulse and record trunk cost [P18-T18.10]`

1. Duration from answer (`Up`) to end, min of Asterisk and our clock, `durationSource`; pulse rounding (env, account override); transfer leg ledger line `call.transfer`; unanswered → release hold; `trunkCostPaise` on the call.
2. `scripts/sip-cdr-reconcile.ts` + `npm run sip:cdr-reconcile -- <csv>` (report only).
3. Tests: pulse edges 1 / 60 / 61 / 119 s, override, transfer, unanswered, AMD hangup, CDR parser.
4. Verify: those tests, `tests/billing/*` files touched, lint, typecheck.

## T18.9 — AMD → `feat(campaigns): detect answering machines on sip calls [P18-T18.9]`

1. Dialplan `[cav-amd]` per §1; provider reads `AMDSTATUS` / `AMDCAUSE` on `StasisStart`; campaign `amd` + `voicemailText` fields (schema, validation, estimate unchanged); `machine` cause, `voicemail` outcome, analytics glossary + filters.
2. Charging per §7 #4 default (charge only if `leave_message` played).
3. Lab: `tests-sip/amd.test.ts` with `machine.xml` (8 s greeting) and `human.xml` (short hello).
4. Tests (default suite): setting paths with fake ARI vars, outcome mapping, campaign schema.
5. Verify: those tests, lint, typecheck, `openapi:check`.

## T18.11 — 8 kHz records → `test(calls): check recordings and transcripts at 8 khz [P18-T18.11]`

1. Recording mix at 8 kHz for SIP (already `recordingSampleRate: 8_000` — confirm the SIP path uses it), transcript timestamps from the RTP clock, erase removes phone recordings.
2. STT accuracy note: if `OPENAI_API_KEY` exists locally, compare 10 sample phrases at 8 vs 24 kHz (`bench:voice` style, synthetic TTS audio, no customer data) → `docs/poc/voice-ai-poc-results.md`; if no key, open item.
3. Tests: recording length ±1 s, erase.
4. Verify: those tests.

## P18-B2-DONE — checkpoint → `docs: mark phase 18 batch 2 complete [P18-B2-DONE]` (both repos)

1. Backend full suite **once** (no coverage), frontend **once**, builds, `openapi:check`, `npm run test:sip` **once**; Playwright only for changed pages (admin phone numbers, settings).
2. Tracker ticks T18.7–T18.13 (T18.17 stays open); plan changelog; progress note; **continue to T18.14**.

---

# ═══════════ BATCH 3 — Safety, UI, real trunk, load, rollout, sign-off (T18.14 → T18.22) ═══════════

## T18.14 — Security + toll fraud → `feat(security): guard sip calls against toll fraud [P18-T18.14]` (both repos if UI)

1. Number guard (`NUMBER_NOT_ALLOWED`, §1 patterns) in the dial guard for SIP; campaign results reason `number_not_allowed`.
2. Spend guard: `sip:spend:*` counter; breach → pause the account's running campaigns, notification `sip.spend_guard_paused`, audit `account.sip_settings_changed` when superadmin changes the limit (`PATCH /admin/accounts/:id/sip-settings`).
3. Logger redaction: `ARI_PASSWORD`, `SIP_PASSWORD`, `authorization` on ARI requests; phone numbers last 4 in SIP logs. Secret patterns in `sync-client-repo.sh` and the E2E log grep: add ARI basic-auth header shape.
4. `docs/security/threat-model.md` SIP section; `docs/ops/host-hardening.md` firewall commands for SIP / RTP from trunk IPs only (for the client admin).
5. Tests: number patterns (allowed / blocked table), spend guard pause + notification, redaction.
6. Verify: those tests, catalogue (notification +1, audit +1), lint, typecheck, `openapi:check`.

## T18.15 — Monitoring → backend `feat(ops): show sip health and alert on trunk problems [P18-T18.15]`, frontend `feat(admin): add sip card to system page [P18-T18.15]`

1. `metrics.sip` filled on every SIP call (T18.4 stats + AMD + first audio).
2. `system.service.ts` `sip` block per §1; `health-rules.ts` rules: ARI disconnected > 2 min, trunk unregistered (register mode), channels at limit > 10 min, avg loss > 5 % / 15 min → healthwatch alert + notification `sip.trunk_down` (catalogue +1 → 38).
3. Frontend: System page SIP card; tests.
4. Tests: rules table, system response shape, page test.
5. Verify: those tests, `gen:openapi` / `gen:api`, lints / typechecks.

## T18.16 — Frontend → `feat(calls): show phone line details and amd settings [P18-T18.16]`

1. Call detail (line, caller ID, cause in plain words, quality, AMD), campaign form (caller number, AMD, voicemail text, test-line banner), single call dialog (caller number, `LINE_BUSY` message), admin account line switch with confirm, reports filters (line, `machine` / `voicemail`).
2. Tests: one test file per changed page / dialog; Playwright `e2e/sip-line.spec.ts` (admin assigns number + switches line on a seeded account; campaign form shows caller number + AMD) against the backend with `TELEPHONY_PROVIDER=dryrun` (no Asterisk needed).
3. Verify: changed test files, the new spec alone, lint, typecheck, `tsc -p tsconfig.e2e.json`, build.

## T18.17 (part 2) — rest of the lab suite → `test(telephony): cover dtmf, reject, invalid, transfer and hangup in the sip lab [P18-T18.17]`

1. Scenarios + tests: `reject-603`, `notfound-404`, DTMF RFC 4733 (pcap in `lab/sipp/pcap/`), `hangup-midturn` (disposition saved), `transfer-agent` (second UAS answers; AI leaves), AMD already in T18.9, restart in T18.13.
2. Verify: `npm run test:sip` once.

## T18.19 — Load → `test(perf): measure sip calls up to the trunk limit [P18-T18.19]`

1. `scripts/perf-sip.ts` + `npm run perf:sip -- --calls 30 --minutes 10`: SIPp UAS in the lab answers, fake AI with real pacing, `PERF_SPLIT=1`.
2. Measure with and without `SIP_PCMU_PASSTHROUGH`; keep the faster as default if quality is equal.
3. Record in `docs/ops/capacity.md` Phase 18 section: CPU / RAM worker + Asterisk, event loop lag p99, RTP loss / jitter, port + lease leaks (must be 0), wallet exact. Mac numbers; staging = open item until it exists.
4. Run **once** (re-run only if the run itself crashed).

## T18.21 — WhatsApp over SIP note → `docs(integrations): add whatsapp sip research note [P18-T18.21]`

`docs/integrations/whatsapp-sip.md` per plan §3 T18.21 (sources: Meta's Cloud API calling docs — fetch the public page; record the date read). Recommendation + effort estimate. No code.

## T18.18 — Real trunk calls → `docs(integrations): record real sip trunk test calls [P18-T18.18]`

- **If Gate S inputs exist:** render the trunk config into the lab Asterisk (on the Mac, only if the trunk allows the owner's public IP; else open item "needs the server"), run the plan §3 T18.18 checklist with ≤ 20 calls to `SIP_TEST_NUMBERS` in 10:00–19:00 IST, fill `sip-trunk.md` §Results (no full numbers — last 4).
- **If not:** §Results says "not run — Gate S inputs absent" and the open item lists exactly what is needed. Commit the doc either way.

## T18.20 — Production rollout → `docs(ops): record sip rollout on production [P18-T18.20]`

- **If Gate P + S exist and inside the window:** server audit confirms ports; `release.sh` with profile `sip`; owner's test account → `sip`; T18.18 checklist on production (≤ 5 calls); rollback drill (account line → `dryrun` < 1 min; stop `cav-prod-asterisk`); record in `docs/ops/releases.md`.
- **If not:** `docs/ops/production.md` SIP section with the exact rollout steps + rollback; open item. `docs/ops/incidents.md` runbook entries (trunk down, one-way audio, calls stuck, spend guard / toll fraud) are written **either way**.

## T18.22 — Gap audit, docs, sign-off → `docs: add phase 18 sign-off and docs [P18-T18.22]` (both repos)

1. Docs per plan §3 T18.22 step 1 (ADRs, `sip-trunk.md`, `production.md`, `capacity.md`, `audit.md` (+6), `data-model.md` (`phoneNumbers`, account / call / campaign fields, Redis keys), threat model, both CHANGELOGs "Phase 18", `src/README.md` row for `core/telephony/sip/`, BUILD_PLAN_V2 changelog "Phase 18 … Next: Phase 19").
2. Gap audit: every Done-when line (plan §0) → pass / open item with owner; every §1c gap → its commit.
3. `docs/phases/PHASE_18_SIGNOFF.md`: verdict, task table (done / waits for), Done-when table, numbers (before → after: tests, coverage, bundle, Playwright, `test:sip`, `perf:sip`), deviations, bugs found + fixed, flakes, open items with owners.
4. Tracker: tick done tasks; list open ones with the reason.

## P18-B3-DONE — sign-off run → `docs: mark phase 18 complete [P18-B3-DONE]` (both repos)

1. Backend `npx vitest run --coverage --maxWorkers=2` **once**; frontend `npx vitest run --coverage` **once**; both builds; `openapi:check`; `npm run test:sip` **once**; Playwright whole suite **once** with `E2E_BACKEND_LOGS=1` → grep the log for: `cav_(live|test)_[0-9A-Za-z]{32}`, `whsec_`, `v1=[0-9a-f]{64}`, `\+91[0-9]{10}`, `Bearer [A-Za-z0-9._-]{20,}`, `"password"`, `otpauth`, `\$enc`, `mongodb(\+srv)?://[^ ]*@`, `AKIA[0-9A-Z]{16}`, `Basic [A-Za-z0-9+/=]{16,}`, `SECRET-16` → all 0.
2. One script in the scratchpad runs these in order in the background; wait for its notification; **no second runs** except one re-run of a single flaky file.
3. Fill the numbers into the sign-off + plan changelog (honest: a flake is a flake, not a pass).
4. `npm audit --omit=dev` both repos; secret scan of `git diff main...HEAD` both repos (patterns above + `ARI_PASSWORD=`, `SIP_PASSWORD=` with a value); `git status` clean; `git log --oneline main..HEAD` listed in the report.
5. Final report (Hinglish).

---

## 4. FINAL CHECKLIST

- [ ] Plan locked, prompt committed `[P18-PLAN]`
- [ ] ADR 0022 Accepted, ADR 0050 + index row
- [ ] `deploy/asterisk/` (Dockerfile, templates, render, lab, scenarios), compose `sip` profile staging + production, env examples
- [ ] `src/core/telephony/sip/` (`ari-client`, `g711`, `rtp-packet`, `jitter`, `port-pool`, `rtp-session`, `causes`, `leg`, `provider`, `capacity`) ≥ 95 % lines
- [ ] `HangupCause` `machine`; outcome `voicemail`; glossary
- [ ] Env + boot check + README table + `.env.example` comments fixed
- [ ] Migration 0019; `phoneNumbers`; account `voiceLine` / `sipSettings`; call `callerId` / `sip` / `trunkCostPaise`; campaign `callerNumberId` / `amd` / `voicemailText`
- [ ] APIs per §1; OpenAPI regenerated; `gen:api`
- [ ] Catalogue: errors 107, audit 173, notifications 38 — count tests updated
- [ ] Trunk channels + CPS across processes (two-process test)
- [ ] Retries by cause; `LINE_BUSY`
- [ ] AMD; disposition grace fix (flakes re-checked)
- [ ] Reliability: reconnect, sweeps, restart, media timeout, SIGTERM, idempotent originate
- [ ] Pulse billing, transfer ledger line, trunk cost, CDR reconcile script
- [ ] 8 kHz recordings / transcripts; STT note or open item
- [ ] Number + spend guards; redaction; threat model; host-hardening SIP rules
- [ ] `metrics.sip`; System SIP card; healthwatch rules; `sip.trunk_down`
- [ ] Frontend: admin phone numbers, line switch, call detail, campaign form, single call, reports filters; tests; `sip-line.spec.ts`
- [ ] `test:sip` suite + CI `sip-lab` job with paths filter
- [ ] `perf:sip` numbers in `capacity.md`
- [ ] Real trunk results or open item; production rollout or open item; incident runbook entries
- [ ] WhatsApp SIP note
- [ ] Sign-off, tracker, CHANGELOGs, BUILD_PLAN_V2, `src/README.md`
- [ ] Sign-off run: each suite **once**, Playwright **once**, log grep 0, `npm audit` 0, secret scan clean, `git status` clean
- [ ] No push / merge / client sync unless the owner asked

## 5. FINAL REPORT (Hinglish, short)

1. Ek line: Phase 18 kitna hua (done / open with reason).
2. Numbers: tests before → after (backend, frontend, Playwright, `test:sip`), coverage, `perf:sip`.
3. Real trunk aur production: hua ya kya chahiye (Gate S / P items by name).
4. Bugs found + fixed, flakes (honest).
5. Owner ke liye open items with owner.
6. Commits list (`git log --oneline main..HEAD` both repos); kuch push nahi hua (unless asked).
