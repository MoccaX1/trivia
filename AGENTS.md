# Repository Guidelines

## Design Authority

Read all relevant `docs/*.md` before changing behavior.
`docs/system-design.md` owns architecture and M1 requirements;
`docs/low-level-design.md` owns runtime contracts;
`docs/database-design.md` owns durable constraints.
Follow `docs/programming-principles.md`; consult component and data-flow diagrams
for ownership. The approved bootstrap stack is Node.js 24, TypeScript, Fastify,
Socket.IO, PostgreSQL, and Docker Compose. Fastify supersedes the documents' older
NestJS technology suggestion. Preserve design documents unless explicitly asked
to update them.

## Structure & Boundaries

`src/main.ts` wires startup, database availability, and shutdown; `src/config.ts`
validates environment settings. `src/transport/` owns HTTP/realtime infrastructure.
`src/persistence/` owns PostgreSQL adapters. `src/README.md` specifies future
`src/application/` coordinator and `src/domain/` engine boundaries; introduce these
directories with real behavior, not placeholders. Keep application/domain code
independent of Fastify, Socket.IO, and `pg`. Only the Engine may mutate active
Match state; PostgreSQL stores identity and completed History.

## Commands & Style

Use `npm ci`, `npm run dev`, `npm run check`, and `npm run smoke` as documented in
`README.md`. Docker-only checks:
`docker compose --profile tools run --build --rm tools npm run check`.
Use strict TypeScript, ESM `.js` import specifiers, two-space indentation,
single quotes, and Prettier. Run ESLint; preserve module import restrictions.
Prefer descriptive camelCase functions and kebab-case filenames. Avoid custom DI,
speculative ports, factories, and unused modules.

## Tests & Verification

Tests use Node's test runner through `tsx`; name files `tests/*.test.ts`.
Use real ephemeral listeners for transport tests and controlled time for future
gameplay tests. Assert invariants, rejection/no-op preservation, and regressions.
Run typecheck, lint, formatting checks, tests, and build. For lifecycle/infrastructure
changes, also build Compose, verify both health checks, test Socket.IO, and confirm
clean shutdown. Report exact checks and limitations; do not claim unrun checks passed.

## Scope & Delivery

The current skeleton has no gameplay, authentication, schema, migrations, History,
or frontend. Do not implement deferred policies or add Redis, brokers, distributed
ownership, or active-Match recovery without approval. Preserve unrelated user work.
Keep `.env`, dependencies, builds, and caches out of Git; retain the lockfile.
Use concise imperative commit subjects and focused PR descriptions with verification.
Do not commit or push unless requested.

For structural codebase exploration, use the installed `codebase-memory` skill
and verify coverage for relied-on files.
