# Trivia M1 Known Issues & Decision Registry

## 1. Purpose and scope

Evidence inventory through Phase 4 Slice 1 and the Slice 2 session discussion. This registry is subordinate to System Design (architecture), LLD (runtime), and Database Design (durable constraints). Source behavior is evidence, not permission to redefine contracts. Future actions below are proposals, not approvals. Priorities remain UNDECIDED until scheduled by the project; target milestones are triage recommendations, not deadlines.

## 2. Taxonomy and status definitions

One primary category per entry: BUG confirmed defect; LIM accepted limitation; RISK potential harm; DEBT maintenance concern; DEC unresolved policy; TEST verification gap; OPS operational gap; DEF explicitly deferred or pending integration work with a material readiness consequence. Related IDs connect overlapping concerns without duplicating their primary records.

OPEN: unresolved. ACCEPTED: explicitly retained limitation/exclusion. PLANNED: approved scheduled work. IN_PROGRESS: work underway. RESOLVED: correction/decision evidenced. CLOSED: no further action, with rationale. Acceptance does not mean resolution.

## 3. Severity and priority definitions

CRITICAL: catastrophic compromise/loss; HIGH: material security, availability or required-flow failure; MEDIUM: bounded correctness/operational exposure; LOW: limited maintenance/product impact; UNDETERMINED: evidence or policy insufficient. Severity assessments are registry triage judgments, not historical approvals; absent public endpoints make security risks conditional.

P0: immediate response; P1: next required gate; P2: scheduled improvement; P3: optional/later; UNDECIDED: scheduling not approved. Severity does not assign urgency. No creation dates, owners or deadlines are inferred.

## 4. Summary dashboard by category and status

| Category | OPEN | ACCEPTED | RESOLVED | Total |
|---|---:|---:|---:|---:|
| BUG | 0 | 0 | 4 | 4 |
| LIM | 0 | 3 | 0 | 3 |
| RISK | 2 | 0 | 3 | 5 |
| DEBT | 2 | 0 | 0 | 2 |
| DEC | 9 | 0 | 4 | 13 |
| TEST | 4 | 0 | 1 | 5 |
| OPS | 3 | 0 | 0 | 3 |
| DEF | 2 | 2 | 1 | 5 |

Total: **40** records; **5 ACCEPTED**, **22 OPEN**, **13 RESOLVED**. PLANNED, IN_PROGRESS and CLOSED: 0.

## 5. Active issues table

Includes accepted limitations/exclusions; resolved decisions/mitigations retain their detailed records in §6 and historical defects are in §9. Active priorities are UNDECIDED; resolved BUG-004 retains its explicitly approved P0 remediation priority.

| ID | Concern | Status | Severity | Proposed target |
|---|---|---|---|---|
| [LIM-001](#lim-001) | Post-commit deadline scheduling can stall a Match | ACCEPTED | HIGH | current demo |
| [LIM-002](#lim-002) | Active Matches are lost on process restart | ACCEPTED | HIGH | current demo |
| [LIM-003](#lim-003) | Completed aggregates and retry receipts retained until shutdown | ACCEPTED | MEDIUM | later hardening |
| [OPS-001](#ops-001) | Runtime timer failure reporting is not integrated | OPEN | HIGH | before public deployment |
| [OPS-002](#ops-002) | Production HTTPS, secret and deployment procedures are unspecified | OPEN | HIGH | before public deployment |
| [OPS-003](#ops-003) | Health is liveness, not operational readiness | OPEN | MEDIUM | before public deployment |
| [RISK-003](#risk-003) | Private Engine outcomes must never be serialized directly | OPEN | HIGH | before public deployment |
| [RISK-004](#risk-004) | Development dependency advisories remain unremediated | OPEN | MEDIUM | before public deployment |
| [DEBT-001](#debt-001) | Repository guidance contains obsolete implementation descriptions | OPEN | LOW | later hardening |
| [DEBT-002](#debt-002) | Competition ranking clarification is not fully in frozen baseline | OPEN | LOW | current demo |
| [DEC-005](#dec-005) | Password creation policy remains undecided | OPEN | UNDETERMINED | undecided |
| [DEC-006](#dec-006) | Host departure and active disconnect policy | OPEN | UNDETERMINED | future design |
| [DEC-007](#dec-007) | Enabled earlyClose behavior | OPEN | UNDETERMINED | future design |
| [DEC-008](#dec-008) | Other SQL identifiers and deletion/retention policy | OPEN | UNDETERMINED | undecided |
| [DEC-009](#dec-009) | External History pagination and participant count | OPEN | UNDETERMINED | undecided |
| [DEC-010](#dec-010) | Capacity and operational service targets | OPEN | UNDETERMINED | undecided |
| [DEC-011](#dec-011) | Question selection, source lineage and Provider failures | OPEN | UNDETERMINED | undecided |
| [DEC-012](#dec-012) | Future recovery and interrupted-admission fairness | OPEN | UNDETERMINED | future design |
| [DEC-013](#dec-013) | Broader product and anti-cheat requirements | OPEN | UNDETERMINED | future design |
| [TEST-001](#test-001) | Real PostgreSQL verification is conditional | OPEN | MEDIUM | current demo |
| [TEST-002](#test-002) | Migration rollback and concurrent-run coverage is incomplete | OPEN | MEDIUM | before public deployment |
| [TEST-004](#test-004) | Authenticated Match-to-History end-to-end verification absent | OPEN | HIGH | current demo |
| [TEST-005](#test-005) | Full-checkout manual scripts fail existing lint rules | OPEN | LOW | later hardening |
| [DEF-002](#def-002) | Safe playable runtime composition remains pending | OPEN | HIGH | current demo |
| [DEF-003](#def-003) | Completed persistence and authorized History pending | OPEN | HIGH | current demo |
| [DEF-004](#def-004) | Account recovery and advanced authentication excluded | ACCEPTED | UNDETERMINED | future design |
| [DEF-005](#def-005) | Bots, tournaments and human score formatting deferred | ACCEPTED | LOW | future design |

## 6. Detailed issue records grouped by category

### LIM records

<a id="lim-001"></a>

### LIM-001 — Post-commit deadline scheduling can stall a Match

- **Category / status:** LIM / ACCEPTED. **Severity / priority:** HIGH / UNDECIDED.
- **Component / phase:** Coordinator/Timer; Phase 3. **Target:** current demo.
- **Evidence:** [System §16](system-design.md#16-reliability-and-failure-considerations); [LLD §4.5](low-level-design.md#45-timer--clock); [fault injection](../manual-scheduler-failure-test.ts); [regression tests](../tests/match-coordinator.test.ts).
- **Concern:** schedule() can throw after QUESTION_OPEN commits, leaving no deadline timer.
- **Policy / status:** Preserve committed state and accepted receipt; retain failure. No automatic retry, rollback, deadline extension, or fatal shutdown for this failure.
- **Impact:** A Match may stall while the backend remains alive; gameplay correctness is unchanged.
- **Next action:** Keep limitation explicit; connect safe operational reporting. Recovery requires separate approval.
- **Related:** OPS-001, DEC-012.

<a id="lim-002"></a>

### LIM-002 — Active Matches are lost on process restart

- **Category / status:** LIM / ACCEPTED. **Severity / priority:** HIGH / UNDECIDED.
- **Component / phase:** Runtime; Phase 3. **Target:** current demo.
- **Evidence:** [System §§15–16](system-design.md#15-completed-match-persistence-lifecycle); [Database §12](database-design.md#12-active-state-is-not-persisted).
- **Concern:** Active state and retry outcomes exist only in memory.
- **Policy / status:** M1 accepts active-process loss; durable Player and committed History survive.
- **Impact:** Restart cannot resume an active Match or replay retained command outcomes.
- **Next action:** Communicate availability model; approve recovery separately.
- **Related:** DEC-012, LIM-003.

<a id="lim-003"></a>

### LIM-003 — Completed aggregates and retry receipts retained until shutdown

- **Category / status:** LIM / ACCEPTED. **Severity / priority:** MEDIUM / UNDECIDED.
- **Component / phase:** Coordinator; Phase 3. **Target:** later hardening.
- **Evidence:** [LLD §4.3](low-level-design.md#43-match-coordinator); [Coordinator](../src/application/match-coordinator.ts).
- **Concern:** Completed aggregates and cached outcomes have no TTL or eviction; idle queues are released and obsolete timers cancelled.
- **Policy / status:** Process-local retention until shutdown is approved, including separate Create and per-Player/per-Match namespaces.
- **Impact:** Memory grows with process lifetime, Match count, and unique command IDs; restart removes replay capability.
- **Next action:** Measure memory at intended load; do not add eviction without changing approved retention contract.
- **Related:** DEC-010.

### OPS records

<a id="ops-001"></a>

### OPS-001 — Runtime timer failure reporting is not integrated

- **Category / status:** OPS / OPEN. **Severity / priority:** HIGH / UNDECIDED.
- **Component / phase:** Composition/observability; Phase 4. **Target:** before public deployment.
- **Evidence:** [LLD §8.7](low-level-design.md#87-logging-rules); [takeTimerFailures](../src/application/match-coordinator.ts); [main](../src/main.ts).
- **Concern:** Failures are drainable in memory. Slice 3 composes the shared Coordinator for WAITING operations, but does not yet consume Match timer diagnostics; Start/timer-driven gameplay transport remains deferred.
- **Policy / status:** Error-level runtime reporting is explicitly a Phase 4 follow-up.
- **Impact:** A stalled Match may lack an operator-visible error despite retained diagnostics.
- **Next action:** Connect safe error reporting at runtime composition without adding recovery.
- **Related:** LIM-001.

<a id="ops-002"></a>

### OPS-002 — Production HTTPS, secret and deployment procedures are unspecified

- **Category / status:** OPS / OPEN. **Severity / priority:** HIGH / UNDECIDED.
- **Component / phase:** Deployment; bootstrap/Phase 4. **Target:** before public deployment.
- **Evidence:** [Compose](../docker-compose.yml); [environment example](../.env.example); [README Docker workflow](../README.md).
- **Concern:** Compose exposes loopback ports with local example credentials; no production TLS termination/session deployment contract is provided.
- **Policy / status:** Current workflow is local development; database URLs are explicit and secrets must stay out of logs/Git.
- **Impact:** Copying development settings into public deployment would expose unsuitable credentials or transport configuration.
- **Next action:** Approve deployment origin/TLS/proxy/secret procedures before public exposure; preserve local workflow.
- **Related:** DEC-003.

<a id="ops-003"></a>

### OPS-003 — Health is liveness, not operational readiness

- **Category / status:** OPS / OPEN. **Severity / priority:** MEDIUM / UNDECIDED.
- **Component / phase:** HTTP/operations; bootstrap. **Target:** before public deployment.
- **Evidence:** [server](../src/transport/server.ts); [main](../src/main.ts); [README](../README.md).
- **Concern:** /health always reports process liveness; database is checked at startup only.
- **Policy / status:** Liveness semantics are documented; readiness semantics and alerting are not established.
- **Impact:** A healthy response cannot prove ongoing database availability or Match progression.
- **Next action:** Decide needed readiness and alerts at deployment integration; do not change liveness implicitly.
- **Related:** OPS-001, DEC-010.

### RISK records

<a id="risk-001"></a>

### RISK-001 — Username timing discrepancy mitigated

- **Category / status:** RISK / RESOLVED. **Severity / priority:** MEDIUM / UNDECIDED.
- **Component / phase:** Authentication; Slice 1/2. **Target:** before public deployment.
- **Evidence:** [Slice 2 contract](low-level-design.md#57-http-api); [authentication tests](../tests/authentication.test.ts); [session tests](../tests/sessions.test.ts); [authenticatePlayer](../src/application/authenticate-player.ts); [identity tests](../tests/player-identity.test.ts).
- **Concern (historical baseline before Slice 2):** Missing credentials return invalid_credentials before Argon2 verification; wrong passwords perform verification.
- **Policy / status:** Slice 2 adds compatible-cost dummy Argon2id verification for unknown usernames and generic 401 responses. tests/login.test.ts and tests/authentication.test.ts verify the path and response equivalence; no perfect timing-equality guarantee is claimed.
- **Impact:** A public login endpoint could allow statistical username enumeration. No public login exists yet.
- **Next action:** Preserve regression coverage and the approved contract; related deferred integration remains separate.
- **Related:** DEC-004, DEF-001.

<a id="risk-002"></a>

### RISK-002 — Login abuse controls implemented

- **Category / status:** RISK / RESOLVED. **Severity / priority:** HIGH / UNDECIDED.
- **Component / phase:** Authentication/transport; Slice 2. **Target:** before public deployment.
- **Evidence:** [Slice 2 contract](low-level-design.md#57-http-api); [authentication tests](../tests/authentication.test.ts); [session tests](../tests/sessions.test.ts); [System §17](system-design.md#17-security-and-fairness); [server](../src/transport/server.ts); [authentication](../src/application/authenticate-player.ts).
- **Concern (historical baseline before Slice 2):** No login route, login-specific bounds, throttling, or credential-stuffing controls are implemented.
- **Policy / status:** Slice 2 implements canonical failure/IP windows, fail-fast concurrency limits, bounded keys and cleanup. Deterministic service/HTTP tests cover boundary, expiry, outage and saturation behavior. Distributed attackers and production tuning remain hardening concerns.
- **Impact:** Public password verification without controls permits guessing and CPU/memory abuse.
- **Next action:** Preserve regression coverage and the approved contract; related deferred integration remains separate.
- **Related:** DEC-004, DEC-005.

<a id="risk-003"></a>

### RISK-003 — Private Engine outcomes must never be serialized directly

- **Category / status:** RISK / OPEN. **Severity / priority:** HIGH / UNDECIDED.
- **Component / phase:** Gateway/Presenter; Phase 4. **Target:** before public deployment.
- **Evidence:** [LLD §§4.8,5.5](low-level-design.md#48-client-presenter--projection); [Engine](../src/domain/match-engine.ts); [boundary notes](../src/README.md).
- **Concern:** Internal outcomes include answer keys, private submissions and bigint results. Slice 3 adds an explicit WAITING-only Presenter; active-phase and FINISHED projections remain absent.
- **Policy / status:** Only phase-safe viewer projections may leave the backend.
- **Impact:** Direct forwarding would leak answers/private data and mishandle bigint JSON. The lobby Gateway emits only allowlisted ACKs/snapshots; internal outcomes remain private.
- **Next action:** Preserve Slice 3 disclosure tests and implement viewer-safe active/finished projections before exposing those commands. This broader record remains OPEN.
- **Related:** DEF-002.

<a id="risk-004"></a>

### RISK-004 — Development dependency advisories remain unremediated

- **Category / status:** RISK / OPEN. **Severity / priority:** MEDIUM / UNDECIDED.
- **Component / phase:** Runtime and development dependencies; Slice 2 verification. **Target:** before public deployment.
- **Evidence:** Fresh `npm audit --json`, `npm audit --omit=dev --json` and `npm ls release-it undici fastify fast-uri --all` after the focused production and release-tooling patches; [lockfile](../package-lock.json).
- **Concern:** The initial Slice 2 audit flagged 15 entries (1 low, 13 moderate, 1 high); the production patch reduced this to 13 development entries. After the release-tooling patch, **11 Moderate development-only entries remain**, all from the minimatch/lint-tool dependency chain. No High findings remain, and the production audit still reports **zero vulnerabilities**.
- **Policy / status:** The production patch updated Fastify 5.12.5 → 5.12.6, fast-uri 4.2.1 → 4.2.3 and nested Ajv fast-uri 3.1.8 → 3.1.9. The subsequent release-tooling patch pins release-it 21.1.2 and resolves undici 7.30.1 through normal npm resolution; its incremental lockfile changes only those two package records and the root release-it pin. Production records remain intact, without a direct fast-uri dependency or new overrides. ESLint, TypeScript-ESLint and minimatch remain unchanged; this record stays OPEN. tldts 7.4.19 was not flagged.
- **Verification:** Full suite with disposable PostgreSQL: **147 passed, 0 failed, 0 skipped**; seven targeted S2-01 encoded-route tests passed. Release/changelog verification: **21 passed**, including nine release lifecycle tests, using disposable local Git repositories with networking disabled; no remote GitLab access or actual-repository releases. Typecheck/build and scoped lint/format checks passed. Authenticated smoke passed HTTP health, Socket.IO polling/WebSocket, real PostgreSQL encoded login/profile/logout and revocation; backend SIGTERM shutdown exited 0. No source or migration changes. The five manual-script lint errors and six formatting failures remain TEST-005.
- **Impact:** Remaining risk concerns crafted glob patterns processed by development tooling, not HTTP or Socket.IO input. Severity is now MEDIUM after removing the High undici findings; no exploitation is asserted.
- **Next action:** Review the remaining lint-tool advisory separately. A patched minimatch major is outside current parent ranges; do not force an override or apply npm's suggested toolchain downgrades without compatibility validation. Revalidate release tooling on future upgrades.
- **Related:** TEST-003.

| Package / installed version | Audit severity | Advisory references | Remediation status |
|---|---|---|---|
| fast-uri 4.2.3; nested ajv copy 3.1.9 | moderate (historical) | [GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp), [GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg), [GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr), [GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h) | Resolved by patch; absent from production audit |
| fastify 5.12.6 | low (historical) | [GHSA-389g-gv7q-r4x8](https://github.com/advisories/GHSA-389g-gv7q-r4x8) | Resolved by patch; absent from production audit |
| minimatch 10.2.6 | moderate | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | Open; no remediation applied |
| undici 7.30.1 via release-it 21.1.2 | high (historical) | [GHSA-2m5v-pch6-74hx](https://github.com/advisories/GHSA-2m5v-pch6-74hx), [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685), [GHSA-4w7w-5xrc-9h26](https://github.com/advisories/GHSA-4w7w-5xrc-9h26), [GHSA-55wc-3pg8-jfw6](https://github.com/advisories/GHSA-55wc-3pg8-jfw6), [GHSA-9fm3-97px-rjf6](https://github.com/advisories/GHSA-9fm3-97px-rjf6), [GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472), [GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm), [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) | Resolved by release-tooling patch; undici and release-it absent from full audit |

Remaining propagated Moderate entries: `@eslint-community/eslint-utils` 4.10.1, `@eslint/config-array` 0.23.5, `@eslint/js` 10.0.1, `@typescript-eslint/eslint-plugin` 8.71.1, `@typescript-eslint/parser` 8.71.1, `@typescript-eslint/type-utils` 8.71.1, `@typescript-eslint/typescript-estree` 8.71.1, `@typescript-eslint/utils` 8.71.1, `eslint` 10.12.0, `typescript-eslint` 8.71.1. Together with minimatch these are the 11 remaining entries, not 11 independent advisories.

<a id="risk-005"></a>

### RISK-005 — A3-01: Redundant WAITING lobby profile enrichment

- **Category / status:** RISK / RESOLVED. **Severity / priority:** MEDIUM / P2 (independent audit recommendation).
- **Component / phase:** Lobby Gateway publication; Phase 4 Slice 3. **Target:** before public deployment.
- **Evidence:** [publication guards](../src/transport/lobby-gateway.ts); six A3-01 regressions in [lobby tests](../tests/lobby.test.ts).
- **Concern:** Cached command ACKs triggered profile lookups before delivered-version checks. The independent audit observed 40 pending lookups from 20 cached Create retries in a two-player Match; no duplicate mutation or unauthorized delivery was demonstrated.
- **Remediation:** Check connected subscriptions, current membership and delivered versions before enrichment. A local latest-version marker coalesces equivalent in-flight requests per Match; superseded work cannot clear a newer marker. Completion/failure removes the marker, permitting a later valid event to retry incomplete delivery. Final session/membership/version checks and historical ACKs remain unchanged; close clears bookkeeping and suppresses pending delivery.
- **Verification:** Three regressions failed before remediation (80 versus 0, 82 versus 2 and 21 versus 1 lookups), then passed. Six focused regressions cover retries, coalescing, failed-enrichment recovery, superseded work, disconnect and closure. Full suite with disposable PostgreSQL: **169 passed, 0 failed, 0 skipped**; lobby suite: **21 passed, 0 failed, 0 skipped**; S2-01 security regressions: **7 passed, 0 failed, 0 skipped**. Typecheck/build and scoped lint/format passed.
- **Remaining scope:** Already-started reads for superseded real mutations may finish; no SQL cancellation, general database-stall recovery, background retries or new shutdown dependency was introduced. Existing manual-script debt and dependency advisories remain open.
- **Next action:** Preserve lookup-count, replay, authorization, ordering and shutdown regressions. No new publication infrastructure is required.
- **Related:** LIM-003, RISK-003, TEST-005.

### DEBT records

<a id="debt-001"></a>

### DEBT-001 — Repository guidance contains obsolete implementation descriptions

- **Category / status:** DEBT / OPEN. **Severity / priority:** LOW / UNDECIDED.
- **Component / phase:** Documentation; bootstrap through Slice 1. **Target:** later hardening.
- **Evidence:** [AGENTS Scope/Structure](../AGENTS.md); [boundary notes](../src/README.md); [HLD §19](HLD_Component_Diagram.md#19-dependency-direction).
- **Concern:** AGENTS still says no gameplay/authentication/schema; some boundary descriptions refer to earlier phases and NestJS remains in complementary docs.
- **Policy / status:** System §20 and approved stack use Fastify; current code supplies gameplay and identity.
- **Impact:** Future contributors may underestimate existing behavior or choose obsolete terminology.
- **Next action:** Request a focused guidance refresh; preserve authoritative contracts and ownership.
- **Related:** —.

<a id="debt-002"></a>

### DEBT-002 — Competition ranking clarification is not fully in frozen baseline

- **Category / status:** DEBT / OPEN. **Severity / priority:** LOW / UNDECIDED.
- **Component / phase:** Ranking documentation; Phase 2C. **Target:** current demo.
- **Evidence:** [System §13](system-design.md#13-scoring-and-ranking); [boundary notes](../src/README.md); [completion tests](../tests/match-completion.test.ts).
- **Concern:** Code/tests and boundary notes specify competition ranking (1,1,3); baseline specifies shared ranks but not rank gaps.
- **Policy / status:** Repository notes attribute competition ranking to explicit M1 clarification; implementation preserves exact ties.
- **Impact:** A later implementation could choose dense ranking from baseline wording alone.
- **Next action:** Approve a separate surgical baseline amendment; do not reopen tested ranking behavior.
- **Related:** —.

### DEC records

<a id="dec-001"></a>

### DEC-001 — Session storage and restart contract decided

- **Category / status:** DEC / RESOLVED. **Severity / priority:** UNDETERMINED / UNDECIDED.
- **Component / phase:** Authentication; Slice 2. **Target:** before public deployment.
- **Evidence:** [Slice 2 contract](low-level-design.md#57-http-api); [authentication tests](../tests/authentication.test.ts); [session tests](../tests/sessions.test.ts); [LLD §§4.9,5.7,10.1](low-level-design.md#57-http-api); [DFD §1](Data_Flow_Diagram.md#1-authentication-flow).
- **Concern (historical baseline before Slice 2):** Password verification establishes no HTTP or realtime session.
- **Policy / status:** Approved Slice 2: process-local opaque server-side sessions, SHA-256 token digests and 256-bit random tokens. Restart loses sessions; durable Player identity survives.
- **Impact:** Determines revocation, restart behavior, schema and runtime dependencies.
- **Next action:** Preserve regression coverage and the approved contract; related deferred integration remains separate.
- **Related:** DEF-001.

<a id="dec-002"></a>

### DEC-002 — Session lifecycle and activity contract decided

- **Category / status:** DEC / RESOLVED. **Severity / priority:** UNDETERMINED / UNDECIDED.
- **Component / phase:** Authentication/socket lifecycle; Slice 2. **Target:** before public deployment.
- **Evidence:** [Slice 2 contract](low-level-design.md#57-http-api); [authentication tests](../tests/authentication.test.ts); [session tests](../tests/sessions.test.ts); [LLD §§5.7,10.1](low-level-design.md#101-open-questions).
- **Concern (historical baseline before Slice 2):** No expiration durations, rotation, logout scope, concurrent-session rules or existing-socket revocation semantics are frozen.
- **Policy / status:** Approved Slice 2: 30-minute idle, 12-hour absolute; intentional authenticated actions alone refresh idle. Independent sessions coexist; logout revokes current session and closes its sockets. Future synchronous Gateway admission remains DEF-002.
- **Impact:** Long-lived sockets need explicit authorization validity; logout must have defined scope.
- **Next action:** Preserve regression coverage and the approved contract; related deferred integration remains separate.
- **Related:** DEC-001, DEC-003.

<a id="dec-003"></a>

### DEC-003 — Cookie, Origin and handshake contract decided

- **Category / status:** DEC / RESOLVED. **Severity / priority:** HIGH / UNDECIDED.
- **Component / phase:** HTTP/Socket.IO; Slice 2. **Target:** before public deployment.
- **Evidence:** [Slice 2 contract](low-level-design.md#57-http-api); [authentication tests](../tests/authentication.test.ts); [session tests](../tests/sessions.test.ts); [LLD §§5.2,5.7](low-level-design.md#52-realtime-command-envelope); [server](../src/transport/server.ts); [System §17](system-design.md#17-security-and-fairness).
- **Concern (historical baseline before Slice 2):** Transport mechanism, route DTOs, browser origins, cookie attributes and handshake protection remain unspecified.
- **Policy / status:** Approved Slice 2: HTTPS __Host cookie, strict configured Origin/JSON demo CSRF posture, same-site credentialed CORS, explicit trusted proxies, actual-loopback development exception; polling and WebSocket authenticate server-session identity. Approved safe-GET clarification: /auth/profile allows absent Origin without Referer; present null/disallowed origins reject. Sessions, no idle refresh and no-store remain mandatory. POST login/logout and Socket.IO keep mandatory Origin. No frontend topology is selected.
- **Impact:** Unsafe browser defaults could enable credential theft, request forgery or unauthorized socket access.
- **Next action:** Preserve regression coverage and the approved contract; related deferred integration remains separate.
- **Related:** DEC-001, OPS-002.

<a id="dec-004"></a>

### DEC-004 — Login resource and abuse policy decided

- **Category / status:** DEC / RESOLVED. **Severity / priority:** HIGH / UNDECIDED.
- **Component / phase:** Authentication security; Slice 2. **Target:** before public deployment.
- **Evidence:** [Slice 2 contract](low-level-design.md#57-http-api); [authentication tests](../tests/authentication.test.ts); [session tests](../tests/sessions.test.ts); [System §17](system-design.md#17-security-and-fairness); [LLD §8](low-level-design.md#8-error--validation-model); [authentication](../src/application/authenticate-player.ts).
- **Concern (historical baseline before Slice 2):** Exact input sizes, Unicode handling, rate keys/windows and timing strategy are not frozen.
- **Policy / status:** Approved Slice 2: 4 KiB JSON, exact fields, ASCII canonical username 1–128 bytes, unchanged password 1–1024 UTF-8 bytes; 60 attempts/IP and 10 credential failures/name per 15 minutes, at most four concurrent verifications and no queue. This does not decide password-creation policy.
- **Impact:** Policy affects abuse resistance, resource use and legitimate clients.
- **Next action:** Preserve regression coverage and the approved contract; related deferred integration remains separate.
- **Related:** RISK-001, RISK-002.

<a id="dec-005"></a>

### DEC-005 — Password creation policy remains undecided

- **Category / status:** DEC / OPEN. **Severity / priority:** UNDETERMINED / UNDECIDED.
- **Component / phase:** Provisioning; Slice 1/future authentication. **Target:** undecided.
- **Evidence:** [Database §4.2](database-design.md#42-password_credential); [provisionPlayer](../src/application/authenticate-player.ts); [hashing](../src/application/password.ts).
- **Concern:** Argon2id is implemented; password length/complexity and account lifecycle are not specified.
- **Policy / status:** Internal/test provisioning only; no registration/reset.
- **Impact:** Future provisioning rules must agree with accepted login input bounds.
- **Next action:** Approve creation policy when needed; keep Unicode/size transport protection distinct.
- **Related:** DEC-004.

<a id="dec-006"></a>

### DEC-006 — Host departure and active disconnect policy

- **Category / status:** DEC / OPEN. **Severity / priority:** UNDETERMINED / UNDECIDED.
- **Component / phase:** Lobby/gameplay; Phase 1 onward. **Target:** future design.
- **Evidence:** [System §5](system-design.md#5-important-open-questions); [LLD §10.2](low-level-design.md#102-explicitly-deferred); [lobby tests](../tests/match-engine.test.ts).
- **Concern:** Host leave returns unsupported; active disconnect/reconnect/leave policy is unresolved.
- **Policy / status:** No automatic Host transfer, grace period or replacement bot.
- **Impact:** Transport disconnects, including auth expiry, cannot silently authorize gameplay membership changes.
- **Next action:** Obtain explicit gameplay policy before implementing departure/recovery; Slice 2 reconnect authenticates only.
- **Related:** DEC-002, DEC-012.

<a id="dec-007"></a>

### DEC-007 — Enabled earlyClose behavior

- **Category / status:** DEC / OPEN. **Severity / priority:** UNDETERMINED / UNDECIDED.
- **Component / phase:** Match rules; future gameplay. **Target:** future design.
- **Evidence:** [LLD §§2.7,4.6,10.2](low-level-design.md#27-match-rules); [System §5](system-design.md#5-important-open-questions).
- **Concern:** earlyClose=false is approved; true has no approved timing policy.
- **Policy / status:** No all-answered shortcut, settle window or deadline reset.
- **Impact:** Enabling it would alter fairness/deadline semantics.
- **Next action:** Keep disabled until explicit rule approval.
- **Related:** —.

<a id="dec-008"></a>

### DEC-008 — Other SQL identifiers and deletion/retention policy

- **Category / status:** DEC / OPEN. **Severity / priority:** UNDETERMINED / UNDECIDED.
- **Component / phase:** Persistence; Phase 4 onward. **Target:** undecided.
- **Evidence:** [Database §§4,15](database-design.md#15-open-and-deferred-database-decisions).
- **Concern:** Only Player IDs and referencing FKs have approved UUID representation; other SQL IDs and deletion/retention remain open.
- **Policy / status:** Player UUID does not determine Match/History SQL type.
- **Impact:** Blocks final completed-History migration choices and lifecycle operations.
- **Next action:** Approve narrowly needed types before completion schema; do not invent deletion rules.
- **Related:** DEF-003.

<a id="dec-009"></a>

### DEC-009 — External History pagination and participant count

- **Category / status:** DEC / OPEN. **Severity / priority:** UNDETERMINED / UNDECIDED.
- **Component / phase:** History; Phase 4. **Target:** undecided.
- **Evidence:** [Database §§8.2,15](database-design.md#82-player-history-list); [LLD §10.1](low-level-design.md#101-open-questions).
- **Concern:** Cursor/page limits/error metadata and stored-versus-derived count remain open.
- **Policy / status:** Own chronological SQL-limited access and participation-authorized Detail are settled.
- **Impact:** Affects external API and physical count representation.
- **Next action:** Approve API details before History integration; preserve existing indexes/access rules.
- **Related:** DEF-003.

<a id="dec-010"></a>

### DEC-010 — Capacity and operational service targets

- **Category / status:** DEC / OPEN. **Severity / priority:** UNDETERMINED / UNDECIDED.
- **Component / phase:** Runtime/operations; M1. **Target:** undecided.
- **Evidence:** [System §5 Product and Operations](system-design.md#5-important-open-questions).
- **Concern:** Concurrent-Match capacity, latency, availability and RTO/RPO targets are unspecified.
- **Policy / status:** One process, no distributed ownership, accepted availability limitations.
- **Impact:** Cannot quantify memory headroom or production service guarantees.
- **Next action:** Define demo/deployment load and targets before claiming capacity.
- **Related:** LIM-003, OPS-003.

<a id="dec-011"></a>

### DEC-011 — Question selection, source lineage and Provider failures

- **Category / status:** DEC / OPEN. **Severity / priority:** UNDETERMINED / UNDECIDED.
- **Component / phase:** Question Provider; Phase 4. **Target:** undecided.
- **Evidence:** [LLD §4.7](low-level-design.md#47-question-provider); [System §16](system-design.md#16-reliability-and-failure-considerations); [Database §§13,15](database-design.md#13-question-bank-boundary).
- **Concern:** Engine accepts ten validated ordered questions; Provider implementation/selection policy and permanent source lineage are unsettled. Failure must not partially open a round.
- **Policy / status:** No randomization/authoring policy may be inferred.
- **Impact:** Playable integration needs approved content provisioning and a safe failure boundary.
- **Next action:** Choose minimal approved source/provisioning and define failure handling at Start; leave authoring/lineage policies deferred.
- **Related:** DEF-002.

<a id="dec-012"></a>

### DEC-012 — Future recovery and interrupted-admission fairness

- **Category / status:** DEC / OPEN. **Severity / priority:** UNDETERMINED / UNDECIDED.
- **Component / phase:** Recovery; after M1. **Target:** future design.
- **Evidence:** [System §§15–16](system-design.md#16-reliability-and-failure-considerations); [LLD §10.2](low-level-design.md#102-explicitly-deferred).
- **Concern:** No approved recovery exists for stalled/restarted Matches or intervals when clients could not submit.
- **Policy / status:** Snapshot restoration alone does not authorize deadline reset, replay, compensation or fair resume.
- **Impact:** Accepted submissions, attempts, timing, scores and idempotency could be lost or unfairly changed by recovery.
- **Next action:** Require separate design for state restoration, timer reconciliation and fairness before any recovery implementation.
- **Related:** LIM-001, LIM-002, DEC-006.

<a id="dec-013"></a>

### DEC-013 — Broader product and anti-cheat requirements

- **Category / status:** DEC / OPEN. **Severity / priority:** UNDETERMINED / UNDECIDED.
- **Component / phase:** Product; future design. **Target:** future design.
- **Evidence:** [System §5](system-design.md#5-important-open-questions); [System §17](system-design.md#17-security-and-fairness).
- **Concern:** Spectators, accessibility/localization, deeper anti-cheat and dispute/audit requirements remain open.
- **Policy / status:** These are not authorization for new infrastructure or gameplay rules.
- **Impact:** Unknown scope prevents promises beyond current M1 boundaries.
- **Next action:** Resolve when product scope requires; no CAPTCHA requirement is implied.
- **Related:** —.

### TEST records

<a id="test-001"></a>

### TEST-001 — Real PostgreSQL verification is conditional

- **Category / status:** TEST / OPEN. **Severity / priority:** MEDIUM / UNDECIDED.
- **Component / phase:** Test infrastructure; bootstrap/Slice 1. **Target:** current demo.
- **Evidence:** [identity tests](../tests/player-identity.test.ts); [Postgres tests](../tests/postgres.test.ts); [README verification](../README.md).
- **Concern:** Real database tests skip without TEST_DATABASE_URL; fixtures verify a *_test database before identity writes.
- **Policy / status:** Source tests are available; this registry task did not execute them and has no durable CI result archive.
- **Impact:** A green default suite alone does not prove migration/authentication integration.
- **Next action:** Run and retain real isolated PostgreSQL results at integration gates.
- **Related:** TEST-002.

<a id="test-002"></a>

### TEST-002 — Migration rollback and concurrent-run coverage is incomplete

- **Category / status:** TEST / OPEN. **Severity / priority:** MEDIUM / UNDECIDED.
- **Component / phase:** Migration runner; Slice 1. **Target:** before public deployment.
- **Evidence:** [runner](../src/persistence/migrations.ts); [identity tests](../tests/player-identity.test.ts).
- **Concern:** Runner uses one transaction, advisory lock and checksums. Tests repeat normal migration execution and test provisioning rollback; Slice 2 now tests migration 002 collision/invalid-value rollback, ledger integrity and concurrent runs; generalized failure injection after arbitrary migration writes remains untested.
- **Policy / status:** Migration 002 safety and concurrency now have real PostgreSQL coverage. This record retains only broader migration-failure injection coverage beyond preflight failures.
- **Impact:** Migration regressions could escape normal-path tests.
- **Next action:** Add isolated failing/concurrent migration cases when authorized; distinguish provisioning rollback from migration rollback.
- **Related:** TEST-001.

<a id="test-003"></a>

### TEST-003 — Dependency advisory status verified

- **Category / status:** TEST / RESOLVED. **Severity / priority:** UNDETERMINED / UNDECIDED.
- **Component / phase:** Dependencies/release; bootstrap onward. **Target:** before public deployment.
- **Evidence:** [Slice 2 contract](low-level-design.md#57-http-api); [authentication tests](../tests/authentication.test.ts); [session tests](../tests/sessions.test.ts); [README release tooling](../README.md); [manifest](../package.json); [lockfile](../package-lock.json).
- **Concern (historical baseline before Slice 2):** README records a targeted basic-ftp override; manifest pins that override to 6.2.3. No saved npm-audit report or current advisory query was available in this review.
- **Policy / status:** An npm audit --json run during Slice 2 confirmed 15 flagged dependency entries (1 low, 13 moderate, 1 high); exact installed roots and advisory links are retained in RISK-004. This closes audit availability only, not remediation.
- **Impact:** Exposure and remediation completeness cannot be quantified from override presence alone.
- **Next action:** Preserve regression coverage and the approved contract; related deferred integration remains separate.
- **Related:** —.

<a id="test-004"></a>

### TEST-004 — Authenticated Match-to-History end-to-end verification absent

- **Category / status:** TEST / OPEN. **Severity / priority:** HIGH / UNDECIDED.
- **Component / phase:** Integration; Phase 4. **Target:** current demo.
- **Evidence:** [LLD §9.9](low-level-design.md#99-end-to-end-critical-path); [transport tests](../tests/server.test.ts); [main](../src/main.ts).
- **Concern:** Tests cover domain/runtime and raw transport separately; authentication sessions, Gateway/Presenter and completed persistence are not composed.
- **Policy / status:** Later Phase 4 work; not a defect in completed pure slices.
- **Impact:** Cannot claim one authenticated playable durable M1 Match works end to end.
- **Next action:** After required integrations, test two authenticated Players through FINISHED, atomic persistence and authorized History.
- **Related:** DEF-001, DEF-002, DEF-003.

<a id="test-005"></a>

### TEST-005 — Full-checkout manual scripts fail existing lint rules

- **Category / status:** TEST / OPEN. **Severity / priority:** LOW / UNDECIDED.
- **Component / phase:** Developer verification; Phase 3 manual scripts/Slice 2. **Target:** later hardening.
- **Evidence:** [manual deadline](../manual-deadline-test.ts), [scheduler failure](../manual-scheduler-failure-test.ts), [shutdown](../manual-shutdown-test.ts); full-checkout npm run check executed in mounted Docker workspace.
- **Concern:** Five pre-existing unused underscore-prefixed parameter lint errors stop full-checkout check. Official tools image does not copy these root manual scripts, so its full check passes.
- **Policy / status:** Manual scripts and lint rules left unchanged to preserve slice scope. This is distinct from new authentication verification.
- **Impact:** Native/full-checkout check and official image check cover different files.
- **Next action:** Approve focused manual-script lint cleanup or an explicit verification-scope rule; do not claim the full checkout passed.
- **Related:** DEBT-001.

### DEF records

<a id="def-001"></a>

### DEF-001 — Trusted HTTP and Socket.IO sessions integrated

- **Category / status:** DEF / RESOLVED. **Severity / priority:** HIGH / UNDECIDED.
- **Component / phase:** Transport/authentication; Slice 2. **Target:** current demo.
- **Evidence:** [Slice 2 contract](low-level-design.md#57-http-api); [authentication tests](../tests/authentication.test.ts); [session tests](../tests/sessions.test.ts); [LLD §§4.2,5.7](low-level-design.md#57-http-api); [server](../src/transport/server.ts); [main](../src/main.ts).
- **Concern (historical baseline before Slice 2):** Only health and unauthenticated connectivity are exposed; internal verification is not wired into transports.
- **Policy / status:** Slice 2 wires the PostgreSQL verifier and SessionStore into main, HTTP routes and polling/WebSocket authentication. Tests exercise real listeners, origins, logout/expiry and session isolation. Gameplay Gateway commands remain DEF-002, not completed by handshake authentication.
- **Impact:** Current server is not an authenticated playable application.
- **Next action:** Preserve regression coverage and the approved contract; related deferred integration remains separate.
- **Related:** DEC-001, DEC-002, DEC-003.

<a id="def-002"></a>

### DEF-002 — Safe playable runtime composition remains pending

- **Category / status:** DEF / OPEN. **Severity / priority:** HIGH / UNDECIDED.
- **Component / phase:** Gateway/Presenter/Provider; Phase 4. **Target:** current demo.
- **Evidence:** [HLD §§3,10–11](HLD_Component_Diagram.md#3-realtime-gateway); [main](../src/main.ts); [boundary notes](../src/README.md).
- **Concern:** Slice 3 now wires one shared Coordinator into main and implements authenticated Create/Join/non-Host Leave, per-socket subscriptions and a WAITING Presenter. Start/Answer transport, active-phase projections, Question Provider and timer-driven delivery remain absent.
- **Policy / status:** Lobby admission runs synchronously inside SessionStore.act; snapshot delivery uses non-refreshing inspect. Replays retain historical ACKs without reapplying subscriptions. Trusted profile enrichment happens after commit, and failure preserves accepted outcomes with safe diagnostics. Full playable integration remains OPEN.
- **Verification:** Slice 3 full suite: 163 passed, 0 failed, 0 skipped with disposable PostgreSQL; S2-01 regressions: 7 passed. A clean tools-image `npm run check`, Compose backend/PostgreSQL health checks, two-client authenticated lobby smoke and active-client SIGTERM shutdown passed. Full-checkout manual-script lint/format debt remains TEST-005.
- **Impact:** The backend supports a multiplayer WAITING lobby, not a complete playable M1 Match.
- **Next action:** Add approved question provisioning and active-phase Gateway/Presenter integration in later slices; preserve FIFO, session admission and private-state isolation.
- **Related:** RISK-003, DEC-011, TEST-004.

<a id="def-003"></a>

### DEF-003 — Completed persistence and authorized History pending

- **Category / status:** DEF / OPEN. **Severity / priority:** HIGH / UNDECIDED.
- **Component / phase:** Persistence/History; Phase 4. **Target:** current demo.
- **Evidence:** [Database §§9–11](database-design.md#9-completed-match-persistence); [migrations](../migrations/001_player_identity.sql); [LLD §6.9](low-level-design.md#69-persist-completed-match).
- **Concern:** No completion tables/repository/History routes exist.
- **Policy / status:** One immutable result must commit atomically; identical full-result retries succeed and conflicting results fail; Detail requires participation.
- **Impact:** FINISHED is not durable History success; process loss before commit has no crash-recovery guarantee.
- **Next action:** Implement transaction and full-result comparison, then authorized bounded History and rollback/retry tests.
- **Related:** DEC-008, DEC-009, TEST-004.

<a id="def-004"></a>

### DEF-004 — Account recovery and advanced authentication excluded

- **Category / status:** DEF / ACCEPTED. **Severity / priority:** UNDETERMINED / UNDECIDED.
- **Component / phase:** Authentication; beyond current M1. **Target:** future design.
- **Evidence:** [HLD §12](HLD_Component_Diagram.md#12-authentication); [Database §4.2](database-design.md#42-password_credential).
- **Concern:** No public registration, password recovery, OAuth, email verification or MFA is implemented.
- **Policy / status:** Advanced mechanisms are outside current M1; internal/test provisioning exists.
- **Impact:** M1 accounts require controlled provisioning; no self-service recovery promise.
- **Next action:** Keep excluded unless explicitly approved; do not add a CLI merely for completeness.
- **Related:** DEC-005.

<a id="def-005"></a>

### DEF-005 — Bots, tournaments and human score formatting deferred

- **Category / status:** DEF / ACCEPTED. **Severity / priority:** LOW / UNDECIDED.
- **Component / phase:** Product/projection; future phases. **Target:** future design.
- **Evidence:** [LLD §10.2](low-level-design.md#102-explicitly-deferred); [HLD §21](HLD_Component_Diagram.md#21-future-extension-boundaries).
- **Concern:** Bots/tournament orchestration and human-facing decimal formatting are deferred.
- **Policy / status:** Extensions must preserve pure Engine authority and exact bigint equality.
- **Impact:** Does not prevent current deterministic Engine/demo verification.
- **Next action:** Design when needed; no replacement bots or rounding changes.
- **Related:** —.

## 7. Accepted M1 limitations

LIM-001 permits post-commit scheduling failure to stall progress, preserving authoritative state and the accepted receipt. LIM-002 accepts active-process loss. LIM-003 retains aggregates/retry outcomes until shutdown, with memory growth as a consequence. These remain accepted, not silently closed. DEF-004/005 record scope exclusions rather than defects.

Stale/cancelled callbacks are **design-compliant informational behavior**, not a BUG: they may consume receipt sequence numbers, but Engine validation prevents mutation (LLD §4.5; System §16; [manual stale timer script](../manual-stale-timer-test.ts); [Coordinator tests](../tests/match-coordinator.test.ts)). Cancellation remains an optimization. No ownership guard is required solely to avoid this overhead.

## 8. Deferred design decisions and future recovery considerations

DEC-001–004 are decided by the approved Slice 2 contract in LLD §5.7; DEC-005 password-creation policy remains open. Earlier discussion recommendations were superseded only by explicit Slice 2 approval. DEC-006–013 capture gameplay, persistence, capacity, content and recovery gaps. No automatic retries, rollback, deadline extensions or fatal shutdown policy follows from this registry.

Recovery design must address accepted submissions, attempts, timing, exact scores, command idempotency, timer reconciliation and fairness during inability to submit. Distinguish in-process scheduler failure from process restart. Restoration alone does not authorize resume, abort, compensation or a new deadline (DEC-012).

Public exposure should wait for trusted transport identity, phase-safe projections, approved session/browser controls, login abuse protection and safe operational reporting (DEF-001/002, RISK-001–003, OPS-001/002). A local Engine/runtime demo can proceed under documented limitations without recovery, earlyClose, Host migration, advanced authentication, bots or tournaments. A claimed complete M1 application demo additionally needs durable completion and History (DEF-003, TEST-004).

## 9. Resolved historical issues

<a id="bug-001"></a>

### BUG-001 — Implicit PostgreSQL connection configuration

- **Category / status:** BUG / RESOLVED. **Severity / priority:** MEDIUM / UNDECIDED.
- **Component / phase:** Configuration; bootstrap. **Target:** current demo.
- **Evidence:** Git 5390ca6; [config](../src/config.ts); [Postgres regressions](../tests/postgres.test.ts).
- **Concern:** Original bootstrap passed a connection string into pg while ambient PG settings could influence configuration.
- **Policy / status:** 5390ca6 introduced explicit decoded required connection fields and poisoned-PG environment regressions, including reserved credential characters.
- **Impact:** Previously distributed settings could connect incorrectly; current tests protect the boundary.
- **Next action:** Preserve explicit DATABASE_URL authority; reverify real PostgreSQL when available.
- **Related:** TEST-001.

<a id="bug-002"></a>

### BUG-002 — Bootstrap shutdown ownership and startup races

- **Category / status:** BUG / RESOLVED. **Severity / priority:** HIGH / UNDECIDED.
- **Component / phase:** HTTP/realtime/database; bootstrap. **Target:** current demo.
- **Evidence:** Git 5390ca6; [lifecycle regressions](../tests/lifecycle.test.ts); [server](../src/transport/server.ts); [main](../src/main.ts).
- **Concern:** Earlier cleanup coupled Socket.IO and Fastify close operations and had separate startup/failure paths.
- **Policy / status:** 5390ca6 establishes one cleanup owner/order, signal-aware startup and nonzero failure status; tests cover listener and Engine.IO cleanup counts.
- **Impact:** Duplicate closes, incomplete cleanup or misleading process results were possible in earlier bootstrap.
- **Next action:** Preserve lifecycle regressions during future transport wiring. Tests were inspected, not rerun here.
- **Related:** —.

<a id="bug-003"></a>

### BUG-003 — Lobby version could advance outside safe integer range

- **Category / status:** BUG / RESOLVED. **Severity / priority:** MEDIUM / UNDECIDED.
- **Component / phase:** Engine; Phase 1/2A. **Target:** current demo.
- **Evidence:** Git 3190d04; [lobby overflow regression](../tests/match-engine.test.ts); [nextVersion](../src/domain/match-engine.ts).
- **Concern:** Phase 1 membership used version + 1 without a safe-integer advancement guard.
- **Policy / status:** Phase 2A adds nextVersion and regression; later transitions also have overflow tests.
- **Impact:** Unsafe versions would violate mutation/version ordering at the numeric boundary.
- **Next action:** Keep guard and mutation-only increment tests; no active defect established.
- **Related:** —.

<a id="bug-004"></a>

### BUG-004 — S2-01: Encoded authentication routes bypassed HTTP security

- **Category / status:** BUG / RESOLVED. **Severity / priority:** HIGH / P0 (approved focused remediation).
- **Component / phase:** HTTP authentication; Phase 4 Slice 2. **Target:** current demo, before public deployment.
- **Evidence:** [route enforcement](../src/transport/authentication.ts); [encoded-path regressions](../tests/authentication.test.ts); approved [LLD §5.7 contract](low-level-design.md#57-http-api).
- **Concern:** Fastify routed `/%61uth/login`, logout and profile aliases to authentication handlers, while a raw `/auth/` prefix check skipped transport/Origin/JSON enforcement, login IP accounting and no-store headers. Endpoint encodings also bypassed raw-path-specific decisions. Credential verification and session requirements were not bypassed.
- **Remediation:** Attach the shared `onRequest` hook directly to login, logout, profile and preflight routes. Fastify routing precedes this hook; registered `routeOptions.url` supplies identity for login accounting and the safe read-only profile exception. No custom URL decoding, session-policy change or Socket.IO change.
- **Verification:** Seven targeted tests failed against the vulnerable implementation and passed after remediation. Coverage includes normal paths, encoded prefixes/endpoints, mixed encodings with query strings, Origin cases, shared 60-attempt IP window, transport rejection before parsing, JSON/body bounds, preflight, no-store and profile non-refresh behavior, plus a real HTTP listener. Full suite: **147 passed, 0 failed, 0 skipped**, including disposable PostgreSQL migration/identity tests and existing Socket.IO/session tests. Typecheck, temporary-output build and scoped source/test/script lint/format checks passed. Existing authenticated smoke passed HTTP health and both Socket.IO transports; real backend SIGTERM shutdown exited 0.
- **Remaining scope:** Full-checkout lint still reports five pre-existing manual-script errors and formatting flags six manual scripts. Dependency advisories remain open. Browser/TLS deployment and future Gateway admission are separate verification/integration work.
- **Next action:** Preserve route-level protection and encoded-path regressions on future authentication routes. No remaining S2-01 bypass was found in the reviewed routes.
- **Related:** RISK-002, RISK-004, TEST-005, DEF-002.

## 10. Historical coverage and evidence limitations

| Stage | Available history and evidence | Interpretation |
|---|---|---|
| Foundation/bootstrap | 4743592, 6f5e3d6, 5390ca6; configuration/transport/lifecycle tests | Historical fixes BUG-001/002; operational readiness gaps retained separately. |
| Release tooling | 8b74229; [release tests](../tests/release.test.ts), [archive tests](../tests/archive-changelog.test.ts), README | Tests exercise temporary Git repositories, plugin lifecycle/staging, idempotent archival and conflicts; no historical release defect inferred. |
| Phase 1 | 72b0daf; [lobby tests](../tests/match-engine.test.ts) | Lobby behavior protected; overflow subsequently fixed (BUG-003). |
| Phase 2A | 3190d04; [question lifecycle tests](../tests/question-lifecycle.test.ts) | Caller-owned timing, safe versions, exact deadline transitions and immutability covered in source tests. |
| Phase 2B | 34d91df; [answer tests](../tests/answer-submission.test.ts) | Exclusive 10,000ms boundary; accepted changes replace timing; same-choice no-op; three attempts; exact bigint units. These are not open scoring bugs. |
| Phase 2C | 5eee1ae; [completion tests](../tests/match-completion.test.ts) | Ten ordered questions, immutable result, terminal behavior and competition ties covered. Documentation specificity tracked in DEBT-002. |
| Phase 3 | fcaa599, 8e95f0a, ee2f5ce; [Coordinator tests](../tests/match-coordinator.test.ts), [clock tests](../tests/match-time.test.ts) | FIFO, original receipt replay, 9,999ms admission, late rejection, exceptions, shutdown drainage and timers covered; do not reopen merely because timing was difficult. |
| Manual runtime review | [create](../manual-create-test.ts), [deadline](../manual-deadline-test.ts), [timer](../manual-timer-test.ts), [shutdown](../manual-shutdown-test.ts), [stale callback](../manual-stale-timer-test.ts), [scheduler failure](../manual-scheduler-failure-test.ts) | Executable assertions are evidence of intended checks, not archived execution logs. No rerun or pass claim in this task. |
| Slice 1 | 1611d46; [migration](../migrations/001_player_identity.sql), [identity tests](../tests/player-identity.test.ts) | Player UUID, credential separation, Argon2id and explicit migrations implemented; conditional PostgreSQL coverage noted. |
| Reconciliation | 0b3fb90; System §16/§20, LLD §4.3/4.5/4.9/8.7/10.1, Database §4/§15 | Scheduler limitation, idempotency retention and UUID/provisioning contracts are now recorded; not all SQL types settled. |
| Slice 2 discussion | Approved Slice 2 task and reconciled LLD §5.7; authentication/session/migration tests | Session/security decisions now recorded. No gameplay Gateway/rejoin or password-creation policy is implied. |

Reviewed available Git history from the first commit through 0b3fb90, source/test/migration inventory, design sections, README/operations guidance and manual scripts. No dedicated historical audit reports or saved test-result/advisory logs were found among repository files inspected. External ChatGPT/Codex sessions cannot be recovered from this checkout; complete historical coverage cannot be claimed. No matching TODO/FIXME comments were found in the tracked project text search; absence of comments is not evidence of absence of issues.

Verified contracts worth preserving: server-generated Player UUIDs; native UUID Player FKs; atomic provisioning; explicit checksum-tracked migrations; no plaintext credential persistence; explicit decoded database configuration; pure immutable Engine; mutation-only versions; exact bigint scoring; per-Match synchronous FIFO admission; safe timeout validation; exception-safe queues and shutdown. The initial registry task inspected tests without executing them; Slice 2 subsequently executed the Docker full check with real PostgreSQL enabled (141 passed, zero skipped), including session/migration regressions. No present BUG is asserted without a verified violation.

Graph coverage for src/tests/migrations reported no recorded gaps (best-effort metadata); direct source reads supplied material behavior evidence. No reindexing was requested. Two .codebase-memory files were already modified at task entry and were left alone. The initial registry task ran no migrations/runtime/audit. Slice 2 used isolated PostgreSQL fixtures and captured a current dependency audit; RISK-004 records unresolved findings.

## 11. Maintenance rules

- Assign the next unused ID within the primary category. Never renumber or reuse IDs; retain references if recategorization is necessary.
- Update status and evidence when corrected or decided; preserve historical context and record resolution in §9. Do not silently close accepted limitations.
- Keep category/status/severity/priority distinct. Unknown impact stays UNDETERMINED; unscheduled work stays UNDECIDED. Record approval evidence before assigning approved policy.
- Synchronize approved design decisions with the owning authoritative document through an explicitly authorized patch. This registry never overrides System Design, LLD or Database Design.
- Keep proposals clearly labelled; a proposed mitigation is not a new requirement. Avoid copying the roadmap or duplicating one concern across categories.
- Add exact source/test/review references; distinguish executable tests from recorded execution results. Do not infer pass results from test existence.
- Update dashboard/table totals alongside records; check links, related IDs and git diff --check. Preserve resolved entries and explain closure.
