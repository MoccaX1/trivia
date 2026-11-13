import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const origin = 'https://localhost:4200';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext(); // Trusted local CA; no ignoreHTTPSErrors.
const page = await context.newPage();
const failures = [];
const players = JSON.parse(
  await readFile(process.env['SMOKE_PLAYERS_OUT'] ?? '/smoke/players.json', 'utf8').catch(
    () => '[]',
  ),
);
const credentials = {
  username: 'reg_' + randomBytes(10).toString('hex'),
  password: ' ' + randomBytes(24).toString('base64url') + ' 👩‍💻 ',
};
page.on('pageerror', (error) => failures.push(error.message));
const field = (target, name) => target.getByLabel(name, { exact: true });
async function fill(target, account = credentials, name = 'Curious Player 👩‍💻') {
  await field(target, 'Username').fill(account.username.toUpperCase());
  await field(target, 'Public display name').fill(name);
  await field(target, 'Password').fill(account.password);
  await field(target, 'Confirm password').fill(account.password);
}
async function signIn(account = credentials) {
  await field(page, 'Username').fill(account.username);
  await field(page, 'Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(origin + '/play');
}
async function savePlayers() {
  await writeFile(
    process.env['SMOKE_PLAYERS_OUT'] ?? '/smoke/players.json',
    JSON.stringify(players),
    { mode: 0o600 },
  );
}
async function verifyLayout(width) {
  const isolated = await browser.newContext({ viewport: { width, height: 1200 } });
  try {
    const target = await isolated.newPage();
    await target.goto(origin + '/register');
    const button = target.locator('button[type=submit]');
    await expect(button).toBeVisible();
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
      const value = await geometry();
      for (const key of ['x', 'y', 'width', 'height'])
        assert.ok(Math.abs(value[key] - initial[key]) <= 1, `${width}px ${state}: ${key} changed`);
      positions[state] = value;
      await target.screenshot({
        path: `test-results/register-${width}-${state}.png`,
        fullPage: true,
      });
    };
    await record('idle');
    await field(target, 'Username').focus();
    await record('focused');
    await button.click();
    await expect(target.locator('#register-username-error')).toContainText('Enter your username');
    await record('required');
    const mock = { username: 'layout_probe', password: 'Layout only — never a real account' };
    await fill(target, mock);
    await record('corrected');
    await field(target, 'Username').fill('invalid username');
    await button.click();
    await expect(target.locator('#register-username-error')).toContainText('no spaces');
    await record('format-error');
    await field(target, 'Username').fill(mock.username);
    await record('recovered');
    let release;
    await target.route('**/auth/register', async (route) => {
      await new Promise((resolve) => {
        release = resolve;
      });
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: '{"code":"USERNAME_TAKEN"}',
      });
    });
    for (const attempt of [1, 2]) {
      await button.click();
      await expect(button).toHaveText('Creating…');
      await record(`pending-${attempt}`);
      release();
      await expect(target.locator('form .feedback')).toContainText('not available');
      await expect(button).toBeEnabled();
      await record(`conflict-${attempt}`);
    }
    await target.setViewportSize({ width: 320, height: 740 });
    await target.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    const zoom = await geometry();
    await button.click();
    await expect(button).toHaveText('Creating…');
    const pending = await geometry();
    release();
    await expect(target.locator('form .feedback')).toContainText('not available');
    await expect(button).toBeEnabled();
    for (const value of [pending, await geometry()])
      for (const key of ['x', 'y', 'width', 'height'])
        assert.ok(Math.abs(value[key] - zoom[key]) <= 1, `200% ${key} changed`);
    assert.equal(
      await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.equal(
      await target.locator('form .feedback').evaluate((el) => el.scrollHeight <= el.clientHeight),
      true,
    );
    await target.screenshot({
      path: `test-results/register-${width}-text-200.png`,
      fullPage: true,
    });
    await target.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(
      await target.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--motion-feedback').trim(),
      ),
      '0ms',
    );
    console.log(`Register geometry ${width}px:`, JSON.stringify(positions));
  } finally {
    await isolated.close();
  }
}
try {
  await mkdir('test-results', { recursive: true });
  await verifyLayout(1280);
  await verifyLayout(768);
  await verifyLayout(375);
  await verifyLayout(320);
  await page.goto(origin + '/login');
  await page.getByRole('link', { name: 'Create an account', exact: true }).click();
  await expect(page).toHaveURL(origin + '/register');
  let posts = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/auth/register') && request.method() === 'POST') posts++;
  });
  const button = page.locator('button[type=submit]');
  await button.click();
  await expect(page.locator('#register-password-error')).toContainText('Enter your password');
  assert.equal(posts, 0);
  await fill(page, { ...credentials, password: '😀'.repeat(14) });
  await button.click();
  await expect(page.locator('#register-password-error')).toContainText('at least 15');
  assert.equal(posts, 0);
  await fill(page);
  await field(page, 'Confirm password').fill('not the same password');
  await button.click();
  await expect(page.locator('#register-confirmPassword-error')).toContainText('do not match');
  assert.equal(posts, 0);
  await fill(page);
  let release;
  const hold = async (route) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    await route.continue();
  };
  await page.route('**/auth/register', hold);
  const completed = page.waitForResponse(
    (response) =>
      response.url().endsWith('/auth/register') && response.request().method() === 'POST',
  );
  await button.click();
  await expect(button).toHaveText('Creating…');
  await expect(button).toBeDisabled();
  await expect(field(page, 'Password')).toBeDisabled();
  await page.keyboard.press('Enter');
  assert.equal(posts, 1);
  release();
  const response = await completed;
  assert.equal(response.status(), 201);
  assert.equal((await response.allHeaders())['set-cookie'], undefined);
  const payload = response.request().postDataJSON();
  assert.deepEqual(Object.keys(payload).sort(), ['displayName', 'password', 'username']);
  assert.equal(payload.username, credentials.username.toUpperCase());
  assert.equal(payload.password, credentials.password);
  assert.equal((await response.request().allHeaders())['origin'], origin);
  const player = (await response.json()).player;
  players.push({ id: player.id, username: credentials.username });
  await savePlayers();
  assert.equal(player.displayName, 'Curious Player 👩‍💻');
  await page.unroute('**/auth/register', hold);
  await expect(page.getByRole('heading', { name: 'Account created', exact: true })).toBeFocused();
  assert.equal(
    (await context.cookies(origin)).some((cookie) => cookie.name === '__Host-trivia_session'),
    false,
  );
  assert.equal(
    await page.evaluate(
      async () => (await fetch('/auth/profile', { credentials: 'include' })).status,
    ),
    401,
  );
  await page.getByRole('link', { name: 'Continue to sign in', exact: true }).click();
  await expect(page).toHaveURL(origin + '/login');
  await expect(field(page, 'Password')).toHaveValue('');
  await signIn();
  const cookie = (await context.cookies(origin)).find(
    (value) => value.name === '__Host-trivia_session',
  );
  assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Lax');
  assert.equal(await page.evaluate(() => document.cookie.includes('trivia_session')), false);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.goto(origin + '/register');
  await expect(page).toHaveURL(origin + '/play');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  const revoked = await context.request.get(origin + '/auth/profile', {
    headers: { Cookie: `${cookie.name}=${cookie.value}` },
  });
  assert.equal(revoked.status(), 401);
  await page.goto(origin + '/register');
  await fill(page);
  const conflict = page.waitForResponse((r) => r.url().endsWith('/auth/register'));
  await button.click();
  assert.equal((await conflict).status(), 409);
  await expect(page.locator('form .feedback')).toContainText('username is not available');
  for (const status of [403, 429, 503]) {
    const fail = (route) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: status === 429 ? { 'Retry-After': '1' } : {},
        body: JSON.stringify({
          code:
            status === 429
              ? 'RATE_LIMITED'
              : status === 403
                ? 'ORIGIN_FORBIDDEN'
                : 'AUTH_UNAVAILABLE',
        }),
      });
    await page.route('**/auth/register', fail);
    await button.click();
    await expect(page.locator('form .feedback')).toContainText(
      status === 403 ? 'HTTPS' : status === 429 ? 'wait' : 'not confirmed',
    );
    if (status === 429) {
      await expect(button).toBeDisabled();
      await expect(button).toBeEnabled();
    }
    await page.unroute('**/auth/register', fail);
  }
  // Real COMMIT followed by a deliberately lost response: no automatic retry/login.
  const uncertain = { ...credentials, username: credentials.username + '_uncertain' };
  await fill(page, uncertain);
  let lost;
  const lostResponse = new Promise((resolve) => {
    lost = resolve;
  });
  const loseResponse = async (route) => {
    assert.equal(route.request().postDataJSON().username, uncertain.username.toUpperCase());
    const persisted = await route.fetch({ maxRetries: 0 });
    assert.equal(persisted.status(), 201);
    const value = await persisted.json();
    players.push({ id: value.player.id, username: uncertain.username });
    await savePlayers();
    await route.abort('failed');
    lost();
  };
  await page.route('**/auth/register', loseResponse);
  await button.click();
  await lostResponse;
  await expect(page.locator('form .feedback')).toContainText('it may have succeeded');
  await expect(button).toBeEnabled();
  await page.unroute('**/auth/register', loseResponse);
  await page.getByRole('link', { name: 'Already have an account? Sign in', exact: true }).click();
  await signIn(uncertain);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  assert.equal(
    await page.evaluate(() => window.localStorage.length + window.sessionStorage.length),
    0,
  );
  // Native keyboard form entry and mobile touch are also covered by the existing auth smoke.
  await page.goto(origin + '/register');
  await expect(page.getByRole('button', { name: 'Register', exact: true })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toHaveText('Skip to content');
  await page.keyboard.press('Enter');
  await expect(page.locator(':focus')).toHaveAttribute('id', 'main-content');
  await expect(page).toHaveURL(origin + '/register');
  await page.keyboard.press('Tab');
  await expect(field(page, 'Username')).toBeFocused();
  assert.ok(
    await field(page, 'Username').evaluate(
      (input) => Number.parseFloat(getComputedStyle(input).outlineWidth) >= 2,
    ),
  );
  for (const name of ['Username', 'Public display name', 'Password', 'Confirm password'])
    assert.ok((await field(page, name).boundingBox()).height >= 44);
  const mobileContext = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const mobile = await mobileContext.newPage();
    const account = { ...credentials, username: credentials.username + '_touch' };
    await mobile.goto(origin + '/register');
    await fill(mobile, account, 'Mobile Player');
    const created = mobile.waitForResponse((r) => r.url().endsWith('/auth/register'));
    await mobile.getByRole('button', { name: 'Register', exact: true }).tap();
    const response = await created;
    assert.equal(response.status(), 201);
    players.push({ id: (await response.json()).player.id, username: account.username });
    await savePlayers();
    await mobile.getByRole('link', { name: 'Continue to sign in', exact: true }).tap();
    await field(mobile, 'Username').fill(account.username);
    await field(mobile, 'Password').fill(account.password);
    await mobile.getByRole('button', { name: 'Sign in', exact: true }).tap();
    await expect(mobile).toHaveURL(origin + '/play');
    await mobile.getByRole('button', { name: 'Sign out', exact: true }).tap();
    await expect(mobile.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  } finally {
    await mobileContext.close();
  }
  await writeFile(
    process.env['SMOKE_CREDENTIALS_OUT'] ?? '/smoke/credentials.json',
    JSON.stringify(credentials),
    { mode: 0o600 },
  );
  assert.deepEqual(failures, []);
  console.log(
    'PASS: trusted Chromium Register → 201/no cookie → explicit Login → Play → reload → logout/revocation; canonical conflict; validation and duplicate prevention; uncertain COMMIT recovery; Origin/rate/unavailable feedback; keyboard/focus/reduced motion; desktop/mobile/200% text geometry; no password storage.',
  );
} finally {
  await savePlayers();
  await browser.close();
}
