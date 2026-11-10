import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { request as httpRequest } from 'node:http';
import { createServer } from '../src/transport/server.js';
import { readAuthPolicy } from '../src/transport/auth-policy.js';
import { MemorySessionStore, idleMs } from '../src/application/sessions.js';
import { fixturePlayer, testAuth } from './support/auth.js';

const publicOrigin = 'https://app.example.test';
const pollingPath = '/socket.io/?EIO=4&transport=polling';

// Use real HTTP rather than fetch: fetch normalizes Host/Fetch Metadata and
// forbids Upgrade, which would invalidate the adversarial header matrix.
function request(
  url: string,
  options: {
    headers: Record<string, string>;
    method?: string;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<{ status: number; text(): Promise<string> }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(url, options, (response) => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode!, text: async () => body }));
      response.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.on('upgrade', (_response, socket) => {
      socket.destroy();
      reject(new Error('Unexpected upgrade accepted'));
    });
    outgoing.end(options.body);
  });
}

async function fixture(t: TestContext, trustedPeer = '127.0.0.1') {
  const auth = testAuth();
  await auth.sessions.close();
  let now = 0;
  auth.sessions = new MemorySessionStore({ now: () => now }, { schedule: () => () => {} });
  auth.policy = readAuthPolicy({
    AUTH_COOKIE_MODE: 'secure',
    AUTH_PUBLIC_ORIGIN: publicOrigin,
    AUTH_ORIGINS: publicOrigin,
    AUTH_TRUST_PROXY: trustedPeer,
  });
  const server = createServer({ auth });
  t.after(() => server.close());
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  const token = await auth.sessions.create(fixturePlayer);
  const headers = {
    host: 'app.example.test',
    'x-forwarded-proto': 'https',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    referer: publicOrigin + '/play',
    cookie: `__Host-trivia_session=${token}`,
  };
  return {
    auth,
    token,
    headers,
    address,
    advance: (value: number) => {
      now = value;
    },
  };
}

test('trusted HTTPS same-origin polling GET authenticates; normal Origin POST completes Socket.IO connection', async (t) => {
  const f = await fixture(t);
  const opened = await request(f.address + pollingPath, { headers: f.headers });
  assert.equal(opened.status, 200);
  const packet = await opened.text();
  assert.equal(packet[0], '0');
  const { sid } = JSON.parse(packet.slice(1)) as { sid: string };
  const post = await request(f.address + pollingPath + '&sid=' + sid, {
    method: 'POST',
    headers: { ...f.headers, origin: publicOrigin, 'content-type': 'text/plain;charset=UTF-8' },
    body: '40',
  });
  assert.equal(post.status, 200);
  const connected = await request(f.address + pollingPath + '&sid=' + sid, { headers: f.headers });
  assert.equal(connected.status, 200);
  assert.match(await connected.text(), /^40\{/);
  // Non-refreshing GETs must not keep a passive connection alive.
  f.advance(idleMs);
  assert.equal(
    (await request(f.address + pollingPath + '&sid=' + sid, { headers: f.headers })).status,
    400,
  );
});

const rejectedHeaders: Array<[string, Record<string, string | undefined>]> = [
  ['missing site', { 'sec-fetch-site': undefined }],
  ['missing mode', { 'sec-fetch-mode': undefined }],
  ['missing destination', { 'sec-fetch-dest': undefined }],
  ['cross-site', { 'sec-fetch-site': 'cross-site' }],
  ['same-site cross-origin', { 'sec-fetch-site': 'same-site' }],
  ['user navigation', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' }],
  ['no-cors', { 'sec-fetch-mode': 'no-cors' }],
  ['image request', { 'sec-fetch-dest': 'image' }],
  ['missing Referer', { referer: undefined }],
  ['foreign Referer despite same-origin metadata', { referer: 'https://evil.example.test/' }],
  ['HTTP Referer', { referer: 'http://app.example.test/' }],
  ['credentialed Referer', { referer: 'https://user@app.example.test/' }],
  ['wrong public Host', { host: 'evil.example.test' }],
  ['missing forwarded TLS', { 'x-forwarded-proto': undefined }],
  ['insecure forwarded TLS', { 'x-forwarded-proto': 'http' }],
  ['null Origin cannot fall back', { origin: 'null' }],
  ['disallowed Origin cannot fall back', { origin: 'https://evil.example.test' }],
  ['empty Origin cannot fall back', { origin: '' }],
  ['missing cookie', { cookie: undefined }],
  ['malformed cookie', { cookie: '__Host-trivia_session=invalid' }],
  ['forged token', { cookie: '__Host-trivia_session=' + 'A'.repeat(43) }],
  ['WebSocket-like upgrade without Origin', { upgrade: 'websocket' }],
];
for (const [name, patch] of rejectedHeaders) {
  test(`Origin-less polling rejects ${name} over a real listener`, async (t) => {
    const f = await fixture(t);
    const headers: Record<string, string> = { ...f.headers };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete headers[key];
      else headers[key] = value;
    }
    const response = await request(f.address + pollingPath, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /__Host-trivia_session|password|stack/);
  });
}

test('untrusted peer cannot forge TLS, Fetch Metadata, Referer or forwarding identity', async (t) => {
  const f = await fixture(t, '192.0.2.10');
  const response = await request(f.address + pollingPath, {
    headers: {
      ...f.headers,
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-host': 'app.example.test',
    },
  });
  assert.equal(response.status, 400);
});

test('revoked and expired sessions fail the metadata exception, even with complete browser context', async (t) => {
  const f = await fixture(t);
  await f.auth.sessions.revoke(f.token);
  assert.equal((await request(f.address + pollingPath, { headers: f.headers })).status, 400);
  const token = await f.auth.sessions.create(fixturePlayer);
  f.advance(idleMs);
  assert.equal(
    (
      await request(f.address + pollingPath, {
        headers: { ...f.headers, cookie: `__Host-trivia_session=${token}` },
      })
    ).status,
    400,
  );
});

test('the exception excludes POST, WebSocket, wrong paths/protocols and duplicate selectors', async (t) => {
  const f = await fixture(t);
  for (const suffix of ['&transport=websocket', '&transport=polling', '&EIO=4']) {
    assert.equal(
      (await request(f.address + pollingPath + suffix, { headers: f.headers })).status,
      400,
    );
  }
  assert.equal(
    (await request(f.address + '/socket.io/?EIO=4&transport=websocket', { headers: f.headers }))
      .status,
    400,
  );
  assert.equal(
    (await request(f.address + '/socket.io/?EIO=3&transport=polling', { headers: f.headers }))
      .status,
    400,
  );
  assert.equal(
    (
      await request(f.address + '/auth/logout', {
        method: 'POST',
        headers: { ...f.headers, 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  const opened = await request(f.address + pollingPath, { headers: f.headers });
  assert.equal(opened.status, 200);
  const { sid } = JSON.parse((await opened.text()).slice(1)) as { sid: string };
  assert.equal(
    (
      await request(f.address + pollingPath + '&sid=' + sid, {
        method: 'POST',
        headers: { ...f.headers, 'content-type': 'text/plain' },
        body: '40',
      })
    ).status,
    400,
  );
  assert.equal((await request(f.address + '/auth/profile', { headers: f.headers })).status, 200);
});
