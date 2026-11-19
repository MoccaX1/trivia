# Repository Guidelines

## Design Authority

Read all relevant `docs/*.md` before changing behavior.
`docs/system-design.md` owns architecture and M1 requirements;
`docs/low-level-design.md` owns runtime contracts;
`docs/database-design.md` owns durable constraints.
Follow `docs/programming-principles.md`; consult component and data-flow diagrams
for ownership. The approved runtime is Node.js 26.13.0 LTS with TypeScript, Fastify,
Socket.IO, PostgreSQL, and Docker Compose. Fastify supersedes the documents' older
NestJS technology suggestion. Preserve design documents unless explicitly asked
to update them.

## Structure & Boundaries

The repository root owns Git, `compose.backend.yml` (standalone backend),
`compose.frontend.yml` (frontend overlay), and `docs/`. Combine both files for
frontend development; application Dockerfiles stay in their own directories.
The backend application and its tooling live in `backend/`; `frontend/` contains
the standalone Angular Stage 1 foundation. Do not run Angular CLI
from `backend/`. `docs/api-contract.md` is authoritative for frontend integration.

`backend/src/main.ts` wires startup, database availability, and shutdown;
`backend/src/config.ts` validates environment settings. `backend/src/transport/`
owns HTTP/realtime infrastructure; `backend/src/persistence/` owns PostgreSQL
adapters. `backend/src/README.md` describes application/domain boundaries.
Keep application/domain code
independent of Fastify, Socket.IO, and `pg`. Only the Engine may mutate active
Match state; PostgreSQL stores identity and completed History.

## Commands & Style

Use the active host NVM Node/npm without overriding PATH. Prefer native frontend
`npm run check`, backend static checks and backend `npm run test:unit`.
Prefer Codex's native apply_patch for ordinary source and test edits. Use scripts
for bulk transformations where they help.
Use strict TypeScript, ESM `.js` import specifiers, two-space indentation,
single quotes, and Prettier. Run ESLint; preserve module import restrictions.
Prefer descriptive camelCase functions and kebab-case filenames. Avoid custom DI,
speculative ports, factories, and unused modules.

## Tests & Verification

Tests use Node's test runner through `tsx`; name files `backend/tests/*.test.ts`.
Use Docker for PostgreSQL, full backend regression, real socket integration and
full-stack browser acceptance. From `backend/`, run `npm run test:docker`.
Provision the isolated `trivia_test` database once and configure its
`TEST_DATABASE_URL` in the ignored `backend/.env`. See `README.md` for setup.
Rebuild the tools image after backend changes that affect its copied inputs.
Use real ephemeral listeners for transport tests and controlled time for future
gameplay tests. Assert invariants, rejection/no-op preservation, and regressions.
Run typecheck, lint, formatting checks, tests, and build. For lifecycle/infrastructure
changes, also build Compose, verify both health checks, test Socket.IO, and confirm
clean shutdown. Report exact checks and limitations; do not claim unrun checks passed.

## Scope & Delivery

The accepted backend supports authentication, ten-question gameplay, atomic
completion persistence and participant-authorized History. Frontend has Stage 1
foundations/tooling only; authentication, lobby, gameplay and History UI are not implemented.
Do not implement deferred policies or add Redis, brokers, distributed
ownership, or active-Match recovery without approval. Preserve unrelated user work.
Keep `.env`, dependencies, builds, and caches out of Git; retain the lockfile.
Use Conventional Commits (`feat`, `fix`, `docs`, `refactor`, etc.) and focused PR
descriptions with verification.
Do not commit or push unless requested.

For structural codebase exploration, use the installed `codebase-memory` skill
and verify coverage for relied-on files.

## Release Workflow

Normal development commits do not bump versions. Use `npm run release:dry-run`
and, only when requested, `npm run release` from clean `main` with Node.js >=26.13.0 <27
and Git, inside Docker from a mounted checkout's `backend/` directory. The shared
`CHANGELOG.md` and `changelog/archive/` remain at the repository root.
`!`/`BREAKING CHANGE:` retain major-bump semantics, even on hidden types.
Release-it synchronizes package/lock versions, generates notes, archives sections
beyond the newest ten, then commits all release files and creates an annotated tag.
Introduction and Unreleased content stay; conflicting archives abort without overwrite.
The plugin writes in `beforeRelease`, so archive after that plugin-specific hook,
not `after:bump`. Verify upgrades with temporary Git repositories. Automatic push,
npm publish, and GitHub Releases are disabled; do not create real release commits
or tags without explicit authorization.
