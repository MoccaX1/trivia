# Backend boundaries

`main.ts` is the composition root: configuration, database availability, listening,
and process signals. `config.ts` validates environment variables.

| Location                | Responsibility                                                                | Allowed dependencies                                                               |
| ----------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `transport/`            | Fastify HTTP and Socket.IO connections, later validation and safe delivery    | Application contracts; transport libraries                                         |
| `application/` (future) | Match lookup, ordered ingress, serialization, idempotency, completion handoff | Domain and required ports; no Fastify, Socket.IO, or PostgreSQL imports            |
| `domain/` (future)      | Engine-owned Match state and gameplay invariants                              | Domain types and required ports; no transport, persistence, or application imports |
| `persistence/`          | PostgreSQL connection lifecycle, later durable adapters                       | PostgreSQL and required domain/application contracts                               |

Application and domain directories will be introduced with their first behavior;
the skeleton creates no empty modules or speculative interfaces. ESLint already
restricts infrastructure imports under those paths. Define ports only when a
concrete use case needs them, following the LLD; wire adapters in `main.ts`.

Socket.IO attaches directly to Fastify's `server`, sharing its single HTTP listener.
There are no gameplay handlers or authentication/session semantics yet. Health is
process liveness, not database readiness. Startup checks PostgreSQL with `SELECT 1`.

Authority: [system design](../docs/system-design.md),
[runtime contracts](../docs/low-level-design.md),
[database design](../docs/database-design.md), and
[programming principles](../docs/programming-principles.md).
