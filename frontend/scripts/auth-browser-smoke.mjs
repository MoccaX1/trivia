import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const origin = 'https://localhost:4200';
const credentials = JSON.parse(await readFile(process.env['SMOKE_CREDENTIALS'], 'utf8'));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext(); // Real local-CA validation, no TLS bypass.
const page = await context.newPage();
const errors = [];
const traffic = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  if (new URL(response.url()).pathname.startsWith('/auth/')) {
    traffic.push({
      path: new URL(response.url()).pathname,
      method: response.request().method(),
      status: response.status(),
    });
  }
});
const username = page.getByRole('textbox', { name: 'Username', exact: true });
const password = page.getByLabel('Password', { exact: true });
const signIn = page.getByRole('button', { name: 'Sign in', exact: true });
const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
const checkAgain = page.getByRole('button', { name: 'Check session again', exact: true });
async function login() {
  await username.fill(credentials.username.toUpperCase());
  await password.fill(credentials.password);
  await signIn.click();
  await expect(page).toHaveURL(origin + '/play');
  await expect(page.getByRole('heading', { name: 'Welcome, Curious Player 👩‍💻.' })).toBeVisible();
}
async function assertReflow(width, height, scale = '100%') {
  await page.setViewportSize({ width, height });
  await page.evaluate((scale) => {
    document.documentElement.style.fontSize = scale;
  }, scale);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    `Reflow at ${width}px / ${scale}`,
  );
}
// Compare document geometry across transitions, independent of viewport scrolling.
// These layout-only responses are controlled; the lifecycle below uses the real API.
async function verifyLoginLayout(width) {
  const layoutContext = await browser.newContext({ viewport: { width, height: 900 } });
  try {
    const target = await layoutContext.newPage();
    await target.goto(origin + '/login');
    const button = target.locator('button[type=submit]');
    await expect(button).toBeVisible();
    await target.getByLabel('Username', { exact: true }).fill('layout_probe');
    await target.getByLabel('Password', { exact: true }).fill('not-a-real-account');
    const geometry = () =>
      button.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x + window.scrollX,
          y: rect.y + window.scrollY,
          width: rect.width,
          height: rect.height,
        };
      });
    const initial = await geometry();
    const positions = { idle: initial };
    const record = async (state) => {
      const position = await geometry();
      for (const key of ['x', 'y', 'width', 'height']) {
        assert.ok(
          Math.abs(position[key] - initial[key]) <= 1,
          `${width}px ${state}: button ${key} moved`,
        );
      }
      positions[state] = position;
      await target.screenshot({
        path: `test-results/login-stable-${width}-${state}.png`,
        fullPage: true,
      });
    };
    await record('idle');
    await target.getByLabel('Username', { exact: true }).focus();
    await record('focused');
    let release;
    await target.route('**/auth/login', async (route) => {
      await new Promise((resolve) => {
        release = resolve;
      });
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: '{"code":"INVALID_CREDENTIALS"}',
      });
    });
    for (const attempt of [1, 2]) {
      await button.click();
      await expect(button).toHaveText('Signing in…');
      await expect(button).toBeDisabled();
      await record(`pending-${attempt}`);
      release();
      await expect(target.locator('form .feedback')).toContainText('incorrect');
      await record(`error-${attempt}`);
    }
    // Ordinary field messages also fit the reserved line without moving the button.
    await target.getByLabel('Username', { exact: true }).fill('');
    await target.getByLabel('Password', { exact: true }).fill('');
    await button.click();
    await expect(target.locator('#username-error')).toContainText('Enter your username');
    await record('required');
    await target.getByLabel('Username', { exact: true }).fill('layout_probe');
    await target.getByLabel('Password', { exact: true }).fill('not-a-real-account');
    await record('corrected');
    await target.getByLabel('Username', { exact: true }).fill('invalid username');
    await button.click();
    await expect(target.locator('#username-error')).toContainText('no spaces');
    await record('format-error');
    await target.getByLabel('Username', { exact: true }).fill('layout_probe');
    await record('recovered');
    // Text enlargement must reflow; unusually long errors are allowed to grow.
    await target.setViewportSize({ width: 320, height: 740 });
    await target.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    assert.equal(
      await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.equal(
      await target
        .locator('.feedback')
        .evaluate((element) => element.scrollHeight <= element.clientHeight),
      true,
    );
    await target.screenshot({
      path: `test-results/login-stable-${width}-text-200.png`,
      fullPage: true,
    });
    const zoomedInitial = await geometry();
    await button.click();
    await expect(button).toHaveText('Signing in…');
    const zoomedPending = await geometry();
    release();
    await expect(target.locator('form .feedback')).toContainText('incorrect');
    const zoomedError = await geometry();
    for (const position of [zoomedPending, zoomedError]) {
      for (const key of ['x', 'y', 'width', 'height']) {
        assert.ok(
          Math.abs(position[key] - zoomedInitial[key]) <= 1,
          `200% text: button ${key} moved`,
        );
      }
    }
    assert.equal(
      await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    console.log(`Login geometry ${width}px:`, JSON.stringify(positions));
  } finally {
    await layoutContext.close();
  }
}

try {
  await mkdir('test-results', { recursive: true });
  await verifyLoginLayout(1280);
  await verifyLoginLayout(768);
  await verifyLoginLayout(375);
  await verifyLoginLayout(320);
  await page.goto(origin);
  await expect(page).toHaveURL(/\/login/);
  await expect(signIn).toBeVisible();
  assert.equal(traffic.filter((request) => request.path === '/auth/profile').length, 1);
  assert.equal(traffic[0].status, 401);
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toHaveText('Skip to content');
  await page.keyboard.press('Enter');
  await expect(page.locator(':focus')).toHaveAttribute('id', 'main-content');
  await signIn.click();
  await expect(page.locator('#username-error')).toContainText('Enter your username');
  await expect(page.locator('#password-error')).toContainText('Enter your password');
  assert.equal(
    traffic.some((request) => request.path === '/auth/login'),
    false,
  );
  await username.fill(credentials.username.toUpperCase());
  await password.fill('incorrect disposable password');
  await signIn.click();
  await expect(page.locator('form .feedback')).toContainText('username or password is incorrect');
  await expect(username).toHaveValue(credentials.username.toUpperCase());
  await expect(password).toHaveValue('incorrect disposable password');

  // Pause a real login before forwarding to verify visible pending/duplicate protection.
  let release;
  let dispatched = 0;
  const pauseLogin = async (route) => {
    dispatched++;
    await new Promise((resolve) => {
      release = resolve;
    });
    await route.continue();
  };
  await page.route('**/auth/login', pauseLogin);
  await password.fill(credentials.password);
  await signIn.click();
  await expect(page.getByRole('button', { name: 'Signing in…', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('Checking your credentials…');
  await page.keyboard.press('Enter');
  assert.equal(dispatched, 1);
  release();
  await expect(page).toHaveURL(origin + '/play');
  await page.unroute('**/auth/login', pauseLogin);
  const cookie = (await context.cookies(origin)).find(
    (value) => value.name === '__Host-trivia_session',
  );
  assert.ok(cookie);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'Lax');
  assert.equal(cookie.path, '/');
  assert.equal(await page.evaluate(() => document.cookie.includes('trivia_session')), false);
  assert.equal(
    await page.evaluate(() => window.localStorage.length + window.sessionStorage.length),
    0,
  );
  const loginRequest = traffic.findLast((request) => request.path === '/auth/login');
  assert.equal(loginRequest.status, 200);
  await expect(page.locator(':focus')).toHaveAttribute('id', 'main-content');
  await page.reload();
  await expect(signOut).toBeVisible();
  assert.equal(traffic.findLast((request) => request.path === '/auth/profile').status, 200);
  await page.goto(origin + '/login');
  await expect(page).toHaveURL(origin + '/play');
  await expect(page.getByRole('heading', { name: 'Welcome, Curious Player 👩‍💻.' })).toBeVisible();

  // A failed logout is not server revocation, and private content must disappear.
  const failLogout = (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"code":"AUTH_UNAVAILABLE"}',
    });
  await page.route('**/auth/logout', failLogout);
  await signOut.click();
  await expect(checkAgain).toBeVisible();
  await expect(page.locator('.feedback')).toContainText('Sign-out was not confirmed');
  await expect(page.getByText('Welcome, Curious Player 👩‍💻.')).toHaveCount(0);
  await page.unroute('**/auth/logout', failLogout);
  await checkAgain.click();
  await expect(page).toHaveURL(origin + '/play');
  await expect(page.locator('.feedback')).toContainText('session is still active');
  // Unknown outcome from a dropped response offers an explicit retry, never an automatic resend.
  let logoutAttempts = 0;
  const dropLogout = (route) => {
    logoutAttempts++;
    return route.abort('failed');
  };
  await page.route('**/auth/logout', dropLogout);
  await signOut.click();
  await expect(checkAgain).toBeVisible();
  await expect(page.locator('.feedback')).toContainText('Sign-out was not confirmed');
  assert.equal(logoutAttempts, 1);
  await page.unroute('**/auth/logout', dropLogout);
  const revokedCookie = (await context.cookies(origin)).find(
    (value) => value.name === '__Host-trivia_session',
  );
  await page.getByRole('button', { name: 'Retry sign out', exact: true }).click();
  await expect(signIn).toBeVisible();
  assert.equal(traffic.findLast((request) => request.path === '/auth/logout').status, 204);
  assert.equal(
    (await context.cookies(origin)).some((value) => value.name === '__Host-trivia_session'),
    false,
  );
  const revoked = await context.request.get(origin + '/auth/profile', {
    headers: { Cookie: `${revokedCookie.name}=${revokedCookie.value}` },
  });
  assert.equal(revoked.status(), 401);
  await page.goto(origin + '/play');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText('Welcome, Curious Player 👩‍💻.')).toHaveCount(0);
  await login();

  // Browser response interception simulates outages; the real backend remains unchanged.
  const unavailable = (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      headers: { 'Retry-After': '1' },
      body: '{"code":"AUTH_UNAVAILABLE"}',
    });
  await page.route('**/auth/profile', unavailable);
  await page.reload();
  await expect(checkAgain).toBeDisabled();
  await expect(page.locator('.feedback')).toContainText('temporarily unavailable');
  await expect(signIn).toHaveCount(0);
  await page.unroute('**/auth/profile', unavailable);
  await expect(checkAgain).toBeEnabled();
  await checkAgain.click();
  await expect(signOut).toBeVisible();
  const offline = (route) => route.abort('failed');
  await page.route('**/auth/profile', offline);
  await page.reload();
  await expect(checkAgain).toBeVisible();
  await expect(page.locator('.feedback')).toContainText('could not reach');
  await expect(signIn).toHaveCount(0);
  await page.unroute('**/auth/profile', offline);
  await checkAgain.click();
  await expect(signOut).toBeVisible();
  const forbidden = (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: '{"code":"ORIGIN_FORBIDDEN"}',
    });
  await page.route('**/auth/profile', forbidden);
  await page.reload();
  await expect(page.locator('.feedback')).toContainText('HTTPS address');
  await expect(signIn).toHaveCount(0);
  await page.unroute('**/auth/profile', forbidden);
  await checkAgain.click();
  await expect(signOut).toBeVisible();

  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/auth-play-desktop.png', fullPage: true });
  await assertReflow(320, 740, '200%');
  await page.screenshot({ path: 'test-results/auth-play-text-200.png', fullPage: true });
  await assertReflow(1280, 900);
  await signOut.click();
  await expect(signIn).toBeVisible();
  await page.screenshot({ path: 'test-results/auth-login-desktop.png', fullPage: true });
  for (const [width, height] of [
    [320, 740],
    [375, 812],
    [768, 1024],
  ])
    await assertReflow(width, height);
  await assertReflow(320, 740, '200%');
  await page.screenshot({ path: 'test-results/auth-login-text-200.png', fullPage: true });
  await assertReflow(375, 812);
  await page.screenshot({ path: 'test-results/auth-login-mobile.png', fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--motion-feedback').trim(),
    ),
    '0ms',
  );
  for (const control of [username, password, signIn]) {
    assert.ok((await control.boundingBox()).height >= 44);
  }
  // Real keyboard order and visible focus; Enter submits, focus alone does not.
  await page.reload();
  await expect(signIn).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toHaveText('Skip to content');
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', 'Trivia home');
  await page.keyboard.press('Tab');
  await expect(username).toBeFocused();
  assert.ok(
    await username.evaluate(
      (input) => Number.parseFloat(getComputedStyle(input).outlineWidth) >= 2,
    ),
  );
  await page.keyboard.type(credentials.username);
  await page.keyboard.press('Tab');
  await expect(password).toBeFocused();
  await page.keyboard.type(credentials.password);
  await page.keyboard.press('Enter');
  await expect(signOut).toBeVisible();
  await expect(page.locator(':focus')).toHaveAttribute('id', 'main-content');
  const snapshot = await page.locator('main').ariaSnapshot();
  assert.ok(snapshot.includes('heading "Welcome, Curious Player'));
  assert.ok(snapshot.includes('button "Sign out"'));
  await signOut.click();
  await expect(signIn).toBeVisible();

  const touch = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const mobile = await touch.newPage();
    await mobile.goto(origin);
    await mobile.getByLabel('Username', { exact: true }).fill(credentials.username);
    await mobile.getByLabel('Password', { exact: true }).fill(credentials.password);
    await mobile.getByRole('button', { name: 'Sign in', exact: true }).tap();
    await expect(mobile).toHaveURL(origin + '/play');
    await mobile.getByRole('button', { name: 'Sign out', exact: true }).tap();
    await expect(mobile.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  } finally {
    await touch.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Chromium auth UI, trusted HTTPS, initial anonymous check, exact credentials, pending/dedup, invalid credentials, Secure/HttpOnly cookies, profile restoration, guarded redirects, logout/revocation, failed/unknown logout, explicit recovery, unavailable/network/Origin feedback, keyboard/focus, mobile touch, 320px/200% text reflow, reduced motion.',
  );
  console.log('Auth HTTP status evidence (no credentials/cookies):', JSON.stringify(traffic));
} finally {
  await browser.close();
}
