# Trivia Game M1 backend

Single-process TypeScript backend skeleton: Fastify HTTP and Socket.IO share one
Node.js HTTP server; PostgreSQL supplies local durable storage infrastructure.
This foundation has no gameplay, authentication, application tables, migrations,
History API, or frontend yet.

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
- Node.js 24 and its bundled npm for native development (optional for Docker-only use).
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

Compose uses `PGUSER`/`PGPASSWORD` for credentials and injects an internal
`DATABASE_URL` pointing to `postgres`; the `.env` URL is for native development.
Keep native URL credentials/database name synchronized if you change PostgreSQL
settings. URL credentials must be percent-encoded when necessary. These defaults
are local-development credentials, not production secrets. PostgreSQL initialization
settings apply only when the named data volume is first created.

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
pool. Shutdown has a 10-second bound; Compose allows 15 seconds before killing.

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
disconnect and the listener closes. No coverage threshold is imposed yet.

Docker-only contributors can install/update the lockfile without host Node:

```sh
docker run --rm --user "$(id -u):$(id -g)" -e npm_config_cache=/tmp/npm-cache \
  -v "$PWD:/app" -w /app node:24-bookworm-slim npm ci
```

## Project structure and tooling

```text
src/main.ts                 Composition, database startup, signals
src/config.ts               Environment validation
src/transport/server.ts     Shared Fastify/Socket.IO listener and health
src/persistence/postgres.ts PostgreSQL pool; no schema
src/README.md               Ownership and future application/domain boundaries
tests/*.test.ts             Node test runner smoke/configuration tests
scripts/smoke.mjs           Smoke check for a running environment
docs/                       Preserved architectural and engineering designs
Dockerfile                  Development, build, and minimal runtime stages
docker-compose.yml          Backend, PostgreSQL, optional tooling profile
```

Application/coordinator and domain/engine directories will appear with their first
approved behavior. Keep them independent of transport and database libraries;
ESLint restrictions are already configured for their paths. Persistence will
implement required ports, and `main.ts` will wire concrete dependencies.

TypeScript uses strict ESM/NodeNext with `.js` import specifiers. `tsx` executes
TypeScript in tests/watch mode; production runs compiled JavaScript. Node's built-in
test runner avoids an additional test framework. `pg` provides a small PostgreSQL
pool without an ORM; `socket.io-client` is development-only for connection checks.
ESLint handles code checks and Prettier formatting. `docs/` is excluded from automatic
formatting to preserve existing designs. Commit `package-lock.json`; keep `.env`,
`node_modules/`, `dist/`, caches, and local agent/cloud configuration out of Git.
