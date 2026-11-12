# Trivia frontend — Stage 2.5

Angular 22 SPA with self-registration, login, server-session verification, protected
`/play`, and logout, using the accepted Stage 1 Docker/HTTPS foundation. Match entry, lobby,
gameplay, and History screens are not implemented. Follow [design guidelines](../docs/frontend-design-guidelines.md)
and the [API contract](../docs/api-contract.md).

## Authentication and protected navigation

Open `https://localhost:4200/` with the local CA trusted. Choose **Create an account**
or visit `/register`; existing pre-provisioned accounts still work. Password recovery
is not implemented. Enter credentials exactly as created. Username case is preserved in the request and canonicalized
only by the backend; neither field is trimmed. Credentials live only in the form's
memory for its lifetime; the form clears on successful login. No tokens or
credentials are placed in browser storage or URLs.

- Entry to `/`, `/login`, `/register`, or `/play` shares one initial `GET /auth/profile` check.
  A 200 restores the public Player profile; `401 UNAUTHENTICATED` means anonymous.
  Network/timeout, 403, 500, and 503 verification failures hide private content and
  show explicit recovery instead of assuming expiry or entering a redirect loop.
- `/login` uses Signal Forms with accessible labels, backend-compatible input bounds,
  and inline validation/authentication errors. Deliberate submission sends exactly
  `{ username, password }` to `POST /auth/login`; duplicates are blocked while pending.
  A rejected form retains the inputs. There are no automatic login retries.
- `/play` requires a verified authenticated state and shows only the Player's display
  name, active-session message, sign-out control, and a noninteractive Stage 3 note.
  Authenticated `/login` visits redirect here. All implemented protected destinations
  currently resolve to `/play`; arbitrary `returnTo` URLs are never followed.
  Unknown/future feature paths show a not-found page, not feature placeholders.
- Sign out sends JSON `{}` to `POST /auth/logout`. A 204 clears the local viewer and
  returns to Login. A `401 UNAUTHENTICATED` shows an already-ended session, without
  claiming a successful revocation. Other failures/timeouts hide the previous profile
  and explicitly say sign-out was not confirmed. The user can check the session or
  retry sign-out; neither mutation is automatically resent. If revalidation succeeds,
  `/play` states that the session is still active.
- Relative Angular HttpClient requests use `withCredentials: true` and a 10-second
  request timeout. Cookies remain browser-managed, HttpOnly, Secure, and SameSite=Lax.
  No cookie parsing, token persistence, identity headers, or Origin rewriting exists.
  Backend guards remain the security authority; Angular guards only aid navigation.
- The single `Session` service exposes readonly signals for checking/authenticated/
  anonymous/unavailable state and operation feedback. Each request captures an epoch;
  obsolete results cannot replace the current viewer or clear a newer session.
  Profile checks coalesce, and mutations are not dispatched twice while unresolved.
  Future protected readers must capture `generation` before their request and pass it
  to `unauthenticated(generation)` only for authoritative `401 UNAUTHENTICATED`.
  Currently the only viewer-owned private data is the in-memory profile.
- 400/413/415 show input feedback; invalid credentials, forbidden connection, rate
  limits, server failures, and network failures have distinct safe copy. Retry-After
  blocks retries until its deadline; no keep-alive, recurring profile polling, or
  session-refresh mechanism is added. Session changes in another tab are discovered
  on the next supported authenticated request/reload, not instantaneously synchronized.

The light-theme tokens remain provisional. Login and `/play` use opaque surfaces,
scoped SCSS, semantic native controls, visible keyboard focus, live error/status
regions, responsive reflow, and reduced-motion support. Internal route changes move
focus to the main landmark; initial load retains normal document tab order.

## Self-registration

The approved flow is **Register → Login → Play**. Supply username, separate public
display name, password and exact confirmation. Username and display-name rules
match the backend; new passwords require 15 Unicode code points minimum and 1024
UTF-8 bytes maximum. Passwords are never trimmed/normalized; no composition rule or
blocklist is added. Login keeps its legacy 1–1024-byte bounds. Shared pure credential
validators prevent drift; display names use the existing 64-grapheme/control policy.

The component-scoped `Registration` API class sends only username/displayName/
password, with credentialed relative HttpClient and a ten-second timeout. Native
Signal Forms `submitting()` covers the complete request; a disabled fieldset and
computed button condition prevent duplicates. The component owns registration
feedback only; `Session` remains the sole authenticated viewer store and is unchanged.
Public-entry guards redirect authenticated users to `/play`. Unavailable profile
checks show recovery rather than an anonymous form. Destroyed/obsolete callbacks
cannot publish success or navigate. No password is transferred to Login.

Only a confirmed 201 shows **Account created**, clears the form/passwords, focuses
the confirmation heading, and offers **Continue to sign in**. Registration sets no
cookie or session. A 409 means username unavailable, never proof of account ownership.
Network/500/503 failures explicitly say creation was not confirmed and may have
succeeded: use Login with the chosen credentials or retry manually. No mutation is
automatically resent. Retry-After blocks manual resubmission until its deadline.
Registration quotas are separate from Login; see [capacity evidence](../README.md#registration-capacity).

Login/Register share a small scoped SCSS module, semantic tokens and stable feedback
pattern, not a component framework. Normal field messages reserve one line; status
reserves two below the action. Long messages grow without clipping. Narrow containers
reserve two button-label lines at enlarged text sizes. Keyboard skip navigation now
focuses the main landmark without leaving nested routes through the document base URL.

The browser image can run public registration acceptance with the same certificate,
script/results mounts and container network used below, but a **writable private**
SMOKE_DIR and no input credentials:

```sh
docker run --rm --network "container:$(dc ps -q frontend)" \
  -v "$SMOKE_DIR:/smoke" \
  -v "$PWD/frontend/.certs:/app/.certs:ro" \
  -v "$PWD/frontend/scripts:/app/scripts:ro" \
  -v "$PWD/frontend/test-results:/app/test-results" \
  trivia-frontend-browser sh scripts/browser-smoke.sh scripts/register-browser-smoke.mjs
```

This creates random disposable accounts **through the browser UI**, verifies 201
without a cookie, explicit Login, `/play`, reload and logout, canonical conflicts,
mobile touch, keyboard/focus, and network/capacity feedback. A real COMMIT followed
by a dropped response verifies truthful uncertain-outcome recovery. Layout-only 409s
are intercepted to compare Register-button geometry across idle, pending, validation,
correction and repeated conflicts at 1280/375px and 320px with 200% text. Run against
a controlled development/test database, not a public deployment. It writes private
credentials.json (for the existing auth/transport probes) and players.json (exact
fixture IDs for cleanup) to SMOKE_DIR. Remove only those fixtures afterward, revoke
remaining test sessions, and delete credentials; never delete unrelated Players.

Verification: 74 Angular + 3 proxy tests; full backend suite 305 tests, all zero
failed/skipped, through Docker. Real Chromium registration, existing authentication
and Origin/polling/WebSocket smoke are required; screenshots are under ignored
test-results. Human screen-reader speech review remains outstanding; no complete
WCAG compliance claim is made. No Match/Lobby/gameplay/History UI is added.

## Versions and checks

Pinned framework/compiler 22.2.5, CLI/build 22.2.6, TypeScript 6.0.3, RxJS 7.8.2,
Node 26.13.0, npm 11.20.0. Angular 22 supports Node 26 and TypeScript >=6.0 <6.1:
[official compatibility](https://angular.dev/reference/versions).
Direct package versions and the frontend lockfile are pinned; all Node/npm/CLI
commands run in Docker at `/app`, independently of backend dependencies.

## Local development

Run these commands from the repository root. The overlay reuses the existing
backend/PostgreSQL services with their existing orchestration. The only backend
behavior change is the narrow polling GET compatibility policy documented below.
Prepare the existing untracked `backend/.env` using the root README if necessary.

```sh
# Convenience function for this shell only.
dc() {
  docker compose --env-file backend/.env -f compose.backend.yml -f compose.frontend.yml "$@"
}
docker build --target development -t trivia-frontend-dev frontend
# Creates ignored local CA/server keys, refusing to overwrite existing certificates.
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD/frontend:/app" -w /app \
  trivia-frontend-dev sh scripts/certificates.sh
```

The image includes OpenSSL; host Node, Angular CLI, nvm, and mkcert are unnecessary.

Trust **only the public `frontend/.certs/ca.pem`** in your development browser/OS
certificate store before browsing. Never import or share `ca-key.pem` or the server
private key. The leaf certificate covers `localhost` and expires after 90 days;
the CA expires after 365 days. Renewal is an explicit local operation: remove only
your expired generated leaf/CSR/serial files and rerun certificate generation after
reviewing the script, or generate a fresh CA and update local trust. The script
refuses automatic replacement. Keep all `.certs` material out of Git and the graph.

```sh
dc build backend frontend
dc up -d --wait postgres
# Existing versioned migrations; apply only to your intended development database.
dc --profile tools run --rm tools npm run migrate
dc run --rm --no-deps frontend npm ci
dc up -d --wait backend frontend
dc ps
# Open https://localhost:4200/ after trusting the CA.
```

The frontend dependency volume is separate from backend and host dependencies.
After changing package files, stop frontend, rebuild its image, run `npm ci` in its
volume, then recreate it. Images run tooling as the `node` user (UID/GID 1000);
adapt local bind-mount ownership for other host IDs. Normal file watching uses
bind-mount events; append `--poll=1000` to `npm start` only if events are unavailable.
For a future live demo use `npm run start:demo` to disable automatic full reload/HMR;
a refresh cannot restore an active Match subscription.

## HTTPS boundary and routing

Confirmed local values: browser Origin `https://localhost:4200`; Angular's internal
HTTP listener `127.0.0.1:4201`; backend target `http://backend:3000`.
Only port 4200 is published for frontend, bound to host loopback. Do not substitute
`127.0.0.1` in the browser URL. Internal addresses never enter browser API URLs.

The preferred Angular proxy was tested first. Angular 22.2.6's component middleware
calls `decodeURIComponent` before its proxy and returns an HTML stack trace for
`/history/%ZZ`. The justified fallback is a small HTTPS gateway in the **same
frontend container**, using `http-proxy`; no additional service is introduced.
It proxies auth, History (including roots/query strings), and Socket.IO before
Angular. Other paths reach Angular. Invalid URL encoding receives safe no-store
400 JSON. Backend URLs are otherwise forwarded unchanged.

The gateway preserves Origin/cookies/Host, strips client-supplied `Forwarded` and
`X-Forwarded-*`, and derives forwarding data only from the actual TLS connection.
Backend secure-cookie mode remains enabled. The dedicated `172.30.47.0/29` network
assigns frontend `172.30.47.2`, backend `172.30.47.3`; backend trusts **only
172.30.47.2/32**. Check for network conflicts before startup. If changing these
values, keep subnet, addresses, trusted peer, Origin, port, and certificate SANs
consistent. Do not broaden proxy trust or rewrite/synthesize Origin.

This is development tooling, not production deployment infrastructure. Certificate
verification is never globally disabled. Direct requests from untrusted peers with
forged forwarding headers remain rejected. The underlying backend port mapping,
if enabled by root Compose, does not bypass its HTTPS enforcement.

## Verification commands

```sh
dc exec frontend node --version
dc exec frontend npm --version
dc exec frontend npm exec ng version
dc exec frontend npm run check
# Individual scripts: typecheck, test, lint, format:check, build.
# Production assets: frontend/dist/trivia/browser (static SPA, no SSR).
dc logs frontend backend
dc stop
```

`typecheck` uses Angular compiler strict/template checks. `test` runs 74 focused
Angular tests (22 session/HTTP/concurrency, 8 routing/shell, 14 Login form, 30 Register) with
CLI-default Vitest, plus three Node proxy-boundary regressions. It does not establish
future feature correctness. Build also compiles strict templates.
ESLint covers TypeScript, Angular HTML accessibility, and tooling JavaScript.
Prettier checks source/configuration/docs. Install audit currently reports ten Moderate
ESLint/minimatch tooling findings, no High/Critical; no forced downgrade/override was
applied. Re-evaluate compatible fixes before expanding tooling exposure.

## Real-browser transport smoke

Same-origin polling is supported by the narrow, session-authenticated GET exception
in [API §4](../docs/api-contract.md#4-socketio-connection-and-subscriptions). Behind the
explicitly trusted HTTPS proxy it requires exact same-origin Fetch Metadata and
public Host/Referer agreement. It is not a blanket missing-Origin allowance. POST
and WebSocket still require an allowlisted Origin; null/disallowed values reject.
The gateway does not add or rewrite Origin or Fetch Metadata. Session resolution
on eligible GETs never refreshes idle. Clients lacking the required evidence fail closed.

The smoke verifies trusted TLS, root/fallback routing, desktop/mobile layout,
keyboard skip/focus, reduced motion, unauthenticated profile/History, safe malformed
URLs, browser-stored Secure/HttpOnly/SameSite=Lax session cookies, login/profile/History,
authenticated polling GET/POST, polling-to-WebSocket upgrade, direct WebSocket,
logout invalidation/socket disconnect, and anonymous, null/opaque, disallowed
same-site and cross-site Origin rejection. No Match commands or subscriptions are
created. Wire headers are captured using CDP and logged with cookie values redacted.

Use a controlled registered or pre-provisioned disposable account and an outside-repository JSON
file containing exactly username/password. Do not embed credentials in source or
committed configuration. Provisioning remains internal; the root README describes
migration and identity prerequisites. This probe exercises transport directly, independently of the Login UI; internal provisioning is not a public API.

```sh
docker build --target browser -t trivia-frontend-browser frontend
# Set SMOKE_DIR to a private directory containing credentials.json, then:
mkdir -p frontend/test-results
docker run --rm --network "container:$(dc ps -q frontend)" \
  -e SMOKE_CREDENTIALS=/smoke/credentials.json \
  -v "$SMOKE_DIR:/smoke:ro" \
  -v "$PWD/frontend/.certs:/app/.certs:ro" \
  -v "$PWD/frontend/test-results:/app/test-results" \
  trivia-frontend-browser
```

The browser target uses Node 26 and Chromium; it imports this local CA into an
isolated temporary NSS store. Playwright keeps certificate validation enabled.
Run the separate Stage 2 UI smoke with the same Docker mounts/network/environment,
adding `sh scripts/browser-smoke.sh scripts/auth-browser-smoke.mjs` after the image
name. It uses the actual Login and Sign out controls, checks reload/redirects and
server revocation, and uses browser request interception to simulate failed/ambiguous
logout, unavailable profile, network loss, and forbidden connection responses.
It also compares button geometry across idle, submitting, rejection, repeated attempts,
required validation, and correction at desktop/mobile widths and 200% text. Layout-only
responses are intercepted; the authentication lifecycle still uses the real API.
The form derives loading from Signal Forms `submitting()` and retains session-level
pending/retry protection. One polite feedback region below the button and modest
field-message space keep ordinary transitions stable; long messages expand naturally.
It also verifies pending/duplicate protection, keyboard/focus, mobile touch,
320-pixel reflow with 200% root text, and reduced motion. Request/cookie values are
never logged. Tests require exclusive use of this disposable account and remove no
accounts automatically; the fixture owner must revoke sessions/remove it afterward.

Screenshots are saved under ignored `frontend/test-results/`. The test creates a
one-day leaf certificate using the local CA in its temporary profile to serve
localhost and IP-based foreign Origins on port 4443 inside the container. This
fixture requires the ignored local CA private key; it never changes the frontend
server certificate or host trust store. It also uses a sandboxed opaque-Origin frame.
Browser testing is essential; a Node client supplying Origin cannot prove browser
polling compatibility.

Manual reproduction: open the trusted HTTPS shell; use browser developer tools to
POST the pre-provisioned credentials to `/auth/login`, then GET `/auth/profile`.
Observe the secure cookie in browser storage and its absence from `document.cookie`.
Run the automated Socket.IO probe above; Network shows authenticated same-origin
GETs with Cookie, Referer, same-origin/cors/empty Fetch Metadata and no Origin,
followed by 200 responses. Polling POST supplies Origin; upgrade reaches WebSocket.
Do not attempt a frontend header workaround.

Stage 1 implementation is confined to foundations/tooling. Stage 2 remains unstarted.

## Initial Stage 1 execution record (2026-11-10)

Historical result before remediation: polling was blocked. The remediation below
supersedes that connectivity verdict; the original evidence is retained.

Verification used project `trivia-fe-stage1`, the root Compose file, this development
overlay, and an outside-repository test override replacing the PostgreSQL data volume
with tmpfs and removing database/backend host port publication. Existing persistent
databases were not used. A random account was provisioned through the existing
internal backend function; credentials remained in a private `/tmp` file.

- Clean `npm ci` passed in the frontend image and named dependency volume.
- `docker run --rm trivia-frontend-build:stage1 npm run check` passed strict
  compilation, two Angular shell/router tests, three proxy regressions, ESLint,
  Prettier, and the production build. The build was about 208 kB before compression.
- Both `build` and `browser` Docker targets built successfully. Frontend, backend,
  and PostgreSQL health checks passed.
- Shutdown verification ended frontend, backend, and PostgreSQL with exit code 0.
  Disposable verification containers/networks were removed; existing project services
  and persistent databases were untouched.
- Backend regressions ran in Docker with a separate disposable `trivia_test` database:
  `node --import tsx --test tests/authentication.test.ts tests/sessions.test.ts tests/history.test.ts tests/lobby.test.ts tests/server.test.ts tests/lifecycle.test.ts`.
  Result: **95 passed, zero failed/skipped**. This is not a rerun of the accepted 236-test baseline.
- The real-browser command above passed the independent checks listed earlier,
  but exited **1** for polling and upgrade. Redacted Chromium requests showed
  `originPresent: false`, `refererPresent: true`, and `cookiePresent: true`.
- An untrusted Docker peer supplying approved Origin and forged forwarded HTTPS
  still received 403 from the backend. No backend security rules changed.
- Unified Codebase Memory remains `Trivia`. New frontend source is eligible but
  untracked/not yet represented in the current graph; source was inspected directly.
  Dependencies, build/cache output, certificates/secrets, and screenshots are excluded.

## Remediation verification

Owner-approved orchestration is now root `compose.backend.yml` (standalone backend)
and `compose.frontend.yml` (frontend overlay). The resolved backend-only and combined
configurations were compared before/after renaming and were identical. No service,
port, address, mount, dependency volume, or PostgreSQL infrastructure changed.
Use explicit `-f` flags; neither filename is Compose's implicit default.

Chromium confirms the distinction between browser context and identity:

| Request                                           | Browser evidence                                                                      | Result    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- | --------- |
| Authenticated same-origin polling GET             | Origin absent; site same-origin, mode cors, destination empty; Cookie/Referer present | 200       |
| Authenticated polling POST                        | Approved Origin present                                                               | 200       |
| Polling-to-WebSocket upgrade and direct WebSocket | Approved WebSocket Origin                                                             | Connected |
| Anonymous polling / missing Referer               | Incomplete authentication or context                                                  | Rejected  |
| Opaque sandbox Origin                             | Origin null; site cross-site                                                          | Rejected  |
| Foreign localhost port                            | Disallowed Origin; site same-site                                                     | Rejected  |
| Foreign IP Origin                                 | Disallowed Origin; site cross-site                                                    | Rejected  |

The backend transport check runs before Socket.IO authentication. Its GET-only
compatibility path additionally resolves the cookie session on every eligible GET.
Referer alone, Fetch Metadata alone, or arbitrary forwarded headers grant nothing.
A non-browser client can forge browser context, just as it can already send an
allowlisted Origin, but still requires a valid session and an actual trusted HTTPS
forwarding path. HTTP auth/History route policies and WebSocket Origin enforcement
are unchanged.

Docker verification includes clean frontend `npm ci`, strict compilation, two
Angular shell/router tests, three proxy regressions, lint, formatting, build, and
Chromium smoke. Backend full suite with disposable PostgreSQL: **262 passed,
0 failed, 0 skipped**; changed backend files also passed typecheck, scoped ESLint,
format verification and build. No persistent database was used. A separate real
HTTPS two-player ten-question/ten-REVEAL-to-History smoke verifies the accepted
backend path; it does not implement gameplay UI.

Final frontend, backend and PostgreSQL health checks passed; all three containers
shut down with exit code 0. Disposable containers/networks and smoke credentials
were removed without modifying existing persistent volumes or unrelated services.

Stage 1 acceptance was complete before Stage 2. The original ten Moderate tooling advisories remain unchanged. The
same-origin compatibility path intentionally fails closed for browsers/referrer
policies omitting its required context; no fallback security bypass is provided.

## Stage 2 verification (initial implementation)

Executed in Docker with Node 26.13.0/npm 11.20.0, using both root Compose files:

- Clean `npm ci` passed. `npm run check` passed strict/template compilation,
  **36 Angular tests and 3 proxy tests, zero failures/skips**, ESLint, Prettier,
  and production build (about 327 kB raw / 87 kB estimated transfer).
- `scripts/auth-browser-smoke.mjs` passed in real Chromium with trusted local TLS:
  anonymous entry; usable form and exact credentials; pending/duplicate prevention;
  invalid credentials; Secure/HttpOnly cookie; restored profile on reload; protected
  and Login redirects; real logout and rejection of the revoked cookie; truthful
  failed/unknown logout and explicit recovery; simulated network/503/403 failures.
- `scripts/browser-smoke.mjs` passed authenticated polling GET/POST, polling-to-WebSocket
  upgrade, direct WebSocket, logout disconnect, and anonymous/null/disallowed same-site/
  cross-site Origin rejection. No Match commands or subscriptions were created.
- Focus/tab order, keyboard submission, touch activation, 320/375/768-pixel layouts,
  200% text at 320 pixels, and reduced motion were checked in Chromium; desktop/mobile
  screenshots were inspected. Semantic accessibility snapshots were checked. A human
  screen-reader speech review remains outstanding; no full WCAG compliance is claimed.
- The initially running backend image predated the accepted History integration;
  it was rebuilt from unchanged accepted source. Its existing development database
  contained migration 001 only. Verification therefore used a separate temporary
  database with existing migrations 001–003, without migrating the original database.
  Focused backend `authentication.test.ts`, `sessions.test.ts`, and
  `socket-origin.test.ts` regressions passed **49 / 49, zero skipped**. No full backend
  suite rerun is claimed. Backend/proxy/Compose source and security policy are unchanged.

Stage 2.5 preparation subsequently backed up the Compose-owned development database,
verified no canonical conflicts/invalid usernames, and applied accepted migrations
002–003. The ledger is now 001–003 and the existing Player count was preserved. No
registration migration or persistent-volume reset was needed. Disposable test accounts/database/credential
files are removed after verification, and the original runtime database connection
is restored. No Match, lobby, gameplay, or History UI has been added.
