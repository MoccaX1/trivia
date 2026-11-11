import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:https';
import { chromium } from '@playwright/test';

// Transport smoke only: no Match commands or application authentication UI/state.
const origin = 'https://localhost:4200';
const credentials = JSON.parse(await readFile(process.env['SMOKE_CREDENTIALS'], 'utf8'));
const socketBundle = await readFile('node_modules/socket.io-client/dist/socket.io.min.js', 'utf8');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext(); // Certificate verification stays enabled.
const page = await context.newPage();
const errors = [];
const integrationFailures = [];
const pollingHeaders = [];
const websocketHeaders = [];
const pollingResponses = [];
async function observe(target) {
  const cdp = await context.newCDPSession(target);
  await cdp.send('Network.enable');
  const requests = new Map();
  const pending = new Map();
  function record(id, values) {
    const request = requests.get(id);
    if (!request) {
      pending.set(id, values);
      return;
    }
    if (!request.url.includes('transport=polling') || pollingHeaders.length >= 30) return;
    const headers = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
    );
    pollingHeaders.push({
      method: request.method,
      origin: headers['origin'] ?? null,
      originPresent: 'origin' in headers,
      refererPresent: 'referer' in headers,
      cookiePresent: 'cookie' in headers,
      site: headers['sec-fetch-site'] ?? null,
      mode: headers['sec-fetch-mode'] ?? null,
      dest: headers['sec-fetch-dest'] ?? null,
    });
  }
  cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
    requests.set(requestId, request);
    if (pending.has(requestId)) {
      record(requestId, pending.get(requestId));
      pending.delete(requestId);
    }
  });
  cdp.on('Network.requestWillBeSentExtraInfo', ({ requestId, headers }) =>
    record(requestId, headers),
  );
  cdp.on('Network.webSocketWillSendHandshakeRequest', ({ request }) => {
    const h = Object.fromEntries(
      Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    websocketHeaders.push({
      origin: h['origin'] ?? null,
      site: h['sec-fetch-site'] ?? null,
      mode: h['sec-fetch-mode'] ?? null,
      cookiePresent: 'cookie' in h,
    });
  });
  target.on('response', (response) => {
    if (response.url().includes('transport=polling'))
      pollingResponses.push({ method: response.request().method(), status: response.status() });
  });
}
await observe(page);
page.on('pageerror', (error) => errors.push(error.message));
const foreign = createServer(
  {
    key: await readFile(process.env['SMOKE_FOREIGN_KEY']),
    cert: await readFile(process.env['SMOKE_FOREIGN_CERT']),
  },
  (_request, response) => response.end('<!doctype html><title>Origin enforcement probe</title>'),
);

try {
  await page.goto(origin);
  await page.getByRole('heading', { level: 1 }).waitFor();
  assert.equal(await page.title(), 'Sign in — Trivia');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').textContent(), 'Skip to content');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator(':focus').getAttribute('id'), 'main-content');
  await page.locator('h1').click();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/foundation-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/foundation-mobile.png', fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--motion-feedback').trim(),
    ),
    '0ms',
  );
  await page.goto(origin + '/foundation-route-probe');
  await page.getByRole('heading', { level: 1 }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/foundation-route-probe');
  assert.equal(await page.locator('h1').textContent(), 'Page not found');
  await page.goto(origin + '/login');
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();

  const request = (path, init) =>
    page.evaluate(
      async ({ path, init }) => {
        const response = await fetch(path, { credentials: 'include', ...init });
        return { status: response.status, text: await response.text() };
      },
      { path, init },
    );
  assert.equal((await request('/auth/profile')).status, 401);
  assert.equal((await request('/history')).status, 401);
  const malformed = await request('/history/%ZZ');
  assert.equal(malformed.status, 400);
  assert.deepEqual(JSON.parse(malformed.text), { code: 'INVALID_REQUEST' });
  await page.addScriptTag({ content: socketBundle });

  async function connectProbe(target, options = {}) {
    return target.evaluate(
      ({ origin, options }) =>
        new Promise((resolve) => {
          const socket = window.io(origin, {
            withCredentials: true,
            reconnection: false,
            timeout: 5000,
            ...options,
          });
          let firstTransport;
          let snapshots = 0;
          socket.on('LobbySnapshot', () => snapshots++);
          socket.on('MatchSnapshot', () => snapshots++);
          socket.io.on('open', () => {
            firstTransport = socket.io.engine.transport.name;
          });
          const timer = setTimeout(() => {
            socket.disconnect();
            resolve({ status: 'timeout' });
          }, 8000);
          socket.on('connect_error', () => {
            clearTimeout(timer);
            socket.disconnect();
            resolve({ status: 'denied' });
          });
          socket.on('connect', () => {
            const finish = () => {
              clearTimeout(timer);
              const result = {
                status: 'connected',
                firstTransport,
                finalTransport: socket.io.engine.transport.name,
                snapshots,
              };
              window.smokeSocket = socket;
              resolve(result);
            };
            if (options.transports?.length === 1 || socket.io.engine.transport.name === 'websocket')
              finish();
            else socket.io.engine.once('upgrade', finish);
          });
        }),
      { origin, options },
    );
  }
  assert.equal((await connectProbe(page, { transports: ['polling'] })).status, 'denied');
  assert.equal((await connectProbe(page, { transports: ['websocket'] })).status, 'denied');
  const login = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  assert.equal(login.status, 200);
  const session = (await context.cookies(origin)).find(
    (cookie) => cookie.name === '__Host-trivia_session',
  );
  assert.ok(
    session?.secure && session.httpOnly && session.sameSite === 'Lax' && session.path === '/',
  );
  assert.equal(await page.evaluate(() => document.cookie.includes('trivia_session')), false);
  assert.equal((await request('/auth/profile')).status, 200);
  assert.equal((await request('/history')).status, 200);
  const polling = await connectProbe(page, { transports: ['polling'] });
  if (polling.status !== 'connected')
    integrationFailures.push('Same-origin browser polling rejected');
  else {
    assert.equal(polling.finalTransport, 'polling');
    assert.equal(polling.snapshots, 0);
    await page.evaluate(() => window.smokeSocket.disconnect());
  }
  const upgraded = await connectProbe(page, { transports: ['polling', 'websocket'] });
  if (upgraded.status !== 'connected')
    integrationFailures.push('Polling-to-WebSocket upgrade unavailable');
  else {
    assert.equal(upgraded.firstTransport, 'polling');
    assert.equal(upgraded.finalTransport, 'websocket');
    assert.equal(upgraded.snapshots, 0);
    await page.evaluate(() => window.smokeSocket.disconnect());
  }
  const websocket = await connectProbe(page, { transports: ['websocket'] });
  assert.equal(websocket.status, 'connected');
  assert.equal(websocket.snapshots, 0);
  const noReferer = await request('/socket.io/?EIO=4&transport=polling', {
    referrerPolicy: 'no-referrer',
  });
  assert.equal(noReferer.status, 400);
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'opaque-origin-probe';
    frame.sandbox = 'allow-scripts';
    frame.srcdoc = '<!doctype html><title>Opaque Origin probe</title>';
    document.body.append(frame);
  });
  const opaque = await page.locator('#opaque-origin-probe').elementHandle();
  const opaqueFrame = await opaque.contentFrame();
  await opaqueFrame.addScriptTag({ content: socketBundle });
  assert.equal((await connectProbe(opaqueFrame, { transports: ['polling'] })).status, 'denied');
  assert.equal((await connectProbe(opaqueFrame, { transports: ['websocket'] })).status, 'denied');
  assert.equal(
    await page.evaluate(async () => {
      const disconnected = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000);
        window.smokeSocket.once('disconnect', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      const response = await fetch('/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      return response.status === 204 && (await disconnected);
    }),
    true,
  );
  assert.equal((await request('/auth/profile')).status, 401);
  assert.equal(
    (await context.cookies(origin)).some((cookie) => cookie.name === '__Host-trivia_session'),
    false,
  );

  await new Promise((resolve) => foreign.listen(4443, '127.0.0.1', resolve));
  const disallowed = await context.newPage();
  await observe(disallowed);
  await disallowed.goto('https://localhost:4443');
  const readable = await disallowed.evaluate(async (origin) => {
    try {
      await fetch(origin + '/auth/profile', { credentials: 'include' });
      return true;
    } catch {
      return false;
    }
  }, origin);
  assert.equal(readable, false);
  // CORS intentionally hides the response from page JS; inspect status separately.
  const deniedStatus = await fetch(origin + '/auth/profile', {
    headers: { Origin: 'https://localhost:4443' },
  });
  assert.equal(deniedStatus.status, 403);
  await disallowed.addScriptTag({ content: socketBundle });
  assert.equal((await connectProbe(disallowed, { transports: ['polling'] })).status, 'denied');
  assert.equal((await connectProbe(disallowed, { transports: ['websocket'] })).status, 'denied');
  const crossSite = await context.newPage();
  await observe(crossSite);
  await crossSite.goto('https://127.0.0.1:4443');
  await crossSite.addScriptTag({ content: socketBundle });
  assert.equal((await connectProbe(crossSite, { transports: ['polling'] })).status, 'denied');
  assert.equal((await connectProbe(crossSite, { transports: ['websocket'] })).status, 'denied');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: trusted Chromium TLS; responsive shell/routing/focus/reduced motion; HTTP errors; browser-managed session; polling GET/POST; polling-to-WebSocket upgrade; direct WebSocket; logout disconnect; anonymous/null/disallowed/cross-site Origins; no Match commands or subscriptions.',
  );
  console.log('Browser polling evidence:', JSON.stringify(pollingHeaders));
  console.log('Browser polling responses:', JSON.stringify(pollingResponses));
  console.log('Browser WebSocket evidence:', JSON.stringify(websocketHeaders));
  assert.ok(
    pollingHeaders.some(
      (h) =>
        h.method === 'GET' &&
        !h.originPresent &&
        h.cookiePresent &&
        h.site === 'same-origin' &&
        h.mode === 'cors' &&
        h.dest === 'empty',
    ),
  );
  assert.ok(pollingHeaders.some((h) => h.method === 'POST' && h.origin === origin));
  assert.ok(pollingHeaders.some((h) => h.origin === 'null'));
  assert.ok(pollingHeaders.some((h) => h.site === 'cross-site'));
  assert.ok(pollingResponses.some((r) => r.method === 'GET' && r.status === 200));
  assert.ok(pollingResponses.some((r) => r.method === 'POST' && r.status === 200));
  assert.deepEqual(integrationFailures, [], 'Stage 1 connectivity gate is not complete');
} finally {
  await browser.close();
  foreign.close();
}
