# Backend boundaries

`main.ts` is the composition root: configuration, database availability, listening,
and process signals. `config.ts` validates environment variables.

| Location       | Responsibility                                                                | Allowed dependencies                                                    |
| -------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `transport/`   | Fastify HTTP and Socket.IO connections, later validation and safe delivery    | Application contracts; transport libraries                              |
| `application/` | Match lookup, ordered ingress, serialization, idempotency, completion handoff | Domain and required ports; no Fastify, Socket.IO, or PostgreSQL imports |
| `domain/`      | WAITING membership, Start and question deadline lifecycle                     | Pure TypeScript; no transport, persistence, or application imports      |
| `persistence/` | PostgreSQL connection lifecycle and Player/Credential adapter; later History  | PostgreSQL and required domain/application contracts                    |

The application runtime owns the Registry, serialized admission and scheduling boundary. ESLint already
restricts infrastructure imports under those paths. Define ports only when a
concrete use case needs them, following the LLD; wire adapters in `main.ts`.

`domain/match-engine.ts` exposes `createMatch`, `joinMatch`, `leaveMatch`,
`checkStartEligibility`, `startMatch`, `submitAnswer`, `questionDeadline`, and `revealDeadline`. Creation takes
trusted Player identity and a server-owned ID generator; it initializes version 1. Membership changes return a new immutable
Match and increment the version once. Rejections preserve the original Match.
Start eligibility returns accepted with `changed: false`; it does not execute
Start. No WAITING membership command has an approved successful no-op (duplicate
Join rejects). Command-ID retry handling belongs to the Coordinator.
Host leave returns an explicit unsupported outcome; departure policy is deferred.
Invalid trusted identities or corrupt internal aggregates throw programming errors,
not authentication or gameplay rejections. Phase 1 stores participant IDs only;
scores and other gameplay state are introduced with their actual behavior.

Socket.IO attaches directly to Fastify's `server`, sharing its single HTTP listener.
There are no gameplay handlers yet. HTTP login/logout/profile and Socket.IO cookie authentication now resolve trusted session identity; see the root README authentication contract. Health is
process liveness, not database readiness. Startup checks PostgreSQL with `SELECT 1`.

Authority: [system design](../docs/system-design.md),
[runtime contracts](../docs/low-level-design.md),
[database design](../docs/database-design.md), and
[programming principles](../docs/programming-principles.md).

Phase 2A adds `QUESTION_OPEN` and `REVEAL` only. `startMatch` takes ten already
selected, ordered played questions and an authoritative `openedAt` clock reading.
`questionDeadline` takes Match/question/scheduled-deadline identity and the
current authoritative clock reading. Integer milliseconds share one caller-owned
clock domain (no assumed epoch); the Engine derives 10-second answer and 5-second
reveal deadlines. Reveal starts when the deadline command is applied, not at a
past scheduled target. Scheduling adapters live outside the Engine. Version overflow throws before mutation.

All engine outcomes contain **internal state**, not client acknowledgements or
snapshots. `privateQuestions` and `currentQuestion.correctChoiceId` are private
answer keys; never serialize these outcomes directly to clients. The future
Presenter must construct phase-safe projections and omit answer keys before
REVEAL. Question selection/provider operations remain deferred; this API does not
select, shuffle or assign source-content identities.

Phase 2B adds `submitAnswer(match, playerId, command, receivedAt)`. The caller
supplies trusted Player identity and authoritative ingress time separately from
the Match/question/Choice payload. Eligibility is `0 <= elapsedMs < 10_000`.
First answer is attempt 1; accepted different-choice changes increment to 3 and
replace the final answer time. Same-choice is accepted with `changed: false`
after validation; a fourth different choice rejects. Rejections/no-ops preserve
state, attempt count, timing and version. No command-ID retry cache lives here.

`privateSubmissions` contains frozen per-player answers. On question deadline,
`resolvedQuestions` retains question content and each Player's final Submission,
correctness and exact `bigint` score units (including zero for no answer).
Correctness units are 30M/15M/10M for attempts 1/2/3; speed adds
`(10_000 - finalAnsweredMs) * 3_000`. Wrong answers score zero; there is no extra
change subtraction, rounding or 9-second cutoff. Equal units remain equal; competition ranking is applied only at completion. These fields are private internal
state, never client DTOs. Do not serialize engine outcomes directly to clients.

Phase 2C completes the ten-question lifecycle. `revealDeadline(match, command, now)`
validates Match/question/reveal-deadline identity and authoritative execution time.
At or after the reveal deadline, rounds 1–9 open the next supplied question with a
fresh 10-second window starting at `now` and empty current submissions. Historical
results stay in order and retain every participant, including unanswered Players.
After question 10's reveal it enters terminal `FINISHED`; all gameplay commands
then reject with `MATCH_FINISHED` without changing version or completed facts.

`FinishedMatch.result` is an immutable `MatchResult`: Match/Host identity,
start/finish times, participant bigint totals and final ranks, plus ten ordered
resolved question snapshots and their per-player final submissions/score units.
Completion sums awarded units and uses standard competition ranking (1, 1, 3):
rank is one plus the number of participants with a strictly greater total.
No timestamp, answer order or participant order breaks ties. Participant array
order is retained solely for deterministic output. This policy follows the explicit
M1 clarification; frozen design documents remain unchanged. Engine results remain
private authoritative facts for future persistence/projection adapters.

Phase 3 adds `application/match-coordinator.ts`. Construct `MatchCoordinator`
with a `Clock`, `MatchScheduler` and server-owned Match ID generator. Use
`create(playerId, commandId)`, `dispatch(playerId, commandId, command)`,
`timeout(command)`, `lookup(matchId)`, `whenIdle(matchId)` and `shutdown()`.
The private `MatchRegistry` registers immutable aggregates, rejects duplicate IDs
and commits against the expected current aggregate; it exposes no mutable Map.
Missing Matches return `MATCH_NOT_FOUND`; malformed trusted application input
throws, while Engine rejection/unsupported/no-op outcomes remain explicit.

Admission synchronously captures `receivedAt`, assigns a per-Match receipt sequence
and appends to its FIFO Promise chain without yielding. Answers use stored ingress
time; Start and deadline transitions use a fresh authoritative execution time.
Timeouts cannot be admitted early. An already-admitted 9,999ms answer precedes a
10,000ms close barrier even if both execute later. The Clock must be monotonic;
`runtime/match-time.ts` supplies an epoch-based monotonic `SystemClock` and a
`NodeMatchScheduler` that rechecks early wakeups. No adapter is wired to HTTP or
Socket.IO in this phase.

Engine state commits before receipts are returned and before changed-phase timers
are scheduled. Answers/no-ops do not replace the existing deadline. Timer commands
carry Match/question/deadline identity and use the same FIFO path. Cancellation
is only an optimization; stale callbacks still face Engine validation. Unexpected
timer execution, cancellation and scheduling errors are retained for adapters via
`takeTimerFailures()`; a scheduling failure after commit does not replay or roll
back a committed mutation. There is no automatic retry of unexpected failures.

Approved M1 policy: player command retries are keyed by
`(matchId, playerId, commandId)`, with separate `(playerId, commandId)` Create keys.
In-flight and completed retries return the original receipt; reused IDs do not
introduce payload-conflict rules. Exceptions establish no outcome. Registered
FINISHED state and successful/missing/rejected/unsupported/no-op receipts stay
until runtime shutdown, with no TTL, eviction or release API. Idle queue chains
are discarded; FINISHED cancels timers. `shutdown()` stops admission, cancels
scheduled work, drains admitted operations, then clears retained state/caches.
Retention consumes process memory and provides no restart recovery. All runtime
outcomes remain private and require future safe projections.

Phase 4 Slice 1 adds the explicit `migrations/001_player_identity.sql` migration,
`persistence/migrations.ts` runner and `PlayerRepository`. `player.id` is a
server-generated UUID; `password_credential.player_id` is both PK and FK, and
username has a UNIQUE constraint. `application/password.ts` hashes and verifies
Argon2id; `authenticatePlayer` returns only a trusted Player profile or the same
`invalid_credentials` result for unknown username and wrong password.
`provisionPlayer` is for controlled internal/test setup, not a public endpoint.
No schema is applied during backend startup; `npm run migrate` is explicit.

Slice 2 exposes SessionStore.resolve/watch without idle refresh, and act(token,
callback) for intentional activity. The memory implementation checks validity and
invokes the callback without yielding. Future Gateway admission must occur inside
that callback, with no intervening await; already-admitted commands survive later
revocation. Socket authentication alone does not implement gameplay Gateway or rejoin.
