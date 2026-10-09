# Trivia Game Data Flow Diagram

Status: M1 design baseline. Authority: [system design](system-design.md).
Contracts: [LLD](low-level-design.md). Constraints: [database design](database-design.md).
Component ownership: [HLD](HLD_Component_Diagram.md).

Diagrams show runtime messages, not dependency imports. ACK reports a command outcome;
versioned snapshots represent state. Publish snapshots only after actual mutations,
using viewer-safe projections; no-op/rejection does not advance version.

## 1. Authentication Flow

```mermaid
sequenceDiagram
    actor P as Player
    participant A as Authentication
    participant DB as PostgreSQL

    P->>A: username + password
    A->>DB: lookup credential by username
    DB-->>A: Player + password hash
    A->>A: verify password
    A-->>P: authenticated Player session/context
```

Resolve username/password credentials to a durable Player after hash verification. Authentication/session transport details remain unspecified; gameplay never trusts username/socket identity as Player identity.

## 2. Create Match Flow

```mermaid
sequenceDiagram
    actor H as Host
    participant G as Realtime Gateway
    participant C as Match Coordinator
    participant E as Match Engine
    participant P as Client Presenter

    H->>G: CreateMatch
    G->>G: validate transport + resolve Player
    G->>C: trusted Player + command

    C->>C: create Match execution context
    C->>E: Create / Join Host

    E->>E: create WAITING Match
    E->>E: add Host as first participant
    E-->>C: accepted Match state

    C->>P: authoritative state
    P-->>G: safe WAITING snapshot
    G-->>H: ACK + snapshot
```

Server generates Match identity and makes the authenticated creator Host/first participant in `WAITING`. No auto-start or Ready state.

## 3. Join Match Flow

```mermaid
sequenceDiagram
    actor P2 as Player
    participant G as Realtime Gateway
    participant C as Match Coordinator
    participant E as Match Engine
    participant P as Client Presenter

    P2->>G: JoinMatch(matchId)
    G->>G: validate transport + resolve Player
    G->>C: trusted Player + command

    C->>C: admit + serialize
    C->>E: Join

    E->>E: validate current Match state
    E->>E: add participant
    E-->>C: accepted + new Match version

    C->>P: updated authoritative state
    P-->>G: safe WAITING snapshot
    G-->>P2: ACK
    G-->>G: broadcast updated WAITING projections to Match clients
```

Engine validates `WAITING`, no duplicate Player, and at most 10 participants. Publish updated lobby snapshots to all remaining Match clients, not only the joiner.

## 4. Waiting Participant Leave Flow

```mermaid
sequenceDiagram
    actor P2 as Player
    participant G as Realtime Gateway
    participant C as Match Coordinator
    participant E as Match Engine
    participant P as Client Presenter

    P2->>G: LeaveMatch / disconnect in WAITING
    G->>C: trusted Player + command

    C->>C: admit + serialize
    C->>E: Leave

    E->>E: validate WAITING + membership
    E->>E: remove participant
    E-->>C: accepted + new Match version

    C->>P: updated authoritative state
    P-->>G: WAITING snapshots
    G-->>G: notify remaining lobby clients
    opt Explicit Leave command
        G-->>P2: ACK
    end
```

A non-Host leave **or disconnect** in `WAITING` removes membership and notifies remaining clients. No ghost participant or bot replacement. Host departure and active-game disconnect/reconnect remain open.

## 5. Start Match Flow

```mermaid
sequenceDiagram
    actor H as Host
    participant G as Realtime Gateway
    participant C as Match Coordinator
    participant E as Match Engine
    participant Q as Question Provider
    participant T as Timer
    participant P as Client Presenter

    H->>G: StartMatch(commandId)
    G->>G: validate transport + resolve Player
    G->>C: trusted Player + command

    C->>C: ordered ingress
    C->>C: serialize for Match
    C->>E: Start

    E->>E: validate WAITING
    E->>E: validate requester is Host
    E->>E: validate participant count 2–10

    alt Invalid START
        E-->>C: domain rejection
        C-->>G: rejection
        G-->>H: error ACK
    else Valid START
        E->>Q: obtain question 1
        Q-->>E: question + private correct Choice

        E->>E: enter QUESTION_OPEN
        E->>E: establish openedAt + deadline
        E->>T: schedule QuestionDeadline

        E-->>C: accepted + new Match version

        C->>P: authoritative state
        P-->>G: safe QUESTION_OPEN snapshot
        G-->>H: ACK
    end
```

Only the Host starts. Validate current `WAITING` membership at processing: 2–10 opens question 1; fewer than 2 rejects without mutation/version change. No client-supplied question/deadline.

## 6. Ordered Command Ingress

```mermaid
sequenceDiagram
    participant G as Gateway / Timer
    participant C as Match Coordinator
    participant Q as Per-Match Queue
    participant E as Match Engine

    G->>C: MatchCommand

    Note over C: synchronous admission
    C->>C: receivedAt = clock.now()
    C->>C: receiptSequence++
    C->>Q: enqueue command + ingress metadata

    Q->>E: next serialized command
    E-->>C: command result
```

Clock read, receipt sequencing, and queue position are one non-yielding admission operation. Player and Timer commands share the per-Match FIFO path; different Matches execute independently. Processed command-ID retries return established outcomes without re-execution.

## 7. Submit Answer Flow

```mermaid
sequenceDiagram
    actor P1 as Player
    participant G as Realtime Gateway
    participant C as Match Coordinator
    participant E as Match Engine
    participant V as Client Presenter

    P1->>G: SubmitAnswer(commandId, questionId, choiceId)
    G->>G: validate transport + resolve Player
    G->>C: trusted Player + command

    C->>C: capture receivedAt
    C->>C: assign receiptSequence
    C->>C: establish queue position

    C->>E: serialized SubmitAnswer + ingress metadata

    E->>E: validate participant
    E->>E: validate QUESTION_OPEN
    E->>E: validate current question
    E->>E: validate Choice
    E->>E: validate receivedAt < deadline

    alt Invalid phase / membership / question / Choice / deadline
        E-->>C: non-mutating rejection
    else Same Choice
        E-->>C: accepted no-op; no timing/attempt/version change
    else Different Choice after attempt 3
        E-->>C: MAX_ATTEMPTS_EXCEEDED; no mutation
    else First accepted or allowed different Choice
        E->>E: create/increment attempt; set Choice + finalAnsweredMs
        E-->>C: accepted mutation + new version
    end

    opt Actual mutation
        C->>V: project updated state for viewers
        V-->>G: safe snapshots
    end
    G-->>P1: ACK / error
```

First accepted Choice is attempt 1. Different accepted Choices increment to at most 3 and replace final ingress timing. Same-Choice no-op and rejection preserve Submission, score, timing, and version. Validate phase/membership/question/Choice/deadline before the attempt branches. UI disabling at attempt 3 does not replace Engine enforcement.

## 8. Deadline Eligibility Flow

```mermaid
sequenceDiagram
    actor P as Player
    participant C as Match Coordinator
    participant Q as Per-Match Queue
    participant E as Match Engine

    P->>C: answer arrives before deadline
    C->>C: capture receivedAt < deadline
    C->>Q: enqueue

    Note over Q: processing delayed

    Q->>E: SubmitAnswer after wall-clock deadline
    E->>E: evaluate stored receivedAt
    E-->>C: answer remains eligible
```

Exclusive deadline: `receivedAt < openedAt + 10_000 ms`. Client timestamps and Engine processing time cannot alter eligibility. Network delay before admission is borne by the client; internal processing delay is not. Deadline commands are not admitted early, so eligible admitted answers precede the close barrier.

## 9. Question Deadline Flow

```mermaid
sequenceDiagram
    participant T as Timer
    participant C as Match Coordinator
    participant E as Match Engine
    participant P as Client Presenter
    participant G as Realtime Gateway

    T->>C: QuestionDeadline

    C->>C: ordered ingress
    C->>C: serialize for Match
    C->>E: QuestionDeadline

    E->>E: validate phase / played question / scheduled deadline / time
    E->>E: resolve final submissions
    E->>E: evaluate correctness
    E->>E: calculate exact score units
    E->>E: update ranking
    E->>E: enter REVEAL

    E->>T: schedule RevealDeadline
    E-->>C: accepted + new Match version

    C->>P: authoritative REVEAL state
    P-->>G: safe REVEAL snapshot
    G-->>G: broadcast
```

Validate current `QUESTION_OPEN`, played-question/scheduled-deadline identity, and deadline reached. Stale/duplicate timers cannot affect another round. Finalize submissions once; update exact scores/ranks, enter `REVEAL`, schedule its deadline, publish snapshots. Default `earlyClose=false`; enabled early-close policy remains open.

## 10. Scoring Flow

```text
final accepted answer → Engine correctness/time scoring → exact question units
                     → accumulated units → exact ranking/shared ties
```

Engine evaluates final accepted Choice, attempts, and elapsed milliseconds, then accumulates exact units and ranks. Wrong/no answer is zero. Formula/scale authority: [system design §13](system-design.md#13-scoring-and-ranking). No 9-second cutoff, editing penalty subtraction, or authoritative rounding.

## 11. Reveal Flow

```mermaid
sequenceDiagram
    participant E as Match Engine
    participant T as Timer
    participant C as Match Coordinator
    participant P as Client Presenter
    participant G as Realtime Gateway

    E->>E: QUESTION_OPEN → REVEAL
    E->>T: schedule RevealDeadline
    E-->>C: authoritative REVEAL state

    C->>P: project
    P-->>G: REVEAL snapshot
    G-->>G: broadcast correct answer + approved results

    T->>C: RevealDeadline
    C->>E: serialized RevealDeadline

    alt Questions 1–9
        E->>E: select next question
        E->>E: enter QUESTION_OPEN
        E->>T: schedule QuestionDeadline
        E-->>C: new version
    else Question 10
        E->>E: enter FINISHED
        E->>E: create immutable MatchResult
        E-->>C: MatchResult + new version
    end
```

Expose the correct Choice and approved results on entering `REVEAL`; the phase lasts 5 seconds. After reveals 1–9 open the next question; after reveal 10 produce `FINISHED`. Timer callbacks always pass through admission/serialization.

## 12. Match Completion Flow

```text
REVEAL Q10 → RevealDeadline → FINISHED → immutable MatchResult
```

After question 10's reveal, produce one immutable `MatchResult`. Gameplay, scores, ranking, and timer transitions are terminal. Result projection does not claim successful durable persistence before commit.

## 13. Completed Match Persistence Flow

```mermaid
sequenceDiagram
    participant E as Match Engine
    participant C as Application / Coordinator
    participant R as Completed Match Repository
    participant DB as PostgreSQL
    participant H as History

    E-->>C: immutable MatchResult

    C->>R: save MatchResult
    R->>DB: BEGIN

    R->>DB: GAME_MATCH
    R->>DB: MATCH_PARTICIPANT rows
    R->>DB: MATCH_QUESTION_SNAPSHOT rows
    R->>DB: MATCH_QUESTION_CHOICE_SNAPSHOT rows
    R->>DB: MATCH_ANSWER_SNAPSHOT rows

    R->>DB: COMMIT
    DB-->>R: persisted
    R-->>C: success

    Note over H,DB: Match becomes History-visible after COMMIT
```

Application—not Engine—owns persistence handoff. One transaction writes the entire validated graph. Match and participation `finished_at` values come from the same `MatchResult.finishedAt`; History-visible only after commit. See [database design §§9–10](database-design.md#9-completed-match-persistence).

## 14. Persistence Failure Flow

```mermaid
sequenceDiagram
    participant C as Application
    participant R as Completed Match Repository
    participant DB as PostgreSQL

    C->>R: save immutable MatchResult
    R->>DB: BEGIN
    R->>DB: write completed-Match data

    DB-->>R: write / constraint failure
    R->>DB: ROLLBACK

    R-->>C: persistence failure
```

Rollback exposes no partial History and cannot reopen gameplay. Retain immutable result for approved application-level retries; no M1 guarantee of crash delivery between finish and commit.

## 15. Persistence Retry Flow

```text
save result → absent Match: atomic insert
            → existing Match: compare complete result → identical / conflict
```

Compare the complete result for the stable Match identity. Identical retry succeeds idempotently; conflict is an invariant violation. PK/UNIQUE prevent duplicates but blind `ON CONFLICT DO NOTHING` does not prove equivalence.

## 16. History List Flow

```mermaid
sequenceDiagram
    actor P as Player
    participant H as History API
    participant DB as PostgreSQL

    P->>H: request own Match History
    H->>H: resolve authenticated Player
    H->>DB: query MATCH_PARTICIPANT by playerId

    Note over H,DB: ORDER BY finished_at DESC, match_id DESC

    DB-->>H: completed Match summaries
    H-->>P: History List
```

Read own committed participations using `(player_id, finished_at DESC, match_id DESC)` and SQL LIMIT, with own score/rank and participant count. External cursor contract and stored-versus-derived count remain open.

## 17. History Detail Flow

```mermaid
sequenceDiagram
    actor P as Player
    participant H as History API
    participant DB as PostgreSQL

    P->>H: request Match Detail
    H->>H: resolve authenticated Player

    H->>DB: verify MATCH_PARTICIPANT membership

    alt Player did not participate
        H-->>P: reject
    else Player participated
        H->>DB: read GAME_MATCH
        H->>DB: read MATCH_PARTICIPANT
        H->>DB: read MATCH_QUESTION_SNAPSHOT
        H->>DB: read MATCH_QUESTION_CHOICE_SNAPSHOT
        H->>DB: read MATCH_ANSWER_SNAPSHOT

        DB-->>H: immutable completed-Match facts
        H-->>P: reconstructed Match Detail
    end
```

Participation authorization precedes returning Detail. Reconstruct summary, final scoreboard, ordered questions/Choices, correct Choice, and requesting Player's final results from immutable snapshots; no mutable Question Bank read.

## 18. End-to-End Critical Path

```text
Authenticate Host → Create → Authenticate/join second Player → Host START
→ (QUESTION_OPEN → submissions → deadline → REVEAL) × 10
→ FINISHED / MatchResult → atomic persistence → COMMIT → History List / Detail
```

Primary M1 integration path. Gameplay finish and durable commit are distinct; FINISHED projections do not imply History visibility until persistence succeeds.

## 19. Authority Summary

See [component ownership summary](HLD_Component_Diagram.md#22-component-ownership-summary). Only Engine mutates active Match state; Coordinator orders; Timer schedules; Presenter projects; PostgreSQL stores committed facts.
