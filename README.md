# Trivia Game M1 backend

Single-process TypeScript backend in `backend/`: authenticated realtime gameplay
through ten questions and ten reveals, live FINISHED, atomic PostgreSQL completion
persistence, and participant-authorized HTTP History. `frontend/` contains the
Stage 1 Angular foundation; shared designs and the
[frontend API contract](docs/api-contract.md) remain in `docs/`.

Run Compose from the repository root. Use your active NVM Node/npm for frontend
checks, backend static checks and pure unit tests. Run PostgreSQL, the full
backend regression, real socket tests and full-stack browser checks in Docker.

For Docker-first Angular tooling, local HTTPS certificates, browser smoke checks,
and the narrowly authenticated same-origin polling policy, see the
[frontend README](frontend/README.md). Authentication UI and gameplay are not implemented.

Root orchestration uses `compose.backend.yml` for the standalone backend and
`compose.frontend.yml` as its frontend development overlay. Combine them with
`docker compose -f compose.backend.yml -f compose.frontend.yml`; application
Dockerfiles remain in `backend/` and `frontend/`.

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
- Use the existing host NVM environment for native commands without overriding
  PATH. Docker images pin Node.js 26.13.0 LTS and isolate dependencies and builds.
- Free local ports 3000 and 5432, or alternatives set in `backend/.env`.

If ports are occupied, change `PORT` and `POSTGRES_PORT` in `backend/.env` before starting.
Every root Compose command below explicitly selects that relocated environment file;
Compose does not load it automatically from `backend/`.

## Docker setup

```sh
cp backend/.env.example backend/.env
docker compose -f compose.backend.yml --env-file backend/.env up --build --wait
curl --fail http://127.0.0.1:3000/health
docker compose -f compose.backend.yml --env-file backend/.env ps
docker compose -f compose.backend.yml --env-file backend/.env logs -f backend
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

For Compose set `COMPOSE_DATABASE_URL` with the internal `postgres:5432` address; Compose
passes that complete value to the backend as `DATABASE_URL`. Percent-encode username,
password, and database **independently**, for example with `encodeURIComponent`.
A password `p@ss:/?#%$` becomes `p%40ss%3A%2F%3F%23%25%24`. Do not interpolate raw
credentials into a URI. Single-quote raw `.env` values containing `#`, `$`, or spaces
so Compose does not interpolate `$` in provisioning passwords.

`POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` provision the database container
only; they must match the decoded backend URLs. These defaults are local-development
credentials, not production secrets. Provisioning changes apply only to a newly
initialized volume; existing credentials are not changed by editing `backend/.env`. Keep
URLs out of logs and command output; failure diagnostics report codes, not driver
messages or stacks that could contain secrets.

```sh
# Rebuild after source or dependency changes; no source bind mount is used.
docker compose -f compose.backend.yml --env-file backend/.env up --build --wait
# Check the running environment using the development/tooling image.
docker compose -f compose.backend.yml --env-file backend/.env --profile tools run --build --rm tools npm run check
docker compose -f compose.backend.yml --env-file backend/.env --profile tools run --build --rm -e SMOKE_URL=http://backend:3000 tools npm run smoke
# Gracefully stop (retains containers and PostgreSQL data).
docker compose -f compose.backend.yml --env-file backend/.env stop
# Remove containers/network, retaining the named database volume.
docker compose -f compose.backend.yml --env-file backend/.env down
```

The optional `tools` profile runs checks on demand; it is not another backend
process. SIGINT/SIGTERM close Socket.IO connections, drain HTTP, and end the database
pool, in that order. Signals during startup request shutdown; cleanup waits for the
bounded startup operation to settle. Repeated signals share that same cleanup path.
Startup/cleanup failures exit nonzero, including a connection failure after a shutdown
request. Shutdown has a 10-second bound; Compose allows 15 seconds before killing.

## Player identity migration and verification

The backend does not create schema at startup. Apply the versioned migration
explicitly after PostgreSQL is healthy:

```sh
docker compose -f compose.backend.yml --env-file backend/.env up -d --wait postgres
docker compose -f compose.backend.yml --env-file backend/.env --profile tools run --build --rm tools npm run migrate
```

The tools image builds before applying migrations. Repeating the command is safe: applied SQL is tracked with a checksum;
changed or unknown migration versions fail instead of being replayed. The migrations
create `player` and `password_credential` and enforce canonical usernames. Player IDs are server-generated UUIDs.
Players can use the Stage 2.5 `/register` frontend and `POST /auth/register` contract.
No separate public provisioning command is available.

PostgreSQL integration tests use the isolated `trivia_test` database. Start
PostgreSQL from the repository root, then create the database once if it does
not already exist:

```sh
docker compose -f compose.backend.yml --env-file backend/.env up -d --wait postgres
docker compose -f compose.backend.yml --env-file backend/.env exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" trivia_test'
```

In the ignored `backend/.env`, set `TEST_DATABASE_URL` once to a complete
PostgreSQL URL using your local database credentials, Compose host `postgres`,
port `5432`, and database `trivia_test`. Keep the URL in that file so Compose
loads it on each run. Build the tools image from the repository root:

```sh
docker compose -f compose.backend.yml --env-file backend/.env --profile tools build tools
```

Then run the full regression from `backend/`:

```sh
npm run test:docker
```

Build the tools image the first time and after changes to its copied inputs
(backend source, tests, migrations, package files or tooling configuration).
Repeat `test:docker` without rebuilding when those inputs are unchanged.
The script checks that `TEST_DATABASE_URL` names a `*_test` database and verifies
the connected database before starting `npm test`. A missing URL fails the
command instead of skipping database coverage. Keep PostgreSQL healthy before
running it. Docker access is subject to the session's approval policy, including
when invoked through npm.

The tests verify the database name before writing and clean up only their own
Player fixtures. They apply migrations only to the isolated test database. Keep credentials out
of committed files and command output.

## Hybrid verification

From the repository root, run these checks natively:

```sh
npm --prefix frontend run check
npm --prefix backend run typecheck
npm --prefix backend run lint
npm --prefix backend run format:check
npm --prefix backend run build
npm --prefix backend run test:unit
```

The unit subset uses Node's `tsx` loader and an explicit list of test files that
run without socket listeners, PostgreSQL or subprocess fixtures. Use
`test:docker` for the full regression. The tools image copies backend sources
into `/app` and uses its own dependencies and build output. See the
[frontend README](frontend/README.md) for the Docker browser smoke commands.

| Command                                   | Purpose                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `npm run dev`                             | Start TypeScript with watch mode and `.env` loading                      |
| `npm run typecheck`                       | Check source and tests without emitting files                            |
| `npm run lint`                            | ESLint rules and application/domain import restrictions                  |
| `npm run format` / `npm run format:check` | Apply/check Prettier formatting                                          |
| `npm test`                                | Run real HTTP and Socket.IO smoke tests plus configuration tests         |
| `npm run build`                           | Compile backend into ignored `dist/`                                     |
| `npm run migrate`                         | Build and explicitly apply/check versioned PostgreSQL migrations         |
| `npm start`                               | Start the compiled backend with `.env` loading                           |
| `npm run check`                           | Typecheck, lint, formatting, tests, and build                            |
| `npm run smoke`                           | Check health and polling/WebSocket connections against a running backend |

Smoke checks load `.env` and use its `PORT`; set `SMOKE_URL=http://127.0.0.1:4000`
to test another address. Ordinary tests use
ephemeral loopback ports and do not need PostgreSQL. They verify that active clients
disconnect and the listener closes. Lifecycle regressions control startup barriers
and use child processes so signals and exit codes are real. PostgreSQL integration
tests are skipped unless `TEST_DATABASE_URL` is supplied. Use a dedicated `_test`
database as described above. No coverage
threshold is imposed yet.

Docker-only contributors can install/update the lockfile without host Node:

```sh
docker run --rm --user "$(id -u):$(id -g)" -e npm_config_cache=/tmp/npm-cache \
  -v "$PWD/backend:/app" -w /app node:26.13.0-bookworm-slim npm ci
```

## Commits and releases

Use Conventional Commits for normal development, for example `feat(engine): add
round validation`, `fix(transport): close sockets`, or `docs: clarify setup`.
A normal commit does not bump the version or create a release tag. `feat` recommends
minor, `fix` recommends patch, and `!` or a `BREAKING CHANGE:` footer recommends major,
including breaking changes on normally hidden types.

Release commands require a mounted Git checkout, unlike the ordinary copied-source
tools service. From the repository root, prepare a Docker tools image and isolated
dependencies; the checkout's `backend/` is the package working directory:

```sh
docker compose -f compose.backend.yml --env-file backend/.env --profile tools build tools
# Mount the whole checkout for Git and the root changelog, with isolated node_modules.
docker compose -f compose.backend.yml --env-file backend/.env --profile tools run --rm \
  -v "$PWD:/workspace" -v /workspace/backend/node_modules -w /workspace/backend \
  tools sh -c 'npm ci && npm run release:dry-run'
```

Only when explicitly authorized, replace `release:dry-run` with `release`.
The mount is writable because an authorized release updates the checkout.

Both require `main` and a clean tree, including untracked files. Commit development
changes before running them. Dry-run previews the recommendation without modifying
files or Git. A release updates `backend/package.json` and `backend/package-lock.json`, generates
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
backend/src/main.ts                 Composition, database startup, signals
backend/src/config.ts               Environment validation
backend/src/transport/server.ts     Shared Fastify/Socket.IO listener and health
backend/src/persistence/postgres.ts PostgreSQL pool
backend/src/persistence/players.ts  Player/Credential SQL repository
backend/src/persistence/migrations.ts Explicit migration runner
backend/src/application/password.ts Argon2id hashing and verification
backend/src/application/authenticate-player.ts Internal authentication/provisioning use cases
migrations/                 Versioned Player/Credential SQL
backend/src/domain/match-engine.ts  Pure Match lifecycle, answers, scoring and MatchResult
backend/src/application/            Registry, Coordinator, Clock/Scheduler contracts
backend/src/runtime/match-time.ts   Production monotonic clock and Node timer adapter
backend/src/README.md               Runtime APIs, ownership and retry/lifecycle policies
backend/tests/*.test.ts             Deterministic domain/runtime and infrastructure tests
backend/scripts/smoke.mjs           Smoke check for a running environment
docs/                       Preserved architectural and engineering designs
backend/Dockerfile          Development, build, and minimal runtime stages
compose.backend.yml         Backend, PostgreSQL, optional tooling profile
compose.frontend.yml        Frontend HTTPS development overlay
```

Keep application and domain code independent of transport and database libraries;
ESLint restrictions enforce those boundaries. See `backend/src/README.md` for runtime
admission, retry retention and shutdown contracts. The composition root wires concrete persistence and transport adapters.

TypeScript uses strict ESM/NodeNext with `.js` import specifiers. `tsx` executes
TypeScript in tests/watch mode; production runs compiled JavaScript. Node's built-in
test runner avoids an additional test framework. `pg` provides a small PostgreSQL
pool without an ORM; `socket.io-client` is development-only for connection checks.
ESLint handles code checks and Prettier formatting. `docs/` is excluded from automatic
formatting to preserve existing designs. Commit `backend/package-lock.json`; keep `.env`,
`node_modules/`, `dist/`, caches, and local agent/cloud configuration out of Git.

## Authentication and sessions (Phase 4 Slice 2)

Apply migrations explicitly with `npm run migrate`; `002_canonical_username.sql`
checks legacy username collisions/invalid characters before changing anything. A
failure preserves accounts and migration ledger. Resolve conflicts manually through
an approved data-remediation plan; never merge accounts automatically. Usernames
are ASCII `[A-Za-z0-9_.-]`, 1–128 bytes, canonically lowercase and case-insensitive.
Display names retain Unicode/spaces/emoji, use 1–64 extended graphemes, and reject
blank or unsafe control content. Existing display rows are preserved without adding
an ICU-dependent database constraint. Stage 2.5 exposes only `POST /auth/register`
for public creation; internal provisioning remains a separate trusted primitive.

`POST /auth/login` takes exactly `{ username, password }` as JSON (4 KiB body;
password 1–1024 UTF-8 bytes without normalization). It sets a cookie and returns
`{ player: { id, displayName } }`. Wrong/unknown credentials both return
`401 INVALID_CREDENTIALS`; malformed input returns 400/413/415. Database failures
and verification saturation return 503; throttling returns `429 RATE_LIMITED`.
`GET /auth/profile` returns the public profile or 401 and never refreshes idle.
`POST /auth/logout` accepts JSON `{}`, requires a session, revokes only that session,
clears the cookie and closes its sockets; success is 204, missing session is 401.
Auth responses are not cached and credentials are not returned in JSON/logs.

Configure `AUTH_COOKIE_MODE`, `AUTH_PUBLIC_ORIGIN`, and comma-separated exact
`AUTH_ORIGINS`. Secure mode requires HTTPS and permits only schemeful same-site
origins (private public-suffix boundaries included). It uses
`__Host-trivia_session; Path=/; HttpOnly; Secure; SameSite=Lax`, without Domain.
Credentialed CORS and preflight support configured origins. Every present Origin
must be allowlisted; null/disallowed values reject. Safe read-only profile/History
GETs permit absent Origin without Referer, with session/no-store/non-refresh rules
unchanged. Login/logout, polling POST, and WebSocket require Origin. Only polling
GET has the narrowly session-authenticated trusted-HTTPS/Fetch Metadata exception
defined in [API §4](docs/api-contract.md#4-socketio-connection-and-subscriptions).
The frontend development overlay selects its local Origin explicitly. HTTPS terminated at a
proxy requires `AUTH_TRUST_PROXY` with only its explicit IP/CIDR addresses; forwarded
IP/TLS headers from other peers are ignored. Forwarded TLS must be exactly `https`.

Native non-production loopback development may explicitly use `loopback` cookie
mode with local HTTP origins and `trivia_session` without Secure. Actual socket
peers must be loopback; a Docker bridge peer is not accepted merely because its
Origin says localhost. Compose's production image requires secure configuration;
use an HTTPS deployment/proxy for browser auth. Health remains public HTTP liveness.
Missing production security configuration fails startup. Never set blanket proxy trust.

Sessions contain only server-side public Player identity, keyed by SHA-256 digest
of 256-bit random tokens. They expire after 30 minutes idle or 12 hours absolute;
independent logins coexist and process restart requires login again. One timer per
session removes expired records and closes associated sockets. Profile lookups,
heartbeats and passive presence do not extend idle. Future Gateway code must call
`SessionStore.act(token, player => coordinator.dispatch(...))`: final authorization,
intentional activity and synchronous admission belong in that callback without an
intervening await. Later logout never cancels already admitted work. This slice
implements no gameplay handlers, Match rejoin, recovery or disconnect membership policy.

Login protection allows 60 attempts/IP and 10 credential failures/canonical username
per sliding 15 minutes, and at most four lookup/Argon2 verification operations in
flight. No queue is created. Success/outages do not erase failure history; stale
limiter entries expire, keys are capped at 10,000 per map and saturation fails 503.
`tldts` supplies maintained public-suffix parsing for same-site checks; it is the
only new dependency. Password hashing retains the Slice 1 Argon2id parameters.

Run `npm run check`, or the existing Docker tools workflow, with a separate
`TEST_DATABASE_URL` ending in `_test` for real migration/identity tests. Migration
fixtures use fresh isolated schemas, including collision rollback and concurrent runs.
`npm run smoke` verifies health and rejection of unauthenticated sockets. To also
verify authenticated connections, provide `SMOKE_ORIGIN`, `SMOKE_USERNAME` and
`SMOKE_PASSWORD` for an internally provisioned test account via an untracked local
environment; keep those values out of command output and shell history.

## Registration capacity

Stage 2.5 uses Register → Login → Play. Registration creates no cookie/session and
reuses the existing atomic Player/Credential transaction and Argon2id parameters.
The approved password policy has no blocklist or composition rule. See
[API §2.2](docs/api-contract.md#22-self-registration-stage-25) for exact contracts.

Benchmark command inside the backend tools container: `npm run build` then
`node scripts/benchmark-registration.mjs`. The benchmark is hash/verification-only,
uses no database/accounts, and should be run separately from application traffic.
Recorded environment: Node 26.13.0, Linux x64 Debian backend image, Intel i5-12400F,
12 available logical CPUs, approximately 31 GiB host RAM, no configured container
CPU/memory limit (`cpu.max=max`, `memory.max=max`), default native executor settings.
Forty rounds/case, alternating admission order in mixed cases; each Login column
uses four simultaneous verifications. RSS is sampled process peak in a shared
benchmark process, not an isolated allocation delta. Event-loop p99 was about
11 ms with a 10 ms monitor resolution. These are local measurements, not an SLO.

| Registration operations | Login operations | Registration p95 ms | Login p95 ms | Peak RSS MiB | CPU core equivalents |
| --- | --- | --- | --- | --- | --- |
| 0 | 4 | — | 20.33 | 140.4 | 3.91 |
| 1 | 0 | 15.39 | — | 84.1 | 1.03 |
| 2 | 0 | 15.29 | — | 103.5 | 2.00 |
| 4 | 0 | 25.00 | — | 141.8 | 3.82 |
| 1 | 4 | 32.98 | 30.75 | 141.9 | 3.01 |
| 2 | 4 | 36.46 | 34.29 | 142.1 | 3.23 |
| 4 | 4 | 40.63 | 39.19 | 142.1 | 3.91 |

Selected **two registration slots**: lower standalone memory/CPU than four, bounded
mixed latency and additional headroom. Existing four-slot Login behavior is unchanged;
at most six application operations are admitted across both services. There is no
registration application queue; the native executor may queue this bounded work.
A disconnect does not release a slot while non-cancellable hashing/COMMIT is active.
Shutdown stops admission and drains active work before pool shutdown.

Separate quotas: **20 admitted attempts/IP/15 minutes**, enough for ten demo Players
behind one NAT with a retry each, and **100 attempts/process/hour** to bound account
and hashing growth. Invalid bodies and conflicts consume attempts after Origin/TLS
checks. State expires and has a 1000-IP hard cap; global admission further bounds
actual recent keys. Busy/unavailable work returns 503/Retry-After; quota exhaustion
returns 429 with the remaining delay. These process-local limits reset on restart,
can deny service when deliberately exhausted, and do not eliminate distributed spam.
Rebenchmark/review quotas when hardware, container limits or exposure change.

The development database was verified as local Compose-owned `trivia`, backed up
outside Git, and migrated from 001 to 001–003 after collision/invalid-value checks
both returned zero. Existing data was preserved; no registration migration was added.
Use a separately verified `*_test` database for adversarial tests, never the live
development database or persistent-volume resets.
