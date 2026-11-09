# Trivia M1 Backend API Contract

This is the frontend integration reference for the implemented M1 demo backend:
authenticate → Create → Join → Start → ten questions, each followed by REVEAL →
live FINISHED → PostgreSQL commit → participant History. Runtime: Node.js 26.13.0,
Fastify, Socket.IO 4 and PostgreSQL 17. No frontend is implemented here.

The wire shapes below come from current handlers, serializers and tests, not
proposed endpoints. [System Design](system-design.md) owns architecture,
[LLD](low-level-design.md) runtime rules, and [Database Design](database-design.md)
durable facts. This document does not change them. See [evidence and discovery](#11-evidence-and-discovery)
for source locations, tested behavior and minor documentation gaps.

## 1. URLs, identifiers and browser configuration

- Deployment supplies the backend base URL: scheme, hostname and port. HTTP routes
  below are rooted at that URL; there is no configured `/api` or version prefix.
  The default listener port is 3000; it is environment-configurable.
- Socket.IO shares the HTTP server. Its default path is `/socket.io/`, namespace
  `/`; the client `path` option can be written `/socket.io`. No custom namespace,
  path configuration API, raw-WebSocket gameplay protocol or served client bundle
  is provided. Backend tests use `socket.io-client` 4.8.4.
- Player and server-generated Match IDs are UUID strings. Preserve the exact Match
  ID returned by the server: live Registry lookup uses the string as supplied.
  Question/choice IDs are opaque strings, not UUIDs. Never construct them from
  question numbers; use the current snapshot. History uses question positions
  instead of original question IDs.
- Use `credentials: 'include'` for browser HTTP and `withCredentials: true` for
  Socket.IO. JavaScript cannot read the HttpOnly cookie or `Set-Cookie` response.
  Do not copy a cookie into an Authorization header or Socket.IO `auth` payload.
- Browsers supply `Origin`; frontend code must not attempt to set it manually.
  Deployment must configure the exact frontend Origin in `AUTH_ORIGINS` and the
  backend's public Origin in `AUTH_PUBLIC_ORIGIN`. Origins include scheme, host
  and port. No wildcard credentialed origins are supported.
- Supported topology is same-origin or approved cross-origin **same-site**.
  Cross-site cookie deployment is excluded. Secure deployments require HTTPS at
  the configured trusted deployment boundary; clients must not forge forwarding
  headers. Explicit trusted-proxy settings belong to deployment, not frontend code.
- Local insecure cookies require explicitly configured non-production loopback
  mode. Use a consistent hostname; `localhost` and `127.0.0.1` are not interchangeable
  for host-only cookies or the configured loopback Origin policy. No frontend
  framework, development port or proxy arrangement is assumed.

Example IDs used below are illustrations, not existing accounts or Matches:

```text
Alice: 11111111-1111-4111-8111-111111111111
Bob:   22222222-2222-4222-8222-222222222222
Match: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
```

Timestamp strings use UTC ISO milliseconds, for example `2026-11-09T12:00:10.000Z`.
Score units are decimal strings, not floating-point JSON numbers.

## 2. HTTP endpoints

All JSON error bodies for the implemented operations have shape `{ "code": "..." }`.
All auth and History responses, including their application errors, use
`Cache-Control: no-store`. They do not expose credential hashes or session tokens.
On routed protected requests, transport/Origin checks precede session and input
validation: an invalid Origin can yield 403 even without a session. History input
errors described below assume authentication passed. Malformed URL decoding can
fail earlier still, with generic 400.

| Method/path             | Session      | Origin                                    | Input                             | Success                  | Cookie/activity                                                        |
| ----------------------- | ------------ | ----------------------------------------- | --------------------------------- | ------------------------ | ---------------------------------------------------------------------- |
| `GET /health`           | None         | No application Origin guard               | None                              | 200 `{ "status": "ok" }` | No cookie/activity; no explicit no-store or credentialed CORS headers  |
| `POST /auth/login`      | Not required | Mandatory approved Origin                 | JSON username/password            | 200 `PlayerResponse`     | Creates a new independent session cookie                               |
| `POST /auth/logout`     | Required     | Mandatory approved Origin                 | JSON; send `{}` (body is ignored) | 204, no body             | Revokes current session, clears its cookie and disconnects its sockets |
| `GET /auth/profile`     | Required     | Missing allowed; present must be approved | None                              | 200 `PlayerResponse`     | No refresh/replacement cookie                                          |
| `GET /history`          | Required     | Missing allowed; present must be approved | Optional `limit`, `cursor` only   | 200 HistoryList          | No refresh/replacement cookie                                          |
| `GET /history/:matchId` | Required     | Missing allowed; present must be approved | UUID path; no query parameters    | 200 HistoryDetail        | No refresh/replacement cookie                                          |

`/health` is liveness, not proof of authentication, database readiness, timer health
or completion durability. No registration, refresh-token, password-reset, current
live-Match HTTP read or gameplay mutation HTTP endpoint exists. Account provisioning
is internal/test-only; the frontend needs pre-provisioned accounts.

**Preflight:** `OPTIONS /auth/*` requires an approved Origin and allows requested
methods GET/POST. `OPTIONS /history` and `OPTIONS /history/:matchId` allow GET only.
Allowed requested headers are Content-Type only; successful preflight returns 204
with credentialed CORS headers and does not require a session. This wildcard
preflight does not create additional authentication operations.

**Implicit HEAD:** Fastify also provides HEAD counterparts for GET routes, with no
body. Use GET for integration. Observed detail: HEAD `/auth/profile` still requires
Origin, unlike its GET safe-read exception; HEAD History permits absent Origin
but still requires a session. These are framework-provided behaviors, not recovery APIs.

### 2.1 Login, credentials and session lifetime

Send exactly two JSON properties, both strings:

```json
{ "username": "alice", "password": "<user-entered password>" }
```

- Content-Type must be `application/json` (a charset parameter is accepted).
  Maximum login JSON body is 4096 bytes.
- Username: ASCII letters, digits, `_`, `-`, `.`, length 1–128 UTF-8 bytes.
  Identity is case-insensitive through lowercase canonicalization. No trimming:
  `Alice` and `ALICE` resolve like `alice`; `alice` is invalid.
- Password: 1–1024 UTF-8 bytes. Preserve exact input; never trim, normalize or
  lowercase it. These are login resource bounds, not password-creation policy.
- Unknown user and wrong password share 401 `INVALID_CREDENTIALS`. Infrastructure
  failure is distinct (503 `AUTH_UNAVAILABLE`).
- `PlayerResponse` is `{ player: { id: string; displayName: string } }`.
  Success returns only that public profile wrapper, for example:

```json
{
  "player": {
    "id": "11111111-1111-4111-8111-111111111111",
    "displayName": "Alice"
  }
}
```

The secure cookie is named `__Host-trivia_session`, with Path=/, HttpOnly, Secure,
SameSite=Lax and no Domain. Explicit loopback mode uses `trivia_session` without
Secure. No token is returned in JSON. Login sets no Max-Age/Expires; server-side
expiration remains authoritative. Logout clears the matching cookie with Max-Age=0.

Idle expiration is **30 minutes**, absolute expiration **12 hours from login**.
At the exact expiration boundary, the session is invalid. A well-formed socket
command passing authentication refreshes idle, even if the Engine rejects it,
accepts a no-op or replays a cached receipt. Malformed envelopes rejected before
authentication, failed logins, profile/History reads, passive socket presence,
polling and heartbeats do not refresh it. Idle refresh never extends absolute expiry.
There is no public session-touch operation or expiry timestamp in responses.

Multiple sessions are independent; new login does not revoke older sessions.
Logout affects only its session. Expiry/logout disconnect associated sockets.
An existing socket remains tied to its connection's session: a later HTTP login
does not switch that socket's Player. On account change, disconnect the old socket,
clear viewer-private UI state, and establish a new authenticated handshake.
Restart loses all sessions: log in again. The profile returned by `/auth/profile`
is captured in the session at login, not freshly queried on each read. In contrast,
live publications resolve trusted names and History reads current PostgreSQL names.
Display names are not authentication identifiers and are not necessarily unique.
Provisioned names can contain Unicode, spaces and composed emoji (1–64 grapheme
clusters at provisioning). Treat names and question/choice text as plain text, not HTML.

Login protections: 60 admitted requests per trusted IP per sliding 15 minutes,
including malformed requests after the transport/Origin guard; 10 credential failures
per canonical username in that window; at most four concurrent lookup/verifications.
Unknown users count as failures; successful logins/outages do not erase abuse history.
429 uses `RATE_LIMITED` and Retry-After: 900; saturation/capacity or auth infrastructure
failure uses 503 `AUTH_UNAVAILABLE` and Retry-After: 1. These are retry hints, not
permission for an unlimited client retry loop.

## 3. History HTTP contract

History reads committed PostgreSQL only. It does not read live subscriptions or
the Match Registry. No session Player ID is accepted in query/body/headers as an actor.
The session is checked before SQL and inspected again immediately before delivery;
expiry/revocation during a read yields 401 and discards the private response.

### 3.1 List: GET /history

`limit` defaults to 20 and must be a positive decimal integer from 1 to 50. Reject
zero, negative, fractional, oversized, whitespace-padded or other numeric forms.
Unknown/repeated parameters are invalid, including repeated `limit`/`cursor`.

```ts
interface HistoryList {
  items: Array<{
    matchId: string;
    finishedAt: string; // UTC ISO timestamp with milliseconds
    ownResult: { score: { scoreUnits: string }; rank: number };
    participantCount: number;
  }>;
  nextCursor: string | null;
}
```

Empty history: `{ "items": [], "nextCursor": null }`. Items belong only to the
current Player and are ordered by finishedAt descending, then Match UUID descending.
Participant counts are derived from committed participation data for returned Matches.

Illustrative final page (invented identity/time/result, with no further page):

```json
{
  "items": [
    {
      "matchId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "finishedAt": "2026-11-09T12:02:30.000Z",
      "ownResult": { "score": { "scoreUnits": "562500000" }, "rank": 1 },
      "participantCount": 2
    }
  ],
  "nextCursor": null
}
```

Treat `nextCursor` as **opaque**: copy it unchanged into URLSearchParams. Never
construct/decode it to choose identity or edit its contents. Invalid/noncanonical,
unsupported or oversized (>512 encoded characters) cursors produce 400. Cursors
have no expiry and do not require their anchor Match to exist. Last page has null
cursor; page size may change between requests.

There is no total-history count or frozen multi-page snapshot. Newly committed
Matches are not retroactively inserted into an already read page. A delayed commit
of an older result can be missed after its seek position has been traversed;
refresh from page one to discover it. Cursor possession never grants participation.

### 3.2 Detail: GET /history/:matchId

Validate a UUID path and supply no query parameters. Only committed participants
are authorized. Valid absent, unauthorized and not-yet-persisted IDs all return
the identical 404 `{ "code": "NOT_FOUND" }`; malformed UUIDs return 400.

```ts
interface HistoryDetail {
  match: {
    matchId: string;
    startedAt: string;
    finishedAt: string;
    hostPlayerId: string;
  };
  participants: Array<{
    playerId: string;
    displayName: string;
    score: { scoreUnits: string };
    rank: number;
  }>;
  questions: Array<{
    questionNumber: number;
    text: string;
    choices: Array<{ choiceId: string; text: string }>;
    correctChoiceId: string;
    ownResult: {
      selectedChoiceId: string | null;
      attemptCount: number; // 0, 1, 2 or 3
      finalAnsweredMs: number | null;
      score: { scoreUnits: string };
    };
  }>;
}
```

Questions are ordered 1–10; choices preserve presentation order. There is no
historical `questionId`. Times are UTC ISO with milliseconds. Participants are
ordered by exact score descending, UUID ascending for deterministic tied output;
UUID ordering does not alter tied ranks. Display Names are **current trusted
profiles**, not gameplay-time snapshots. Renames do not change question/choice content.

Only the requester's private per-question results appear. Other participants'
selections, attempts, timing and question awards are hidden, while their final
totals/ranks are public. No-answer is exactly:

```json
{
  "selectedChoiceId": null,
  "attemptCount": 0,
  "finalAnsweredMs": null,
  "score": { "scoreUnits": "0" }
}
```

Missing profiles or detectable incomplete/contradictory graphs fail safely with
500, not a partial detail response. This is structural validation, not arbitrary
SQL tamper detection (accepted A6-02); see [known limitations](known-issues.md#lim-004).

## 4. Socket.IO connection and subscriptions

Login before connecting. Use the same configured backend host for HTTP and sockets.
Both polling and WebSocket are supported; normal Socket.IO clients may begin with
polling then upgrade. Browser cookies accompany the connection; no bearer token or
Player ID is supplied in handshake `auth`/query. WebSocket Origin checks are explicit
server checks, not merely browser CORS. Missing/null/disallowed Origin is rejected
on handshake and subsequent transport requests; the safe-GET exceptions do not apply.

```ts
import { io } from 'socket.io-client';

// apiBase is deployment configuration, e.g. the selected backend HTTPS Origin.
const socket = io(apiBase, {
  path: '/socket.io',
  withCredentials: true,
  autoConnect: false,
  reconnection: false, // illustrative M1 client choice, not a server requirement
});
// Register publication/error handlers before calling socket.connect().
```

Socket.IO middleware may report `connect_error` with message `UNAUTHENTICATED` or
`AUTH_UNAVAILABLE`. Origin/transport rejection may instead surface as a generic
polling/WebSocket connection error or browser CORS failure; do not expect the HTTP
`{ code }` envelope or stable message text on every connection failure.
Client-provided handshake `auth`/query identity fields cannot override the session;
the middleware ignores them as identity sources.

Authenticated connection alone does **not** subscribe a socket to a Match.
Subscriptions are per socket, never automatically shared across Player sessions:

- First successful mutating CreateMatch subscribes the creating socket.
- First successful mutating JoinMatch subscribes the joining socket.
- Accepted LeaveMatch removes membership and invalidates that Player's subscriptions
  for the Match. The leaving socket receives its ACK, not a special final snapshot.
- Disconnect/logout/expiry removes the affected socket's delivery authorization.
- Delivery requires a currently valid session, that socket's subscription and current
  Match membership. No client-controlled room/subscription operation exists.
- Start/Answer authorization is separate from delivery subscription. Being a member
  can permit a command without granting a new socket publications.

## 5. Client commands and native callback ACKs

Send the event with exactly `{ commandId, payload }`. All identifier fields must
be nonblank strings; they are not trimmed. The gateway does not require UUID-format
command IDs or declare a separate application string-length limit. Use a fresh
`crypto.randomUUID()` per new user intent. Extra properties, including actor IDs,
display names, timestamps or question packs, are rejected, not used as authority.

| Event          | Exact payload                       | Preconditions and effect                                                                                          |
| -------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `CreateMatch`  | `{}`                                | Authenticated Player creates WAITING, becomes Host/first participant; new Match ID is server-generated; version 1 |
| `JoinMatch`    | `{ matchId }`                       | WAITING, not already a member, fewer than 10 participants; adds membership                                        |
| `LeaveMatch`   | `{ matchId }`                       | WAITING non-Host participant only; removes membership                                                             |
| `StartMatch`   | `{ matchId }`                       | WAITING Host, 2–10 participants; opens question 1 from the validated server-owned pack                            |
| `SubmitAnswer` | `{ matchId, questionId, choiceId }` | Current QUESTION_OPEN participant; selects/changes current answer according to timing and attempt rules           |

Use Socket.IO callback ACKs (`emitWithAck` or callback); there is no separate
command-result event. An omitted callback does not prevent execution. Unknown
event names have no application handler and may never ACK.

```ts
type CommandAck =
  | { commandId: string; status: 'accepted'; matchId: string; version: number }
  | {
      commandId: string;
      status: 'rejected';
      matchId: string;
      version?: number; // absent for MATCH_NOT_FOUND
      error: { code: string };
    }
  | {
      commandId: string | null; // null if no string commandId could be extracted
      status: 'error';
      error: { code: 'INVALID_REQUEST' | 'UNAUTHENTICATED' | 'LOBBY_UNAVAILABLE' };
    };
```

An accepted ACK has no `changed`/`noOp` flag and is not a snapshot. A Host Leave
maps to `status: 'rejected'` with `HOST_DEPARTURE_DEFERRED`, not a wire `unsupported`
status. Validation/authentication failures before admission do not mutate a Match;
`LOBBY_UNAVAILABLE` can represent an internal failure and is not proof of rollback.

### 5.1 Replay, ordering and unknown outcomes

Idempotency scopes are `(Player, commandId)` for Create and
`(Match, Player, commandId)` for the other commands. The command event name is not
part of the latter key. Never reuse a command ID for a new event, choice or intent.
For a valid authenticated envelope, even a reused ID with different valid payload
data returns the original receipt rather than applying the new data. Invalid
envelopes still fail validation before cache lookup.

In-flight duplicates share execution; settled retries return the original ACK,
including its historical version/error. Cache retention is process-local until
shutdown, not a ten-second retry window. New sessions for the same durable Player
can encounter the same cached outcomes. Restart loses this retry memory.

Replays do not mutate, restart timers, rejoin or independently restore subscriptions.
For example, replaying a successful Join after a later Leave returns the old Join
ACK but leaves the Player out. A cached Leave cannot unsubscribe a subsequent valid
Join. After equivalent snapshots are delivered, replay bursts do not repeat profile
reads/broadcasts (A3-01). A later valid event, including a replay, can still retry
an incomplete projection after enrichment failed; any delivery describes current
authorized state, never the old receipt's state.

The frontend likewise needs to correlate ACKs to its pending user intent: do not let
an old Leave ACK undo a newer Join in the UI. A current explicit Leave can close
the local Match view after acceptance; no final snapshot is sent to that socket.

Same-Match admissions are FIFO with server ingress timestamps. Different Matches
are independent. A valid session must exist at admission; later logout/expiry does
not retroactively cancel admitted work. ACK/snapshot arrival order is not a commit
barrier: snapshots may precede or follow ACKs; no total order across Matches is promised.

An ACK timeout, disconnect or lost ACK means **UNKNOWN**, not rejected. Preserve
the exact command ID and payload if explicitly retrying. Do not turn uncertainty
into a new command ID or start unlimited automatic retries. Illustrative client
timeout (five seconds is a client choice, not a server response-time guarantee):

```ts
const join = { commandId: crypto.randomUUID(), payload: { matchId } };
try {
  const ack: CommandAck = await socket.timeout(5_000).emitWithAck('JoinMatch', join);
  // Inspect ack.status; accepted does not itself establish a UI snapshot.
} catch {
  // Show unknown outcome. A user-requested retry must resend `join`, unchanged.
}
```

## 6. Gameplay lifecycle and answer rules

```text
WAITING → QUESTION_OPEN #1 → REVEAL #1 → QUESTION_OPEN #2 → REVEAL #2
        → ... → QUESTION_OPEN #10 → REVEAL #10 → FINISHED
```

There are exactly ten ordered server-owned demo questions, not client-selected
content. Each answer window is 10,000ms; each reveal lasts 5,000ms from the actual
server transition. With timely callbacks, nominal gameplay is 150 seconds. Timer
delay can make it longer. There is no early-close command, next-question command
or client-driven deadline transition. FINISHED is terminal.

The Coordinator assigns authoritative answer ingress time. An otherwise valid
answer at deadline minus 1ms qualifies; one at the exact deadline does not. Client
timestamps and display countdowns do not affect eligibility. If the timer has not
run, an overdue answer still rejects; if phase already advanced, the phase check
can reject first. Do not locally switch phases just because a countdown reaches zero.

First selection consumes attempt 1. Changing the current choice consumes the next
attempt, at most 3. This counts **changes**, not globally distinct choice IDs:
A → B → A consumes all three. Repeating the current choice inside the valid window
is accepted no-op: no new attempt, timestamp or version. At attempt 3, repeating
the current choice is still a no-op; changing it rejects. Invalid/rejected submissions
consume no attempt. A same-choice submission after the deadline is not a timing bypass.

The final accepted choice, attempt count and final selection's elapsed ingress
milliseconds determine the award. Answer changes reduce the correctness component;
speed uses the final accepted selection time. Wrong/no answer scores zero. Scores
resolve at each REVEAL; unresolved submissions do not prematurely affect standings.
Only the Engine calculates authoritative awards/totals/ranks. Score units are exact
decimal strings (3,000,000 units per point); avoid unsafe Number conversions and
never recompute authoritative standings in the UI. Equal totals share competition
ranks, e.g. 1, 1, 3; there is no timestamp/submission-order tie-breaker.

## 7. Server publications: exact snapshot DTOs

Only `LobbySnapshot` and `MatchSnapshot` are application publications. Socket.IO's
connection/disconnection/error events are separate transport events. No public
timer receipt, persistence-complete event, answer-result event or History socket
event exists.

```ts
interface Score {
  scoreUnits: string;
}
interface ParticipantScore {
  playerId: string;
  displayName: string;
  score: Score;
  rank: number;
}
interface PublicQuestion {
  questionId: string;
  text: string;
  choices: Array<{ choiceId: string; text: string }>;
}

interface LobbySnapshot {
  matchId: string;
  version: number;
  phase: 'WAITING';
  state: {
    hostPlayerId: string;
    participants: Array<{ playerId: string; displayName: string }>;
    rules: {
      questionCount: 10;
      answerWindowMs: 10000;
      revealDurationMs: 5000;
      allowAnswerChanges: true;
      maxAttempts: 3;
      earlyClose: false;
    };
  };
}

type MatchSnapshot = { matchId: string; version: number } & (
  | {
      phase: 'QUESTION_OPEN';
      state: {
        questionNumber: number; // 1–10
        questionCount: number; // always 10
        question: PublicQuestion;
        deadlineAt: string; // UTC ISO milliseconds
        participants: ParticipantScore[];
        ownSubmission?: {
          choiceId: string;
          attemptCount: 1 | 2 | 3;
          finalAnsweredMs: number;
        };
      };
    }
  | {
      phase: 'REVEAL';
      state: {
        questionNumber: number;
        questionCount: number;
        question: PublicQuestion & { correctChoiceId: string };
        revealEndsAt: string; // UTC ISO milliseconds
        participants: ParticipantScore[];
        ownResult: {
          selectedChoiceId?: string;
          correct: boolean;
          questionScore: Score;
          attemptCount: 0 | 1 | 2 | 3;
          finalAnsweredMs?: number;
        };
      };
    }
  | { phase: 'FINISHED'; state: { participants: ParticipantScore[] } }
);
```

Important distinctions:

- QUESTION_OPEN omits `ownSubmission` until the viewer answers. It exposes neither
  correct choice/correctness nor another Player's answer status. Future content is hidden.
- REVEAL exposes only the current correct choice and the viewer's result. A live
  no-answer result has `correct: false`, attemptCount 0, questionScore units `"0"`,
  and **omits** selectedChoiceId/finalAnsweredMs. History instead returns explicit nulls
  and names its award field `score`, not `questionScore`; it has no `correct` boolean.
- FINISHED contains final participants only: no raw history, question, timestamps,
  Host ID, rules, persistence status or durability flag. Retain required lobby UI
  context locally rather than inventing absent active fields.
- Live participant arrays preserve Match membership order, not necessarily score
  order. Use supplied ranks for standings. History has its separate sorted convention.
- All snapshots contain trusted Display Names, not usernames or session metadata.

### 7.1 Versioned frontend state

Versions are positive safe integers scoped to Match ID. Actual mutations advance
once; rejected commands, same-choice no-ops and replays do not. Snapshots are full
viewer-specific projections, not patches. Handle LobbySnapshot and MatchSnapshot
using one latest-version tracker per Match, not separate trackers per event:

```ts
type Snapshot = LobbySnapshot | MatchSnapshot;
const latest = new Map<string, Snapshot>();
function receive(snapshot: Snapshot) {
  const previous = latest.get(snapshot.matchId);
  if (previous && snapshot.version <= previous.version) return;
  latest.set(snapshot.matchId, snapshot);
  render(snapshot); // application rendering; do not infer hidden fields
}
socket.on('LobbySnapshot', receive);
socket.on('MatchSnapshot', receive);
```

This tracker belongs to one authenticated viewer. Clear viewer-private client
state on logout/account change; never share a cached snapshot between Players.
Two viewers can legitimately receive different own fields at the same Match version.

Do not advance this tracker from ACK versions: an ACK can precede the corresponding
snapshot or be a replay from the past. Version gaps are possible; coalescing can
skip superseded intermediate projections. Do not demand every integer or assume
one publication per accepted ACK. Timers publish committed phase changes without
a new client command. No-op/rejected timer results do not create new versions.

Profile enrichment is asynchronous. Publication rechecks current state, subscription,
membership and session immediately before delivery and suppresses stale work. If
enrichment fails, committed commands remain accepted, but no incomplete snapshot
is emitted. A later valid event may retry current projection; there is no background
publication-retry worker. Notification callback failures are contained (A4-01), not
an additional wire error event or guarantee of eventual publication.

## 8. Error reference

### 8.1 HTTP application errors

| HTTP/code                 | Meaning                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| 400 `INVALID_REQUEST`     | Invalid login/query/UUID/cursor/JSON or malformed URL component  |
| 401 `INVALID_CREDENTIALS` | Login username/password incorrect or unknown                     |
| 401 `UNAUTHENTICATED`     | Session missing, invalid, expired or revoked                     |
| 403 `ORIGIN_FORBIDDEN`    | Origin or required secure/explicit loopback transport rejected   |
| 404 `NOT_FOUND`           | History ID valid but absent, unauthorized or not durably visible |
| 413 `PAYLOAD_TOO_LARGE`   | Request exceeds endpoint body limit                              |
| 415 `INVALID_REQUEST`     | Auth POST Content-Type is not application/json                   |
| 429 `RATE_LIMITED`        | Login throttled; Retry-After: 900                                |
| 503 `AUTH_UNAVAILABLE`    | Auth infrastructure/capacity unavailable; Retry-After: 1         |
| 503 `HISTORY_UNAVAILABLE` | History storage unavailable                                      |
| 500 `INTERNAL_ERROR`      | Detected integrity/internal failure; no private diagnostics      |

Malformed paths such as `/history/%ZZ` fail before route selection with only
400 `{ "code": "INVALID_REQUEST" }`, JSON content type and no-store. They are
not decoded/forwarded to another route and never produce a replacement cookie.
Unknown endpoints are not supported API operations; do not depend on Fastify's
generic not-found body. Shutdown may also cause HTTP unavailability or connection loss.
Browser CORS rejection can surface as a fetch/network error without readable status
or JSON; handle that separately from an application error response.

### 8.2 Socket command outcomes

`status: 'error'` uses `INVALID_REQUEST`, `UNAUTHENTICATED` or `LOBBY_UNAVAILABLE`
as defined in the ACK union. It is not the HTTP `{ code }` envelope.

| Rejected ACK code           | Relevant operation/condition                                         |
| --------------------------- | -------------------------------------------------------------------- |
| `MATCH_NOT_FOUND`           | Match lookup failed; rejection omits version                         |
| `ALREADY_MATCH_PARTICIPANT` | Fresh Join for an existing member; does not subscribe the socket     |
| `MATCH_FULL`                | Join would exceed ten participants                                   |
| `NOT_MATCH_PARTICIPANT`     | Leave/Start/Answer actor lacks membership                            |
| `NOT_HOST`                  | Non-Host Start                                                       |
| `INSUFFICIENT_PARTICIPANTS` | Start with fewer than two                                            |
| `HOST_DEPARTURE_DEFERRED`   | Host Leave is unsupported in M1                                      |
| `INVALID_MATCH_PHASE`       | Operation unavailable in current nonterminal phase                   |
| `MATCH_FINISHED`            | Gameplay command targets terminal Match                              |
| `QUESTION_NOT_CURRENT`      | Answer uses another question ID                                      |
| `INVALID_CHOICE`            | Answer choice does not belong to current question                    |
| `ANSWER_WINDOW_CLOSED`      | Ingress at/after deadline while QUESTION_OPEN                        |
| `MAX_ATTEMPTS_EXCEEDED`     | Further changed choice after attempt three                           |
| `INVALID_TIMING`            | Authoritative timing validation failed; not a client timestamp field |

The Engine also declares `INVALID_QUESTION_SET`, `MATCH_ID_MISMATCH`,
`DEADLINE_MISMATCH` and `DEADLINE_NOT_REACHED` for provider/internal command
validation. These are not new public operations or normal outcomes a frontend can
request through the five strict command payloads. Handle unknown error codes safely;
never assume an error includes a message, private result, current phase or fresh snapshot.

## 9. Disconnect, restart and persistence visibility

Socket.IO transport reconnection is not application Match recovery. A reconnect
must pass current cookie/Origin authentication and creates a new socket without
subscriptions. Cached Create/Join ACKs do not restore them, and a fresh Join by an
existing member rejects. No public restore-subscription, active-state fetch, event
replay or active-Match rejoin/resume operation exists. Ordinary lobby commands keep
their normal preconditions; this document defines no reconnect workaround.

Disconnect/logout does not automatically remove gameplay membership, transfer Host
or introduce penalties. Host departure/reconnect policies remain deferred. A frontend
must present lost-connection/unsupported-resume state instead of silently claiming
it has rejoined. There is no supported Host migration or cross-process failover.

Live FINISHED is not a COMMIT acknowledgement. Persistence runs independently and
may be pending, failed or unconfirmed. There is no client durability-status/retry
endpoint or commit-complete event. After FINISHED, a user can fetch History and
refresh later if missing; a bounded client read retry is a frontend UX choice, not
a guaranteed availability deadline. Do not spin or declare permanent loss on 404.

Once persisted, a participant can retrieve History with a valid session even after
the original socket disconnects. Process restart loses active Matches, sessions
and command retry caches; login can still access already committed History. Crash
delivery from FINISHED to COMMIT is not guaranteed. Deadline scheduling failure may
stall live progression; M1 provides diagnostics but no automatic deadline retry,
extension or recovery. See [accepted limitations](known-issues.md#7-accepted-m1-limitations).

## 10. Complete frontend integration sequence

Use two provisioned accounts in separate browser profiles/devices for two Players.
Two same-host tabs normally share the cookie, so they do not create independent
Player identities merely by opening two sockets. The server permits multiple
sessions, but the browser manages which host cookie subsequent requests present.

The following code uses the types above, a deployment-supplied `apiBase`, and
application callbacks such as `render`. It illustrates client integration, not a
new SDK, retry policy, provisioning API or frontend implementation.
It is a multi-client sequence: Host-only and Bob-only blocks run in their respective
browser profiles, not sequentially on one socket.

```ts
async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: 'include',
  });
  if (!response.ok) {
    const body = await response.json();
    throw { status: response.status, code: body.code };
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

// 1. Each Player logs in on their own browser profile/device.
const { player } = await jsonRequest<{ player: { id: string; displayName: string } }>(
  '/auth/login',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: formUsername, password: formPassword }),
  },
);
// Optional reload check: GET /auth/profile, with no idle refresh.

// 2. On BOTH clients, install `receive` from section 7.1 before connecting.
socket.on('connect_error', showConnectionFailure);
socket.on('disconnect', showDisconnectedState);
await new Promise<void>((resolve, reject) => {
  socket.once('connect', () => resolve());
  socket.once('connect_error', reject);
  socket.connect();
});

// 3. HOST client only; retain this request unchanged if its ACK is lost.
const create = { commandId: crypto.randomUUID(), payload: {} };
const created: CommandAck = await socket.timeout(5_000).emitWithAck('CreateMatch', create);
if (created.status !== 'accepted') throw created;
const matchId = created.matchId;

// 4. BOB client, using Match ID shared through the demo UI/out of band.
const join = { commandId: crypto.randomUUID(), payload: { matchId } };
const joined: CommandAck = await socket.timeout(5_000).emitWithAck('JoinMatch', join);
if (joined.status !== 'accepted') throw joined;
// Both subscribed clients receive LobbySnapshot.

// 5. HOST client, once two or more participants appear in WAITING.
const start = { commandId: crypto.randomUUID(), payload: { matchId } };
const started: CommandAck = await socket.timeout(5_000).emitWithAck('StartMatch', start);
if (started.status !== 'accepted') throw started;
// Render phase from MatchSnapshot, not this ACK.

// 6. EACH client, on a user selection from its latest QUESTION_OPEN snapshot.
function answer(current: MatchSnapshot, selectedChoiceId: string) {
  if (current.phase !== 'QUESTION_OPEN') return;
  const submission = {
    commandId: crypto.randomUUID(),
    payload: {
      matchId: current.matchId,
      questionId: current.state.question.questionId,
      choiceId: selectedChoiceId,
    },
  };
  // Save submission for an explicit same-ID retry if the outcome is unknown.
  return socket.timeout(5_000).emitWithAck('SubmitAnswer', submission);
}
// Server timers publish each REVEAL and next QUESTION_OPEN; do not emit timeouts.
// After REVEAL #10 the server publishes FINISHED, then persistence runs separately.

// 7. User-invoked History refresh; absence does not prove permanent failure.
const page = await jsonRequest<HistoryList>('/history?limit=20');
if (page.nextCursor !== null) {
  const query = new URLSearchParams({ limit: '20', cursor: page.nextCursor });
  const next = await jsonRequest<HistoryList>(`/history?${query}`);
  displayHistoryPage(next);
}
// Open Detail only when available; valid participant requests can still see 404
// before COMMIT. Handle 401, 404, 500 and 503 according to section 8.
try {
  const detail = await jsonRequest<HistoryDetail>(`/history/${encodeURIComponent(matchId)}`);
  displayHistoryDetail(detail);
} catch (error) {
  if (error && typeof error === 'object' && 'status' in error && error.status === 404) {
    showHistoryNotAvailable(); // no claim whether absent, unauthorized or pending
  } else {
    throw error; // let the UI handle authentication/storage/network failures
  }
}

// 8. Logout: no JSON response, clears only this session and disconnects its sockets.
await jsonRequest<void>('/auth/logout', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
});
```

Concrete wire illustrations (not one script executed by both Players):

```json
{
  "commandId": "33333333-3333-4333-8333-333333333333",
  "payload": { "matchId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }
}
```

This is a Join/Leave/Start envelope; event name determines the operation. A possible
accepted Join callback is:

```json
{
  "commandId": "33333333-3333-4333-8333-333333333333",
  "status": "accepted",
  "matchId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "version": 2
}
```

For the current first demo question, a selected choice could be sent as:

```json
{
  "commandId": "44444444-4444-4444-8444-444444444444",
  "payload": {
    "matchId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "questionId": "demo-q1",
    "choiceId": "demo-q1-c2"
  }
}
```

Only send that choice if present in the current snapshot. No correctness is implied
by this example, and no other Player's private selection is shown. Future content
must not be preloaded from assumptions about the server pack.

## 11. Evidence and discovery

Stage A found no material ambiguity blocking this document. The HTTP auth, History,
lobby and session suites were executed in Node 26 Docker with disposable PostgreSQL:
**81 passed, 0 failed, 0 skipped**. No full-suite rerun is claimed for this documentation
task. A targeted runtime probe also verified implicit HEAD behavior.

| Classification                            | Evidence and integration consequence                                                                                                                                                                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed contract                        | [HTTP auth handlers](../src/transport/authentication.ts#L20), [auth tests](../tests/authentication.test.ts); login/logout/profile, route-bound protection and cookies                                                                                                             |
| Confirmed contract                        | [History DTOs](../src/application/history.ts#L1), [routes](../src/transport/history.ts#L12), [participant-authorized reader](../src/persistence/history.ts#L95), [History tests](../tests/history.test.ts); exact fields, nulls, pagination, current names and own-only answers   |
| Confirmed contract                        | [gateway validation/ACKs](../src/transport/lobby-gateway.ts#L10), [subscription/delivery](../src/transport/lobby-gateway.ts#L106), [lobby tests](../tests/lobby.test.ts); five commands, two publications, safe replay and authorization                                          |
| Confirmed contract                        | [Lobby Presenter](../src/application/lobby-presenter.ts#L5), [Match Presenter](../src/application/match-presenter.ts#L6); explicit phase-specific allowlists, omitted versus null fields                                                                                          |
| Confirmed contract                        | [Coordinator cache/admission](../src/application/match-coordinator.ts#L115), [Coordinator tests](../tests/match-coordinator.test.ts); FIFO, namespaces, historical receipts and post-commit notifications                                                                         |
| Confirmed contract                        | [Engine lobby rules](../src/domain/match-engine.ts#L217), [answers](../src/domain/match-engine.ts#L337), [answer tests](../tests/answer-submission.test.ts), [lifecycle tests](../tests/question-lifecycle.test.ts); authority, attempts and exclusive deadlines                  |
| Confirmed contract                        | [completion ownership](../src/application/match-completions.ts#L29), [handoff](../src/application/match-coordinator.ts#L251), [persistence tests](../tests/completed-matches.test.ts); FINISHED differs from confirmed durable availability                                       |
| Confirmed contract                        | [server](../src/transport/server.ts#L29), [cookie/Origin policy](../src/transport/auth-policy.ts#L35), [session store](../src/application/sessions.ts#L40); default transport configuration, malformed-URL containment and non-refreshing reads                                   |
| Conceptual documentation gap              | [LLD ACK shorthand](low-level-design.md#command-acknowledgement) omits the actual third `error` status and version fields. Section 5 above follows the implementation; no backend conflict is inferred from a conceptual example.                                                 |
| Source-supported, limited dedicated tests | Profile freshness: [session creation](../src/application/sessions.ts#L47) freezes the login profile; [profile handler](../src/transport/authentication.ts#L113) reads it. A dedicated post-rename profile regression was not found; History rename behavior is tested separately. |
| Framework behavior, probed                | Implicit HEAD routes and the profile HEAD Origin difference in section 2 were verified with authenticated requests; prefer GET. They are not a new recovery contract.                                                                                                             |

No behavior was changed to resolve documentation differences. Unknown future
API/security/recovery decisions remain outside this reference. Frontend changes
must preserve these verified wire contracts or request an explicit backend contract change.
