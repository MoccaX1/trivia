# Backend boundaries

`main.ts` is the composition root: configuration, database availability, listening,
and process signals. `config.ts` validates environment variables.

| Location                | Responsibility                                                                | Allowed dependencies                                                    |
| ----------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `transport/`            | Fastify HTTP and Socket.IO connections, later validation and safe delivery    | Application contracts; transport libraries                              |
| `application/` (future) | Match lookup, ordered ingress, serialization, idempotency, completion handoff | Domain and required ports; no Fastify, Socket.IO, or PostgreSQL imports |
| `domain/`               | WAITING membership, Start and question deadline lifecycle                     | Pure TypeScript; no transport, persistence, or application imports      |
| `persistence/`          | PostgreSQL connection lifecycle, later durable adapters                       | PostgreSQL and required domain/application contracts                    |

The application directory will be introduced with its first behavior;
there are no empty modules or speculative interfaces. ESLint already
restricts infrastructure imports under those paths. Define ports only when a
concrete use case needs them, following the LLD; wire adapters in `main.ts`.

`domain/match-engine.ts` exposes `createMatch`, `joinMatch`, `leaveMatch`,
`checkStartEligibility`, `startMatch`, `submitAnswer`, and `questionDeadline`. Creation takes
trusted Player identity and a server-owned ID generator; it initializes version 1. Membership changes return a new immutable
Match and increment the version once. Rejections preserve the original Match.
Start eligibility returns accepted with `changed: false`; it does not execute
Start. No WAITING membership command has an approved successful no-op (duplicate
Join rejects). Command-ID retry handling belongs to the future Coordinator.
Host leave returns an explicit unsupported outcome; departure policy is deferred.
Invalid trusted identities or corrupt internal aggregates throw programming errors,
not authentication or gameplay rejections. Phase 1 stores participant IDs only;
scores and other gameplay state are introduced with their actual behavior.

Socket.IO attaches directly to Fastify's `server`, sharing its single HTTP listener.
There are no gameplay handlers or authentication/session semantics yet. Health is
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
past scheduled target. There are no scheduling or next-round operations. Version overflow throws before mutation.

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
change subtraction, rounding or 9-second cutoff. Equal units remain equal; no
ranking or tie-breaking operation is added. These fields are private internal
state, never client DTOs. Do not serialize engine outcomes directly to clients.
