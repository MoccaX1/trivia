# Trivia Game System Design

Status: M1 system design baseline; implementation has not started.

Architectural source of truth. [LLD](low-level-design.md) defines runtime contracts;
[database design](database-design.md) defines durable constraints and queries;
[data flows](Data_Flow_Diagram.md) and [components](HLD_Component_Diagram.md) provide diagram views.

## 1. Problem Statement

Trivia Game is a competitive real-time quiz game.

The core loop is:

```text
Question presented
        ↓
Players answer during the round
        ↓
Round closes
        ↓
Server evaluates answers
        ↓
Correct answer, submissions, score, and ranking are revealed
        ↓
5-second reveal, then next question or match finish
```

The server is authoritative.

Clients display the game and submit player intent. They do not decide correctness, score, ranking, deadlines, answer eligibility, or Match progression.

The initial product should prove one complete playable Match while preserving clear boundaries for identity, realtime gameplay, completed-Match persistence, and future extensions.

## 2. Scope and Non-Goals

### In Scope

- Real-time round-based quiz gameplay.
- One shared question visible to 2–10 players.
- A host-created lobby where the Host joins first and other Players join afterward.
- Only the Host starts an M1 Match.
- Exactly 10 questions per Match.
- Single-choice multiple-choice questions.
- A 10-second maximum answer window.
- A 5-second reveal after each question.
- Answer editing while `QUESTION_OPEN`.
- Maximum 3 accepted answer attempts per Player per question.
- Attempt-based correctness scoring plus speed bonus.
- Server-authoritative score and ranking.
- Exact score equality and shared ranks.
- Durable Player identity.
- Initial username/password authentication.
- PostgreSQL persistence for Player identity and immutable completed-Match history.
- Player-centric Match History List and Match History Detail.
- One backend process with one authoritative in-memory owner per active Match.

### Non-Goals for M1

The following are not part of the initial implementation:

- Rescue Quiz.
- Guessing rooms.
- Elimination modes.
- Bots.
- Chat.
- Tournaments.
- Maps, territories, conquest, Clash, or Royal Game concepts.
- Public matchmaking.
- Admin tooling.
- Persistent active-Match state.
- Active-Match restart recovery.
- Redis.
- Message brokers.
- Microservices.
- Distributed Match ownership.
- Multi-instance coordination.
- Production-scale or multi-region deployment.
- OAuth.
- MFA.
- Email verification.
- Password recovery.
- Persistent Question Bank authoring/versioning unless separately approved.

Future features must extend approved boundaries rather than introduce speculative infrastructure into M1.

## 3. Functional Requirements

The current product baseline requires the system to:

1. Maintain a durable Player identity across authentication sessions.

2. Support initial username/password authentication where credentials resolve to a Player.

3. Allow an authenticated Player to create a Match and become its Host and first participant.

4. Allow additional Players to join while the Match is in `WAITING`, up to a maximum of 10 participants.

5. Remove a non-Host participant after an accepted explicit `LeaveMatch` during
   `WAITING` and notify remaining authorized lobby clients; insert no bot.
   Match membership and socket publication subscriptions are distinct: disconnect
   removes that socket's subscriptions, but does not invoke `LeaveMatch` or remove
   the Player from Match membership. Reconnection does not restore subscriptions;
   active-Match resume remains unsupported in M1. See the
   [implemented disconnect contract](api-contract.md#9-disconnect-restart-and-persistence-visibility).

   Earlier baseline disconnect-driven removal descriptions, including
   [LLD §6.1](low-level-design.md#61-create--join-match) and
   [LLD §9.2](low-level-design.md#92-match-engine-unit-tests), are superseded for
   accepted M1 behavior. Automatic removal on disconnect would require a separately
   approved departure policy; future departure/reconnect decisions remain open.

6. Allow only the Host to start a Match.

7. Validate the current participant count when `START` is processed:
   - fewer than 2 participants → reject;
   - 2–10 participants → open question 1.

8. Run exactly 10 question rounds.

9. Present the same single-choice question to every participant in a round.

10. Keep the correct Choice private while the question is open.

11. Keep each question open for at most 10 seconds.

12. Accept an answer only when the authoritative server ingress time is before the question deadline.

13. Allow a Player to submit or change their selected Choice while `QUESTION_OPEN`.

14. Count the first accepted answer as attempt 1.

15. Increment the attempt count only when a later accepted command selects a different Choice.

16. Treat a new command selecting the already-selected Choice as a successful no-op:
    - no attempt increment;
    - no timing change;
    - no score change;
    - no Match version change.

17. Allow at most 3 accepted attempts per Player per question.

18. Reject a fourth different-choice attempt with `MAX_ATTEMPTS_EXCEEDED`.

19. Use the latest accepted different Choice as the Player's final answer.

20. Derive final answer timing from authoritative server ingress time rather than client timestamps.

21. Evaluate correctness and score on the authoritative server.

22. Score a correct final answer conceptually as:

```text
correctnessScore = 10 / attemptCount

speedBonus =
    max(0, 10 - finalAnsweredAt)

questionScore =
    correctnessScore + speedBonus
```

23. Give wrong and unanswered questions a score of zero.

24. Represent authoritative scoring exactly using integer score units rather than floating-point arithmetic.

25. Accumulate question scores into an exact final score.

26. Rank Players by exact accumulated score.

27. Give Players with exactly equal final scores the same rank.

28. Treat all Players sharing the highest exact final score as co-winners.

29. Transition each resolved question into a 5-second `REVEAL` phase.

30. Reveal the correct answer and approved result information only after the Match enters `REVEAL`.

31. Progress to the next question after reveal, or enter `FINISHED` after question 10.

32. Produce one immutable `MatchResult` when the Match finishes.

33. Persist the completed Match atomically to PostgreSQL.

34. Make completed Match History visible only after the completion transaction commits.

35. Preserve enough immutable historical question, choice, answer, score, and ranking data to reconstruct the Match without depending on current mutable Question Bank content.

36. Allow a Player to retrieve their completed Match history.

The initial/default Match configuration has:

```text
questionCount      = 10
answerWindow       = 10 seconds
revealDuration     = 5 seconds
allowAnswerChanges = true
maxAttempts        = 3
earlyClose         = false
```

With `earlyClose=false`, nominal gameplay duration is:

```text
10 × (10s answer + 5s reveal)
= 150 seconds
```

excluding lobby, persistence, transport, and other overhead.

## 4. Non-Functional Requirements

### Correctness

Clients must not be able to forge:

- Player identity;
- correctness;
- score;
- ranking;
- attempt count;
- answer timing;
- deadlines;
- Match progression.

### Determinism

The same ordered commands, authoritative timing metadata, Match Rules, and question content should produce the same Match result.

### Concurrency Safety

Simultaneous answers, retries, and timer callbacks must not:

- corrupt Match state;
- apply the same mutation twice;
- extend the answer deadline;
- score a question twice;
- transition a Match twice.

### Realtime Responsiveness

Gameplay should feel live.

Exact latency targets remain outside the current baseline.

### Recoverable Client Projection

Clients consume versioned authoritative snapshots and must not depend on replaying transport events to reconstruct Match state.

### Testability

Gameplay rules should be testable without:

- Socket.IO;
- NestJS;
- PostgreSQL;
- wall-clock sleeps;
- external services.

### Security

Authentication, Player identity, authorization, input limits, password handling, and answer-key secrecy are enforced server-side.

Passwords are stored only as password hashes.

### Historical Integrity

A completed Match must remain reconstructable even if source Question content later changes or disappears.

### Transactional Integrity

A completed Match must not become visible in partially persisted form.

### Observability

Transitions, command outcomes, persistence failures, and relevant timing diagnostics should be diagnosable without logging:

- plaintext passwords;
- password hashes;
- secrets;
- answer keys before reveal;
- unnecessary private data.

## 5. Important Open Questions

These decisions remain unresolved and must not be invented during implementation.

### Gameplay

- What exact policy is permitted when `earlyClose=true`?

Immediate close when all Players answer is not currently approved.

### Lobby and Active Match

- What happens when the Host leaves during `WAITING`?
- What happens when a Player disconnects, leaves, or reconnects during `QUESTION_OPEN` or `REVEAL`?

Host migration is not assumed.

### History

- What is the final external History keyset-pagination cursor contract?
- Should completed participant count be stored on the Match or derived from participant rows?
- Should source Question and Choice identifiers be retained permanently as historical lineage?

### Product and Operations

- What concurrent-Match capacity is required?
- What production latency and availability targets are required?
- What RTO/RPO requirements exist beyond the approved M1 durability model?
- Are spectators, accessibility, localization, anti-cheat, or dispute/audit features required?

None of these questions permits implementation to silently introduce distributed infrastructure or new gameplay policies.

## 6. Core Domain Concepts

### Player

A durable gameplay identity.

A Player survives authentication sessions and is referenced by Matches and History.

### Password Credential

The initial authentication mechanism.

A username/password credential resolves to one Player.

Credentials are not gameplay identities.

```text
Credential
    ↓ authenticates
Player
    ↓ participates
Match
```

### Match

One complete quiz session containing:

- Host;
- participants;
- Match Rules;
- question progression;
- submissions;
- scores;
- ranking;
- terminal result.

### Participant

A Player participating in one Match.

The Host is a participant identified by the Match; Host is not a separate participant type.

### Question

A single-choice multiple-choice prompt and its Choices.

The correct Choice is private authoritative data until reveal.

### Submission

The latest accepted Choice for one Player and one question.

A Submission records:

- selected Choice;
- accepted attempt count;
- authoritative final answer timing.

### Attempt

An accepted different Choice selection.

```text
first accepted choice       → attempt 1
first accepted change       → attempt 2
second accepted change      → attempt 3
later different choice      → reject
same-choice resubmission    → no-op
```

### Evaluation

The authoritative determination of:

- final Choice;
- correctness;
- attempt count;
- final answer time;
- awarded question score.

### Score

The exact authoritative score represented in integer score units.

Human-readable decimal formatting is presentation only.

### Ranking

Ordering by exact accumulated score.

Exact equality produces a shared rank.

### Reveal

The 5-second phase after question resolution in which approved answer and result information becomes visible.

### Match Phase

```text
WAITING
QUESTION_OPEN
REVEAL
FINISHED
```

### Deadline

The authoritative server-side cutoff for accepting an answer.

```text
receivedAt < deadline
    → eligible

receivedAt >= deadline
    → late
```

### Match Rules / Configuration

Per-Match settings controlling approved Match behavior.

Rules allow future variants without making the Match aware of tournament or bot systems.

### MatchResult

The immutable terminal result produced when a Match reaches `FINISHED`.

It contains the durable historical facts required to persist and reconstruct the completed Match.

## 7. High-Level Architecture

The simplest architecture satisfying the approved requirements is a modular monolith.

```text
2–10 Clients ── Socket.IO ── Realtime Gateway
                                  │
                                  v
                           Match Coordinator
                                  │ serialized commands
                                  v
                       Authoritative Match Engine
                         ├── Match State (in-memory)
                         ├── Match Rules
                         ├── Clock / Timer port
                         └── Question Provider

Timer callbacks ──────────> Match Coordinator
Engine state ──> Coordinator ──> Client Presenter ──> Gateway

Engine FINISHED ──> immutable MatchResult ──> Application
                                               │
                                               v
                                        Persistence Boundary
                                               │ transaction
                                               v
                                           PostgreSQL
                                      ├── Player / Credential
                                      └── Completed Match History
```

Active Match state remains authoritative in memory.

PostgreSQL stores approved durable facts but does not coordinate active gameplay.

The initial deployment uses:

- one backend process;
- one authoritative in-process owner per active Match;
- Socket.IO realtime communication;
- deterministic/in-memory Question Provider;
- PostgreSQL for durable Player identity and completed Match History.

Redis, brokers, and distributed coordination are not required.

## 8. Component Responsibilities

| Component | Responsibility | Why it exists |
|---|---|---|
| Realtime Gateway | Manage connections, validate transport messages, resolve authenticated Player identity, deliver acknowledgements and snapshots. | Realtime client boundary. |
| Match Coordinator | Create/register active Matches, route commands, perform ordered ingress, serialize same-Match execution, enforce command idempotency, publish resulting projections. | Execution and coordination boundary. |
| Match Engine | Validate and mutate authoritative gameplay state, manage phases, submissions, attempts, scoring, ranking, and completion. | Single gameplay authority. |
| Match State | Hold the authoritative runtime state for one active Match. | Match is the gameplay aggregate. |
| Timer / Clock | Provide authoritative time and schedule deadline commands. | Time-bounded gameplay. |
| Match Rules / Configuration | Hold approved configurable Match behavior. | Supports variants without tournament branches. |
| Question Provider | Supply question content and private answer keys. | Separates content from gameplay. |
| Client Presenter | Convert private authoritative state into safe phase-specific projections. | Prevents information leaks. |
| Authentication | Resolve username/password credentials to durable Player identity. | Stable identity across sessions. |
| Persistence | Persist/query durable Player identity and immutable completed Match data. | Durable identity and History. |
| History | Read completed Match List and Detail from PostgreSQL. | Player-facing completed Match access. |
| Observability | Record transitions, errors, timing diagnostics, and persistence failures. | Diagnosis without becoming gameplay authority. |

### Ownership Boundary

The Coordinator owns execution and ordering.

The Engine owns gameplay validation and mutation.

```text
Coordinator
    → where and when a command executes

Engine
    → whether the command is valid
    → how authoritative Match state changes
```

The Coordinator must not duplicate gameplay rules such as:

- only Host may start;
- participant count must be 2–10;
- attempt limit;
- deadline eligibility;
- scoring.

Those rules belong to the Match Engine.

## 9. Main Data Flow

### Authentication and Lobby

```text
Player authenticates
        ↓
Credential resolves to durable Player
        ↓
Host creates Match
        ↓
Host becomes first participant
        ↓
Other authenticated Players join
        ↓
WAITING
        ↓
Host sends START
        ↓
Coordinator admits and serializes command
        ↓
Engine validates Host + WAITING + 2–10 participants
        ↓
<2 → reject
2–10 → QUESTION_OPEN
```

### Question

```text
Engine opens question
        ↓
Authoritative openedAt + deadline established
        ↓
Gateway publishes safe QUESTION_OPEN snapshot
        ↓
Players submit answer commands
        ↓
Gateway validates transport
        ↓
Coordinator performs ordered ingress
        ↓
Engine validates and applies command
        ↓
QuestionDeadline enters same command path
        ↓
Engine resolves question
        ↓
REVEAL for 5 seconds
        ↓
next question
        or
FINISHED after question 10
```

### Completion

```text
FINISHED
    ↓
immutable MatchResult
    ↓
completion persistence
    ↓
PostgreSQL transaction
    ↓
COMMIT
    ↓
History-visible
```

## 10. Authoritative State Ownership

The Match Engine owns authoritative active gameplay state:

- Match phase;
- Host identity;
- current participant set;
- Match Rules;
- current question;
- question progression;
- authoritative deadlines relevant to gameplay;
- accepted submissions;
- attempt counts;
- accumulated score units;
- ranking;
- Match version;
- terminal MatchResult.

The Gateway owns connections and transport behavior only.

The Coordinator owns:

- active Match lookup;
- command admission;
- receipt sequencing;
- queue placement;
- same-Match serialization;
- idempotency;
- routing.

The Timer schedules commands but does not decide whether a transition is valid.

The Question Provider owns content, not Match progression.

PostgreSQL owns durable records, not active Match authority.

The client owns presentation and player intent only.

No component other than the authoritative Match Engine may mutate active gameplay state.

## 11. Realtime Communication

Use a command-and-snapshot model.

### Client Commands

Examples include:

```text
CreateMatch
JoinMatch
LeaveMatch
StartMatch
SubmitAnswer
```

Retryable commands carry a `commandId`.

Player identity is not trusted from client payloads.

The server resolves the authenticated Player and enriches the internal command.

### System Commands

Timer-driven commands include:

```text
QuestionDeadline
RevealDeadline
```

System and Player commands use the same serialized Match path.

### Acknowledgements

The sender receives an acknowledgement describing the outcome of the command.

Acknowledgements are not authoritative Match snapshots.

### Snapshots

Clients receive versioned safe projections such as:

```text
WAITING
QUESTION_OPEN
REVEAL
FINISHED
```

A client applies only a newer authoritative Match version.

```text
incoming.version > current.version
    → apply

incoming.version <= current.version
    → ignore
```

### Information Safety

While `QUESTION_OPEN`, client projections must not expose:

- correct Choice;
- correctness;
- private evaluation state;
- other private fields that reveal the answer.

Correct-answer information may become visible only after entering `REVEAL`.

### Future Bots

Future bots should enter through the same participant-command path as humans.

```text
Human → realtime client ─────┐
                             ↓
Future Bot → bot controller → gameplay command
                             ↓
                       Match Coordinator
                             ↓
                         Match Engine
```

The Match Engine must not require bot-specific branches.

Bots are not implemented in M1.

## 12. Concurrency and Consistency

### Same-Match Serialization

Commands affecting the same Match execute serially.

```text
Match A:
command → command → timer → command

Match B:
command → timer → command
```

Different Matches may execute independently.

There is no requirement for global serialization.

### Ordered Ingress

For one Match, authoritative ingress admission establishes:

```text
receivedAt
receiptSequence
queue position
```

as one synchronous non-yielding operation.

Conceptually:

```text
admit(command):
    receivedAt      = authoritativeClock.now()
    receiptSequence = nextSequence()
    enqueue(command, receivedAt, receiptSequence)
```

There must be no asynchronous yield between reading authoritative time, assigning receipt order, and establishing queue position.

### Deadline Eligibility

The hard deadline is an acceptance barrier.

```text
receivedAt < deadline
    → eligible

receivedAt >= deadline
    → late
```

Network delay before the command reaches the server is borne by the client.

Internal scheduling delay after authoritative receipt must not change answer eligibility.

Therefore:

```text
received before deadline
        ↓
queued
        ↓
processed after wall-clock deadline
        ↓
still eligible
```

Client timestamps are telemetry only.

They never determine answer eligibility or score.

### Timer Races

Answer commands and timer callbacks use the same per-Match serialized command path.

A timer callback does not itself grant permission to transition state.

Deadline commands cannot be admitted before their scheduled deadline. Together with
non-yielding FIFO ingress, this places already-admitted pre-deadline answers before
the close barrier; processing delay cannot make them late.

The Engine validates current authoritative state when the command executes.

### Idempotency

Retryable commands use `commandId`.

A processed duplicate command returns its previously established outcome and does not execute the mutation again.

Network exactly-once delivery is not required.

### Match Version

Every actual authoritative Match mutation advances the Match version.

Rejected commands do not.

Successful no-op commands do not.

### Finished Match

Once `FINISHED`, gameplay state is immutable.

No later gameplay or timer command may change the result.

## 13. Scoring and Ranking

Authoritative scoring uses fixed-point integer units.

```text
SCORE_UNITS_PER_POINT = 3_000_000
```

Authoritative answer time uses integer milliseconds.

### Attempt Correctness Component

For a correct final answer:

```text
attempt 1
    correctnessUnits = 30_000_000

attempt 2
    correctnessUnits = 15_000_000

attempt 3
    correctnessUnits = 10_000_000
```

This corresponds conceptually to:

```text
correctnessScore = 10 / attemptCount
```

### Speed Component

```text
speedUnits =
    (10_000 - finalAnsweredMs) * 3_000
```

where:

```text
0 <= finalAnsweredMs < 10_000
```

### Question Score

For a correct final answer:

```text
questionScoreUnits =
    correctnessUnits + speedUnits
```

Wrong or unanswered questions:

```text
questionScoreUnits = 0
```

### Final Score

```text
finalScoreUnits =
    sum(questionScoreUnits)
```

No authoritative per-question or final-score rounding occurs.

Floating-point values are not authoritative for:

- scoring;
- equality;
- ranking;
- persistence.

### Ranking

Players rank by exact `finalScoreUnits`.

```text
higher units
    → higher result

equal units
    → shared rank
```

Exact first-place equality produces co-winners.

Human-readable decimal score formatting is presentation only.

## 14. Data Storage at a High Level

### Active Match State

Active Match state is held in memory.

This includes:

- phase;
- active participants;
- current question;
- submissions;
- current deadlines;
- timers;
- command queues;
- Match version;
- idempotency state.

PostgreSQL does not coordinate active Match execution.

M1 does not provide active-Match restart recovery.

A backend process failure may therefore lose active Matches.

### Durable Player Identity

PostgreSQL stores:

```text
PLAYER
    stable gameplay identity

PASSWORD_CREDENTIAL
    initial username/password authentication
```

Credentials resolve to a Player.

Gameplay and History reference Player identity rather than credentials.

### Completed Match History

A completed Match is persisted from one immutable `MatchResult`.

Conceptually:

```text
GAME_MATCH
│
├── MATCH_PARTICIPANT
│
└── MATCH_QUESTION_SNAPSHOT
      ├── MATCH_QUESTION_CHOICE_SNAPSHOT
      └── MATCH_ANSWER_SNAPSHOT
```

History stores the facts required to reconstruct the Match as played:

- Match identity and timestamps;
- participants;
- final score units;
- final ranks;
- question order;
- question text;
- presented Choices and order;
- correct Choice;
- final selected Choice or no-answer;
- attempt count;
- final answer time;
- awarded question score.

Completed History must not depend on current Question Bank content.

Source Question or Choice IDs, if retained, are lineage only.

### History Access

Primary Player History List access is:

```text
playerId
    ↓
completed participations
    ↓
finishedAt DESC
matchId DESC
```

The approved physical access path is:

```text
(player_id, finished_at DESC, match_id DESC)
```

The approved Slice 6 HTTP keyset cursor and bounded page contract are defined in LLD §5.7.

History Detail reads the bounded completed-Match snapshot graph.

No speculative Detail-specific index is required without a new access pattern.

### Score Storage

Conceptually:

```text
final_answered_ms      INTEGER
question_score_units   BIGINT
final_score_units      BIGINT
```

At JSON boundaries, authoritative score units are represented as decimal strings when necessary to preserve exact integer semantics across consumers.

## 15. Completed-Match Persistence Lifecycle

Active Match state remains authoritative in memory until `FINISHED`.

```text
Active Match
    ↓
FINISHED
    ↓
immutable MatchResult
    ↓
Persistence Boundary
    ↓
PostgreSQL Transaction
    ↓
COMMIT
    ↓
History-visible
```

### Atomic Completion

The completed Match and its historical rows are persisted in one transaction.

Conceptually:

```text
BEGIN

GAME_MATCH
MATCH_PARTICIPANT × N
MATCH_QUESTION_SNAPSHOT × 10
MATCH_QUESTION_CHOICE_SNAPSHOT × choices
MATCH_ANSWER_SNAPSHOT × participant/question results

COMMIT
```

History becomes visible only after commit.

A failed transaction must not expose a partial completed Match.

### Immutable Completion Time

`GAME_MATCH.finished_at` and participant History ordering timestamps originate from the same immutable `MatchResult.finishedAt`.

Historical gameplay data is immutable after successful completion persistence.

### Idempotent Retry

Completion persistence must distinguish:

```text
same matchId + identical completed result
    → idempotent success

same matchId + conflicting completed result
    → invariant violation
```

Blind:

```text
ON CONFLICT DO NOTHING
```

is not sufficient to establish idempotent correctness.

### Active-Match Recovery

Durable completed-Match persistence does not imply durable active-Match recovery.

These are separate requirements.

## 16. Reliability and Failure Considerations

### Command Failures

Malformed transport commands are rejected before domain execution.

Application failures such as:

- unauthenticated Player;
- unknown Match;

are distinct from gameplay-domain rejection.

Domain rejection does not mutate authoritative Match state.

### Late Answers

A late answer does not mutate:

- Submission;
- score;
- ranking;
- Match phase;
- Match version.

### Attempt Limit

After attempt 3, a new different Choice is rejected.

The rejection does not mutate state.

A same-choice resubmission remains a successful no-op.

### Duplicate Commands

A processed duplicate `commandId` must not execute twice.

Where the processed result remains retained, the duplicate receives the established result.

### Timer Commands

Stale or duplicate timer commands cannot mutate a newer Match state.

Correctness comes from authoritative state validation rather than assuming timer cancellation wins races.

If scheduling a deadline fails after an authoritative Match transition is committed,
M1 preserves the committed state and the original accepted command receipt, and
retains the infrastructure failure for diagnosis. Without that timer, the Match may
stop progressing while the backend process remains alive. This accepted availability
limitation does not relax gameplay correctness or deadline validation. Automatic
timer retry, deadline extension, rollback, fatal shutdown for this failure, and
active-Match recovery are not approved. Runtime operational reporting remains a
Phase 4 integration responsibility; process-restart recovery is separately deferred.

### Question Provider Failure

A Question Provider failure must not leave a partially opened or invalid authoritative round.

Exact recovery behavior depends on where the failure occurs and should preserve Match invariants.

### Persistence Failure

A failed completion transaction must roll back.

No partial completed Match becomes History-visible.

The immutable `MatchResult` should remain available long enough for the approved application-level persistence behavior.

Crash recovery between `FINISHED` and successful persistence is not an approved M1 guarantee unless separately specified.

### Active Process Failure

M1 accepts loss of active in-memory Matches after backend process failure.

Durable Player identity and already committed completed Match History remain in PostgreSQL.

### Telemetry

Telemetry must not block or change gameplay state.

## 17. Security and Fairness

- Never trust client-supplied Player identity.
- Never trust client-supplied score.
- Never trust client-supplied ranking.
- Never trust client-supplied correctness.
- Never trust client-supplied attempt count.
- Never trust client-supplied response time.
- Never trust client-supplied deadline.
- Never trust client-supplied Match progression.
- Resolve authenticated Player identity server-side.
- Bind gameplay commands to the authenticated Player.
- Validate Match membership server-side.
- Keep correct answers private until reveal.
- Use authoritative server ingress time for answer eligibility.
- Treat client timestamps as telemetry only.
- Enforce the 3-attempt limit server-side.
- Compute score and ranking server-side.
- Store passwords only as secure password hashes.
- Validate input shape and bound payload sizes.
- Rate-limit abusive traffic without changing approved gameplay semantics.
- Avoid logging secrets or unnecessary private data.
- Avoid exposing answer keys through transport errors, projections, or ordinary logs.
- Make answer acceptance, score, ranking, and tied-result handling deterministic and auditable.

### Approved M1 authentication/session boundary (Phase 4 Slice 2)

Username identity is ASCII `[A-Za-z0-9_.-]`, 1–128 UTF-8 bytes, case-insensitive
with lowercase canonical storage and database-enforced uniqueness. Durable UUID
Player identity remains separate. Unicode display names allow 1–64 extended
grapheme clusters and preserve spaces/composition; blank/unsafe controls reject.

M1 uses opaque process-local server sessions with 256-bit random bearer tokens,
30-minute sliding idle and 12-hour absolute expiration. Multiple sessions coexist;
logout revokes only the current session; restart requires login. Stage 2.5 adds
self-registration using atomic existing identity persistence and the approved public
password policy: explicit display name, 15-code-point minimum/1024-byte maximum,
unchanged Argon2id, no blocklist or automatic Login. See [API §2.2](api-contract.md#22-self-registration-stage-25). Only intentional
authenticated application actions refresh idle, never polling or heartbeats.

HTTP login/logout/profile and Socket.IO resolve identity from the server session.
Cookies are HttpOnly, host-only, Path=/, SameSite=Lax and Secure with the __Host-
prefix under HTTPS. Explicit local non-production loopback mode is the sole insecure
exception. Exact configured Origin validation, JSON-only state-changing auth actions
and credentialed CORS support same-origin or approved cross-origin same-site topology;
true cross-site credentialed deployment is excluded. Safe read-only GET /auth/profile
and the approved GET /history and GET /history/:matchId routes
permit absent Origin without Referer, but validate every present Origin and reject
null/disallowed values. Each still requires a session, never refreshes idle and uses
no-store. Login/logout, polling POST, and WebSocket handshakes require Origin.
Only session-authenticated same-origin polling GET behind a trusted HTTPS proxy
has the narrow missing-Origin/Fetch Metadata exception defined in
[API §4](api-contract.md#4-socketio-connection-and-subscriptions).
Production fails closed without HTTPS/origin configuration.

Authentication must be valid immediately before Coordinator admission; no asynchronous
gap is allowed between the final check and admission. Later expiration/logout does
not cancel admitted commands. Gameplay reconnect/rejoin remains separately deferred.
See LLD §5.7 for bounds, abuse accounting, error and session lifecycle details.

Anti-cheat depth and dispute/audit requirements beyond these boundaries remain open product decisions.

## 18. Scalability Approach

Start with one backend process and measure actual requirements.

```text
                         ┌─ capacity requirement
                         │      ↓
                         │   Match ownership / partitioning
                         │
                         ├─ availability requirement
                         │      ↓
                         │   restart/recovery design
                         │
Initial modular monolith ┼─ multiple realtime instances
                         │      ↓
                         │   shared coordination / fanout
                         │
                         ├─ durable asynchronous work
                         │      ↓
                         │   queue / worker architecture
                         │
                         └─ tournament requirement
                                ↓
                            tournament orchestration
```

These are independent requirement-driven branches, not maturity stages.

Do not introduce Redis, queues, microservices, or distributed coordination merely because they may be useful later.

The key future scaling invariant is:

> One authoritative owner exists for each active Match.

If Match ownership becomes distributed, the architecture must preserve:

- ordered ingress;
- per-Match serialization;
- deadline semantics;
- command idempotency;
- one authoritative mutation path.

Such a change requires an updated system design before implementation.

## 19. Future Tournament Boundary

Tournament behavior is outside M1.

The Match boundary should remain reusable by a future orchestrator:

```text
Tournament
    ├── Match A
    ├── Match B
    └── Match C
           ↓
       MatchResult
```

A future tournament may:

- assign participants;
- configure approved Match Rules;
- receive MatchResult;
- determine qualifiers;
- create later Matches.

The Match itself must not know that it belongs to a tournament.

Tournament-specific persistence, scheduling, brackets, and qualification rules are not implemented in M1.

## 20. Technology Choices and Key Trade-offs

| Area | Starting Choice | Why It Fits | Reconsideration Trigger |
|---|---|---|---|
| Backend | Node.js/TypeScript modular monolith with Fastify HTTP and a framework-independent Match Engine | Structured application boundaries while keeping domain rules portable and testable. | Different runtime/team constraints or evidence that another HTTP framework is preferable. |
| Frontend | React + Vite | Small realtime client without SSR requirements. | Larger product shell, SSR, SEO, or different frontend requirements. |
| Realtime | Socket.IO | Simple browser bidirectional communication and acknowledgements. | Need for lower-level protocol control or measured transport overhead. |
| Active Match State | In-memory | One process and one authoritative Match owner keep runtime semantics simple. | Approved restart recovery or distributed ownership requirement. |
| Durable Storage | PostgreSQL | Relational identity, constraints, transactions, immutable completed History, and Player-centric queries. | A materially different durable data model or access pattern. |
| Authentication | Username/password credential → Player | Small initial durable identity mechanism. | OAuth, MFA, email verification, recovery, or broader identity requirements. |
| Redis | None | No current shared-state or distributed coordination requirement. | Multiple instances, distributed ownership, shared sessions, or fanout requirements. |
| Queue/Broker | None | Gameplay transitions are short-lived and in-process. | Durable asynchronous work or distributed worker requirements. |
| Timers | Process-local scheduling into Match command path | Keeps answer/timer races under one authority. | Deadlines must survive process restart or span instances. |
| Testing | Domain tests, coordination tests, realtime contract tests, PostgreSQL integration tests, narrow E2E | Matches the ownership boundaries of the design. | New topology or production requirements. |
| Observability | Structured logs and basic metrics | Diagnoses transitions and failures without vendor coupling. | Production SLOs or distributed tracing requirements. |
| Deployment | One backend process/container plus client and PostgreSQL | Matches M1 topology. | Capacity or availability targets require multiple instances. |

Technology choices support the architecture; they do not redefine gameplay authority.

## 21. Suggested Development Milestones

These milestones describe capability progression, not independent architecture stages.

### 1. Project Foundation and Durable Identity

- Bootstrap the modular monolith.
- Establish domain/application/infrastructure boundaries.
- Configure PostgreSQL.
- Implement Player identity.
- Implement username/password credentials.
- Authenticate and resolve a durable Player.

### 2. Core Match Engine

- Create Match.
- Host becomes first participant.
- Join/leave `WAITING`.
- Host-only `START`.
- 2–10 participant validation.
- Match state machine.
- Deterministic Question Provider.
- Exactly 10 questions.
- 10-second answer window.
- 5-second reveal.
- Terminal `FINISHED`.

Keep this layer independently testable from transport and PostgreSQL.

### 3. Submission and Exact Scoring

- First accepted answer = attempt 1.
- Different Choice changes increment attempt count.
- Same Choice = no-op.
- Maximum 3 attempts.
- Server-authoritative answer timing.
- Fixed-point score units.
- Exact accumulation.
- Exact shared ranks.

### 4. Ordered Realtime Execution

- Socket.IO Gateway.
- Match Coordinator.
- Ordered ingress.
- Same-Match serialization.
- Timer commands through the same command path.
- Command idempotency.
- Versioned safe snapshots.

### 5. Completed Match Persistence

- Produce immutable `MatchResult`.
- Persist completed Match atomically.
- Persist participant results.
- Persist question/choice/answer snapshots.
- Validate identical retry.
- Reject conflicting retry.
- Keep active Match state in memory.

### 6. Match History

- Player History List.
- Chronological access through:

```text
(player_id, finished_at DESC, match_id DESC)
```

- Match History Detail.
- Reconstruction independent of mutable Question Bank content.

### 7. Integrated Critical Path

Prove:

```text
Authenticate
    ↓
Create
    ↓
Join
    ↓
Start
    ↓
10 Questions
    ↓
Finish
    ↓
Persist
    ↓
Result
    ↓
History
```

with deterministic tests and without real-time sleeps.

### 8. Optional Features After Explicit Approval

Potential later requirements include:

- active-Match reconnect semantics;
- Host-leave policy;
- active-Match restart recovery;
- `earlyClose=true`;
- bots;
- tournaments;
- public matchmaking;
- persistent Question Bank authoring;
- admin tooling;
- multi-instance scaling.

None should be implemented speculatively during M1.

## 22. Architectural Guardrails

The following changes require updating this system design before implementation:

- splitting the modular monolith into independently deployed services;
- introducing Redis or a message broker;
- introducing distributed Match ownership;
- introducing multi-instance Match coordination;
- persisting active Match state for restart recovery;
- introducing durable gameplay command queues;
- changing authoritative deadline semantics;
- changing ordered-ingress semantics;
- making client timestamps authoritative;
- making PostgreSQL authoritative for active gameplay;
- changing completed-Match atomicity or durability guarantees;
- changing the fundamental Match lifecycle or authority boundary.

The expected process is:

```text
new requirement or implementation discovery
        ↓
identify affected architectural assumption
        ↓
update system-design.md
        ↓
update affected LLD
        ↓
implement
```

Implementation must not silently redefine architecture.

## 23. Design Summary

The M1 architecture is intentionally small:

```text
Authenticated Players
        ↓
Socket.IO
        ↓
Realtime Gateway
        ↓
Match Coordinator
        ↓
Authoritative Match Engine
        ↓
In-memory active Match
```

with durable completion:

```text
FINISHED
    ↓
immutable MatchResult
    ↓
PostgreSQL
    ↓
Player Match History
```

The critical invariants are:

- durable Player identity is distinct from credentials;
- one authoritative owner exists for each active Match;
- only the Match Engine mutates authoritative gameplay state;
- same-Match commands are serialized;
- ingress time determines deadline eligibility;
- internal scheduling delay does not change eligibility;
- first answer is attempt 1;
- at most 3 accepted different-choice attempts exist per question;
- same-choice resubmission is a no-op;
- scoring uses exact integer units;
- exact score equality produces shared rank;
- correct answers remain private until reveal;
- `FINISHED` gameplay state is immutable;
- completed Match History is persisted atomically;
- historical reconstruction does not depend on mutable Question Bank content;
- active-Match restart recovery is not an M1 guarantee;
- future infrastructure is introduced only when a requirement justifies it.

The architecture favors correctness and explicit ownership over premature distribution.

## Lessons from the Historical System

Only general architectural lessons are carried into the new Trivia Game:

- Keep one clear owner for live Match state.
- Do not distribute authoritative transitions without a requirement.
- Serialize answer and timeout decisions for each Match.
- Separate authoritative ingress time from later processing time.
- Use complete versioned client snapshots rather than relying on incremental transport history.
- Separate connection/session concerns from durable Player identity.
- Separate authentication credentials from gameplay identity.
- Separate active gameplay state from completed historical persistence.
- Treat transport delivery, persistence, and gameplay correctness as different concerns.
- Persist historical facts required for reconstruction rather than depending on mutable source content.

Historical services, Redis usage, MongoDB models, queues, event names, and old game modes are not part of this design by default.
