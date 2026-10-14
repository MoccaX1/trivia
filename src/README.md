# Backend boundaries

`main.ts` is the composition root: configuration, database availability, listening,
and process signals. `config.ts` validates environment variables.

| Location                | Responsibility                                                                | Allowed dependencies                                                    |
| ----------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `transport/`            | Fastify HTTP and Socket.IO connections, later validation and safe delivery    | Application contracts; transport libraries                              |
| `application/` (future) | Match lookup, ordered ingress, serialization, idempotency, completion handoff | Domain and required ports; no Fastify, Socket.IO, or PostgreSQL imports |
| `domain/`               | WAITING Match membership and Start eligibility                                | Pure TypeScript; no transport, persistence, or application imports      |
| `persistence/`          | PostgreSQL connection lifecycle, later durable adapters                       | PostgreSQL and required domain/application contracts                    |

The application directory will be introduced with its first behavior;
there are no empty modules or speculative interfaces. ESLint already
restricts infrastructure imports under those paths. Define ports only when a
concrete use case needs them, following the LLD; wire adapters in `main.ts`.

`domain/match-engine.ts` exposes `createMatch`, `joinMatch`, `leaveMatch`, and
`checkStartEligibility`. Creation takes trusted Player identity and a server-owned
ID generator; it initializes version 1. Membership changes return a new immutable
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
