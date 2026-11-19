import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const origin = 'https://localhost:4200';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const fixtures = JSON.parse(
  await readFile('/smoke/lobby-fixtures.json', 'utf8').catch(() =>
    JSON.stringify({ players: [], matchIds: [] }),
  ),
);
const accounts = [0, 1].map((i) => ({
  username: 'lobby_' + randomBytes(8).toString('hex'),
  displayName: i ? 'Curious Guest' : 'Curious Player 👩‍💻',
  password: randomBytes(24).toString('base64url'),
}));
const contexts = await Promise.all(
  accounts.map(() =>
    browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' }),
  ),
);
const pages = await Promise.all(contexts.map((c) => c.newPage()));
const errors = [];
const snapshots = pages.map(() => []);
for (const [index, page] of pages.entries()) {
  page.on('pageerror', (e) => errors.push(e.message));
  const record = (payload) => {
    for (const packet of payload.split(String.fromCharCode(30))) {
      if (!packet.startsWith('42[')) continue;
      const [event, snapshot] = JSON.parse(packet.slice(2));
      if (event === 'MatchSnapshot') snapshots[index].push(snapshot);
    }
  };
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string') record(payload);
    }),
  );
  page.on('response', async (response) => {
    if (
      response.ok() &&
      response.url().includes('/socket.io/') &&
      response.request().method() === 'GET' &&
      response.url().includes('transport=polling')
    ) {
      const payload = await response.text().catch(() => '');
      record(payload);
    }
  });
}
async function save() {
  await writeFile('/smoke/lobby-fixtures.json', JSON.stringify(fixtures));
}
async function login(page, account) {
  await page.goto(origin + '/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create Match', exact: true })).toBeEnabled();
}
try {
  for (const [i, page] of pages.entries()) {
    await page.goto(origin + '/register');
    await page.getByLabel('Username', { exact: true }).fill(accounts[i].username);
    await page.getByLabel('Public display name', { exact: true }).fill(accounts[i].displayName);
    await page.getByLabel('Password', { exact: true }).fill(accounts[i].password);
    await page.getByLabel('Confirm password', { exact: true }).fill(accounts[i].password);
    const registered = page.waitForResponse((r) => r.url().endsWith('/auth/register'));
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    const response = await registered;
    assert.equal(response.status(), 201);
    fixtures.players.push({ ...(await response.json()).player, username: accounts[i].username });
    await save();
    await login(page, accounts[i]);
  }
  const [host, guest] = pages;
  await host.getByRole('button', { name: 'Create Match', exact: true }).click();
  await expect(host).toHaveURL(/\/play\/match\/[a-f0-9-]+$/);
  const id = host.url().split('/').at(-1);
  fixtures.matchIds.push(id);
  await save();
  await expect(host.getByRole('heading', { name: 'Waiting for players' })).toBeVisible();
  await expect(host.getByRole('button', { name: 'Start Match', exact: true })).toBeDisabled();
  await guest.getByLabel('Match ID', { exact: true }).fill(id);
  await guest.getByRole('button', { name: 'Join Match', exact: true }).click();
  await expect(guest).toHaveURL(origin + '/play/match/' + id);
  for (const page of pages) {
    await expect(
      page.getByRole('list', { name: 'Participants' }).getByRole('listitem'),
    ).toHaveCount(2);
    await expect(
      page.getByRole('listitem').filter({ hasText: accounts[0].displayName }),
    ).toContainText('Host');
  }
  guest.once('dialog', (dialog) => dialog.dismiss());
  await guest.getByRole('link', { name: 'Back to Match entry' }).click();
  await expect(guest).toHaveURL(origin + '/play/match/' + id);
  await expect(guest.getByRole('button', { name: 'Start Match', exact: true })).toHaveCount(0);
  await expect(host.getByRole('button', { name: 'Start Match', exact: true })).toBeEnabled();
  await host.screenshot({ path: 'test-results/lobby-host-desktop.png', fullPage: true });
  await guest.screenshot({ path: 'test-results/lobby-guest-desktop.png', fullPage: true });
  // Clipboard and keyboard focus use the actual browser security context.
  await contexts[0].grantPermissions(['clipboard-read', 'clipboard-write']);
  await host.getByRole('button', { name: 'Copy Match ID' }).click();
  assert.equal(await host.evaluate(() => window.navigator.clipboard.readText()), id);
  for (const [width, scale] of [
    [768, '100%'],
    [375, '100%'],
    [320, '100%'],
    [320, '200%'],
  ]) {
    await guest.setViewportSize({ width, height: 812 });
    await guest.evaluate((scale) => {
      document.documentElement.style.fontSize = scale;
      window.scrollTo(0, 0);
    }, scale);
    assert.equal(
      await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await guest.screenshot({ path: `test-results/lobby-${width}-${scale}.png`, fullPage: true });
  }
  await host.keyboard.press('Tab');
  assert.ok(await host.locator(':focus').count());
  await host.getByRole('button', { name: 'Start Match', exact: true }).click();
  const latest = (index, number = 1) =>
    snapshots[index].findLast(
      (snapshot) => snapshot.phase === 'QUESTION_OPEN' && snapshot.state.questionNumber === number,
    );
  await Promise.all(
    pages.map(async (page, index) => {
      await expect(page.getByText('Question 1 of 10', { exact: true })).toBeVisible();
      await expect.poll(() => latest(index)?.state.question.questionId).toBeTruthy();
      const question = latest(index).state.question;
      await expect(page.getByRole('heading', { name: question.text, exact: true })).toBeVisible();
      const group = page.getByRole('group', { name: question.text });
      for (const [attempt, choice] of question.choices.slice(0, 2).entries()) {
        const button = group.getByRole('button', { name: choice.text, exact: true });
        if (index === 0 && attempt === 0) {
          await button.focus();
          await expect(button).toHaveAttribute('aria-pressed', 'false');
          assert.equal(latest(index).state.ownSubmission, undefined);
          await page.keyboard.press('Enter');
        } else await button.click();
        await expect
          .poll(() => latest(index)?.state.ownSubmission)
          .toMatchObject({
            choiceId: choice.choiceId,
            attemptCount: attempt + 1,
          });
        await expect(
          group.getByRole('button', { name: choice.text + ' Confirmed selection', exact: true }),
        ).toHaveAttribute('aria-pressed', 'true');
        await expect(
          page.getByText(new RegExp(`${attempt + 1} of 3 attempts confirmed`)),
        ).toBeVisible();
      }
      await expect(page.getByText('Question 2 of 10', { exact: true })).toBeVisible({
        timeout: 25000,
      });
      await expect.poll(() => latest(index, 2)?.state.question.questionId).toBeTruthy();
      assert.equal(latest(index, 2).state.ownSubmission, undefined);
      await expect(page.getByText(/0 of 3 attempts confirmed/)).toBeVisible();
      await expect(page.locator('.choices [aria-pressed="true"]')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Retry original command' })).toHaveCount(0);
    }),
  );
  assert.equal(await host.locator('input').count(), 0);
  await contexts[1].setOffline(true);
  await expect(
    guest.getByText('Connection lost. This is the last known view', { exact: false }),
  ).toBeVisible({ timeout: 45000 });
  await contexts[1].setOffline(false);
  await expect(
    guest.getByText('Connection lost. This is the last known view', { exact: false }),
  ).toBeVisible();
  await guest.reload();
  await expect(guest.getByRole('heading', { name: 'No live subscription' })).toBeVisible();
  await guest.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(guest).toHaveURL(/\/login/);
  await host.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(host).toHaveURL(/\/login/);
  assert.deepEqual(errors, []);
  await writeFile(
    '/smoke/credentials.json',
    JSON.stringify({ username: accounts[0].username, password: accounts[0].password }),
    { mode: 0o600 },
  );
  console.log(
    'PASS: real two-player Lobby, Host Start, QUESTION_OPEN, two confirmed answers per viewer checked against authorized snapshots, question rollover, clipboard and keyboard, offline/stale/reload, and logout.',
  );
} finally {
  await save();
  await browser.close();
}
