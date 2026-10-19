# Trivia Game M1 backend

Single-process TypeScript backend: Fastify HTTP and Socket.IO share one
Node.js HTTP server; PostgreSQL supplies local durable storage infrastructure.
The pure Match Engine and application runtime support the complete ten-question
lifecycle, serialized commands and authoritative timers. They are not connected
to transport gameplay handlers yet. Authentication, application tables, migrations,
History API and frontend remain unimplemented.

## Design authority

Read [system-design.md](docs/system-design.md) first, followed by
[low-level-design.md](docs/low-level-design.md),
[database-design.md](docs/database-design.md),
[components](docs/HLD_Component_Diagram.md),
[data flows](docs/Data_Flow_Diagram.md), and
[programming principles](docs/programming-principles.md).

The approved bootstrap stack uses Fastify instead of the older NestJS suggestion
in the design technology table. Architectural ownership and gameplay contracts
remain authoritative. Open/deferred policies require an approved decision.

## Prerequisites

- Docker Engine with Docker Compose v2 or newer.
- Node.js 24.15+ and its bundled npm for native development (optional for Docker-only use).
- Free local ports 3000 and 5432, or alternatives set in `.env`.

If ports are occupied, change `PORT` and `POSTGRES_PORT` in `.env` and update the
native `DATABASE_URL` to match before starting.

## Docker setup

```sh
cp .env.example .env
docker compose up --build --wait
curl --fail http://127.0.0.1:3000/health
docker compose ps
docker compose logs -f backend
```

`GET /health` returns `200 {"status":"ok"}`. It reports process liveness, not
ongoing database readiness. Compose waits for PostgreSQL's `pg_isready` check;
the backend also executes `SELECT 1` before listening. Both services have health
checks. Local ports bind to loopback; backend listens on `0.0.0.0` inside its
container. The runtime image runs as the unprivileged `node` user.

`DATABASE_URL` is the backend's only database configuration source. It must include
username, nonempty password, host, and database; port defaults explicitly to 5432.
The backend decodes the URL into explicit pool settings and ignores `PG*` connection
variables. TLS defaults to disabled for local development; `?sslmode=verify-full`
enables certificate/hostname verification. Other URL query options are rejected.

For native development set `DATABASE_URL` with the published localhost port. For
Compose set `COMPOSE_DATABASE_URL` with the internal `postgres:5432` address; Compose
passes that complete value to the backend as `DATABASE_URL`. Percent-encode username,
password, and database **independently**, for example with `encodeURIComponent`.
A password `p@ss:/?#%$` becomes `p%40ss%3A%2F%3F%23%25%24`. Do not interpolate raw
credentials into a URI. Single-quote raw `.env` values containing `#`, `$`, or spaces
so Compose does not interpolate `$` in provisioning passwords.

`POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` provision the database container
only; they must match the decoded backend URLs. These defaults are local-development
credentials, not production secrets. Provisioning changes apply only to a newly
initialized volume; existing credentials are not changed by editing `.env`. Keep
URLs out of logs and command output; failure diagnostics report codes, not driver
messages or stacks that could contain secrets.

```sh
# Rebuild after source or dependency changes; no source bind mount is used.
docker compose up --build --wait
# Check the running environment using the development/tooling image.
docker compose --profile tools run --build --rm tools npm run check
docker compose --profile tools run --build --rm -e SMOKE_URL=http://backend:3000 tools npm run smoke
# Gracefully stop (retains containers and PostgreSQL data).
docker compose stop
# Remove containers/network, retaining the named database volume.
docker compose down
```

The optional `tools` profile runs checks on demand; it is not another backend
process. SIGINT/SIGTERM close Socket.IO connections, drain HTTP, and end the database
pool, in that order. Signals during startup request shutdown; cleanup waits for the
bounded startup operation to settle. Repeated signals share that same cleanup path.
Startup/cleanup failures exit nonzero, including a connection failure after a shutdown
request. Shutdown has a 10-second bound; Compose allows 15 seconds before killing.

## Native development

```sh
cp .env.example .env
npm ci
docker compose up -d --wait postgres
npm run dev
```

Node loads `.env` directly, and watch mode restarts on source changes. Avoid running
the Compose backend on the same port. Environment variables override `.env` values.
Missing/invalid settings fail startup; the database connection attempt is bounded.

| Command                                   | Purpose                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `npm run dev`                             | Start TypeScript with watch mode and `.env` loading                      |
| `npm run typecheck`                       | Check source and tests without emitting files                            |
| `npm run lint`                            | ESLint rules and application/domain import restrictions                  |
| `npm run format` / `npm run format:check` | Apply/check Prettier formatting                                          |
| `npm test`                                | Run real HTTP and Socket.IO smoke tests plus configuration tests         |
| `npm run build`                           | Compile backend into ignored `dist/`                                     |
| `npm start`                               | Start the compiled backend with `.env` loading                           |
| `npm run check`                           | Typecheck, lint, formatting, tests, and build                            |
| `npm run smoke`                           | Check health and polling/WebSocket connections against a running backend |

Smoke checks load `.env` and use its `PORT`; set `SMOKE_URL=http://127.0.0.1:4000`
to test another address. Ordinary tests use
ephemeral loopback ports and do not need PostgreSQL. They verify that active clients
disconnect and the listener closes. Lifecycle regressions control startup barriers
and use child processes so signals and exit codes are real. The PostgreSQL integration
test is skipped unless `TEST_DATABASE_URL` is supplied; run it against Compose with
`docker compose --profile tools run --build --rm -e TEST_DATABASE_URL tools npm test`
after exporting a complete URL to the internal `postgres:5432` address. No coverage
threshold is imposed yet.

Docker-only contributors can install/update the lockfile without host Node:

```sh
docker run --rm --user "$(id -u):$(id -g)" -e npm_config_cache=/tmp/npm-cache \
  -v "$PWD:/app" -w /app node:24-bookworm-slim npm ci
```

## Commits and releases

Use Conventional Commits for normal development, for example `feat(engine): add
round validation`, `fix(transport): close sockets`, or `docs: clarify setup`.
A normal commit does not bump the version or create a release tag. `feat` recommends
minor, `fix` recommends patch, and `!` or a `BREAKING CHANGE:` footer recommends major,
including breaking changes on normally hidden types.

From a checkout with Node.js 24.15+, npm, and Git, run:

```sh
npm run release:dry-run
npm run release
```

Both require `main` and a clean tree, including untracked files. Commit development
changes before running them. Dry-run previews the recommendation without modifying
files or Git. A release updates `package.json` and `package-lock.json`, generates
`CHANGELOG.md`, archives older sections, then creates a `chore(release): vX.Y.Z`
commit and annotated `vX.Y.Z` tag. Push, npm publishing, and GitHub Releases are disabled.

The changelog shows features, fixes, performance, reverts, documentation, and
refactoring. Ordinary style/chore/test/build/ci entries are hidden. It keeps the
10 newest complete releases in their generated newest-first order; introduction
and Unreleased sections remain. Older sections move verbatim to
`changelog/archive/vX.Y.Z.md`. Identical existing archives are safe; conflicts abort
without removing notes. Inspect the working tree after a failed release before retrying.
The initial changelog contains only its introduction, with no invented release history.

The archival hook runs after this pinned plugin's `beforeRelease` write, before
release-it stages all changed/new files. Integration tests verify this sequence in
temporary Git repositories. The development Docker image includes Git for those
checks; release commands themselves run from a Git checkout. A targeted `basic-ftp`
override patches release-it's transitive proxy dependency; no extra release tool is used.

## Project structure and tooling

```text
src/main.ts                 Composition, database startup, signals
src/config.ts               Environment validation
src/transport/server.ts     Shared Fastify/Socket.IO listener and health
src/persistence/postgres.ts PostgreSQL pool; no schema
src/domain/match-engine.ts  Pure Match lifecycle, answers, scoring and MatchResult
src/application/            Registry, Coordinator, Clock/Scheduler contracts
src/runtime/match-time.ts   Production monotonic clock and Node timer adapter
src/README.md               Runtime APIs, ownership and retry/lifecycle policies
tests/*.test.ts             Deterministic domain/runtime and infrastructure tests
scripts/smoke.mjs           Smoke check for a running environment
docs/                       Preserved architectural and engineering designs
Dockerfile                  Development, build, and minimal runtime stages
docker-compose.yml          Backend, PostgreSQL, optional tooling profile
```

Keep application and domain code independent of transport and database libraries;
ESLint restrictions enforce those boundaries. See `src/README.md` for runtime
admission, retry retention and shutdown contracts. Persistence will
implement required ports, and `main.ts` will wire concrete dependencies.

TypeScript uses strict ESM/NodeNext with `.js` import specifiers. `tsx` executes
TypeScript in tests/watch mode; production runs compiled JavaScript. Node's built-in
test runner avoids an additional test framework. `pg` provides a small PostgreSQL
pool without an ORM; `socket.io-client` is development-only for connection checks.
ESLint handles code checks and Prettier formatting. `docs/` is excluded from automatic
formatting to preserve existing designs. Commit `package-lock.json`; keep `.env`,
`node_modules/`, `dist/`, caches, and local agent/cloud configuration out of Git.
