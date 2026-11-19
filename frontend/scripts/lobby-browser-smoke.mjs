import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { verifyOutsiderHistory, verifyParticipantHistory } from './history-acceptance.mjs';
const origin = 'https://localhost:4200';
const fullMatch = process.env.SMOKE_FULL_MATCH === '1';
const countdownOnly = process.env.SMOKE_COUNTDOWN === '1';
const historyAcceptance = process.env.SMOKE_HISTORY === '1';
const productionAcceptance = process.env.SMOKE_PRODUCTION === '1';
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
const gameplaySockets = pages.map(() => []);
for (const [index, page] of pages.entries()) {
  page.on('pageerror', (e) => errors.push(e.message));
  const record = (payload) => {
    for (const packet of payload.split(String.fromCharCode(30))) {
      if (!packet.startsWith('42[')) continue;
      const [event, snapshot] = JSON.parse(packet.slice(2));
      if (event === 'MatchSnapshot') snapshots[index].push(snapshot);
    }
  };
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname === '/socket.io/') gameplaySockets[index].push(socket);
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string') record(payload);
    });
  });
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
  if (productionAcceptance) {
    const cookies = await page.context().cookies(origin);
    const session = cookies.find(({ name }) => name.startsWith('__Host-'));
    assert.ok(session?.secure && session.httpOnly && session.sameSite === 'Lax');
  }
}

async function registerAndLogin(page, account) {
  await page.goto(origin + '/register');
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Public display name', { exact: true }).fill(account.displayName);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByLabel('Confirm password', { exact: true }).fill(account.password);
  const registered = page.waitForResponse((r) => r.url().endsWith('/auth/register'));
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  const response = await registered;
  assert.equal(response.status(), 201);
  const viewer = { ...(await response.json()).player, username: account.username };
  fixtures.players.push(viewer);
  await save();
  await login(page, account);
  return viewer;
}

async function verifyStandings(page, participants, viewerId) {
  const rows = page.getByRole('region', { name: /standings/i }).getByRole('listitem');
  const ranked = [...participants].sort((a, b) => a.rank - b.rank);
  await expect(rows).toHaveCount(ranked.length);
  for (const [index, player] of ranked.entries()) {
    const row = rows.nth(index);
    await expect(row.getByText(new RegExp(`^(Tied rank|Rank) ${player.rank}$`))).toBeVisible();
    await expect(row).toContainText(player.displayName);
    await expect(
      row.getByText(`Score units: ${player.score.scoreUnits}`, { exact: true }),
    ).toBeVisible();
    if (player.playerId === viewerId) await expect(row).toContainText('· You');
  }
}

async function verifyFullMatch(matchId, players) {
  const questionLimit = countdownOnly ? 2 : 10;
  const evidence = await Promise.all(
    pages.map(async (page, index) => {
      const viewer = players[index];
      const seen = snapshots[index];
      const questions = [];
      const reveals = [];
      const timerSamples = [];
      assert.equal(
        await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches),
        true,
      );
      const snapshot = async (phase, questionNumber) => {
        const find = () =>
          seen.findLast(
            (item) =>
              item.matchId === matchId &&
              item.phase === phase &&
              (questionNumber === undefined || item.state.questionNumber === questionNumber),
          );
        await expect
          .poll(find, {
            timeout: 20000,
            message: `${viewer.username}: ${phase} ${questionNumber ?? ''}`,
          })
          .toBeTruthy();
        return find();
      };
      const reflow = async (phase) => {
        const overflow = await page.evaluate(() =>
          document.documentElement.scrollWidth <= innerWidth
            ? []
            : [
                { width: document.documentElement.scrollWidth, viewport: innerWidth },
                ...[...document.querySelectorAll('main *')].flatMap((element) => {
                  const { right } = element.getBoundingClientRect();
                  return right > innerWidth
                    ? [
                        {
                          tag: element.tagName,
                          right,
                          text: element.textContent?.trim().slice(0, 90),
                        },
                      ]
                    : [];
                }),
              ],
        );
        assert.deepEqual(overflow, [], phase);
      };
      for (let number = 1; number <= questionLimit; number++) {
        const opened = await snapshot('QUESTION_OPEN', number);
        const { question, questionCount } = opened.state;
        questions.push(opened);
        const group = page.getByRole('group', { name: question.text });
        const buttons = group.getByRole('button');
        await expect(
          page.getByText(`Question ${number} of ${questionCount}`, { exact: true }),
        ).toBeVisible();
        await expect(page.getByRole('heading', { name: question.text, exact: true })).toBeVisible();
        const readTimer = async () => {
          const reading = await page.locator('.timer').evaluate((element) => ({
            browserNow: Date.now(),
            amount: element.textContent.trim(),
          }));
          if (!countdownOnly && !historyAcceptance) return reading;
          const current = seen.findLast(
            (item) =>
              item.matchId === matchId &&
              item.phase === 'QUESTION_OPEN' &&
              item.state.question.questionId === question.questionId,
          );
          return {
            ...reading,
            questionId: question.questionId,
            version: current.version,
            deadlineAt: current.state.deadlineAt,
          };
        };
        const firstReading = await readTimer();
        timerSamples.push(firstReading);
        const saveTimers = () =>
          writeFile(
            `/smoke/countdown-viewer-${index}.json`,
            JSON.stringify({ matchId, viewer, timerSamples }, null, 2),
          );
        const assertTimer = (reading) => {
          const seconds = Number(/^Time left: (\d+)s$/.exec(reading.amount)?.[1]);
          const expected = Math.max(
            0,
            Math.ceil((Date.parse(reading.deadlineAt) - reading.browserNow) / 1000),
          );
          assert.ok(seconds > 0 && Math.abs(seconds - expected) <= 1, JSON.stringify(reading));
          return seconds;
        };
        if (countdownOnly || historyAcceptance) {
          await saveTimers();
          assertTimer(firstReading);
        }
        await expect(buttons).toHaveText(question.choices.map((choice) => choice.text));
        await expect(page.getByText(/0 of 3 attempts confirmed/)).toBeVisible();
        assert.equal(opened.state.ownSubmission, undefined);
        assert.equal('correctChoiceId' in question, false);
        assert.equal('ownResult' in opened.state, false);
        await expect(page.getByText('Correct answer', { exact: true })).toHaveCount(0);
        await reflow(`Question ${number}`);
        // The first demo question has Hanoi as the correct answer. Exercise A → B → A,
        // a wrong answer, and a deliberate no-answer (guest, question two).
        const choices =
          number === 1 && index === 0 ? [0, 1, 0] : number === 2 && index === 1 ? [] : [index];
        for (const [attempt, choiceIndex] of choices.entries()) {
          const choice = question.choices[choiceIndex];
          const button = buttons.nth(choiceIndex);
          if (number === 1 && index === 0 && attempt === 0) {
            await button.focus();
            await expect(button).toBeFocused();
            assert.equal(
              await button.evaluate((element) => getComputedStyle(element).outlineStyle),
              'solid',
            );
            await expect(button).toHaveAttribute('aria-pressed', 'false');
            await page.keyboard.press('Enter');
          } else {
            await button.click();
          }
          await expect
            .poll(
              () =>
                seen.findLast(
                  (item) => item.phase === 'QUESTION_OPEN' && item.state.questionNumber === number,
                )?.state.ownSubmission,
            )
            .toMatchObject({ choiceId: choice.choiceId, attemptCount: attempt + 1 });
          await expect(button).toHaveAttribute('aria-pressed', 'true');
          await expect(button).toContainText('Confirmed selection');
          await expect(
            page.getByText(new RegExp(`${attempt + 1} of 3 attempts confirmed`)),
          ).toBeVisible();
        }
        if (choices.length === 3) {
          await expect(page.getByText(/No answer changes remaining/)).toBeVisible();
          for (const button of await buttons.all())
            await expect(button).toHaveAttribute('aria-disabled', 'true');
        }
        if (countdownOnly || (historyAcceptance && number <= 2)) {
          let later;
          await expect
            .poll(
              async () => {
                later = await readTimer();
                return Number(/^Time left: (\d+)s$/.exec(later.amount)?.[1]);
              },
              { timeout: 4500 },
            )
            .toBeLessThan(assertTimer(firstReading));
          timerSamples.push(later);
          await saveTimers();
          assertTimer(later);
          assert.ok(later.version >= firstReading.version);
          assert.equal(later.deadlineAt, firstReading.deadlineAt);
        }
        if (number === 1)
          await page.screenshot({
            path: `test-results/gameplay-open-${index}.png`,
            fullPage: true,
          });
        const revealed = await snapshot('REVEAL', number);
        reveals.push(revealed);
        const { state } = revealed;
        const result = state.ownResult;
        const chosen = choices.at(-1);
        assert.equal(result.attemptCount, choices.length);
        assert.equal(
          result.selectedChoiceId,
          chosen === undefined ? undefined : question.choices[chosen].choiceId,
        );
        if (number === 1) assert.equal(result.correct, index === 0);
        const outcome =
          chosen === undefined ? 'No answer' : result.correct ? 'Correct' : 'Incorrect';
        await expect(
          page.getByText(`Question ${number} of ${questionCount} · Reveal`, { exact: true }),
        ).toBeVisible();
        await expect(page.getByRole('heading', { name: question.text, exact: true })).toBeVisible();
        await expect(page.getByText(outcome, { exact: true })).toBeVisible();
        await expect(
          page.getByText(`Score units awarded: ${result.questionScore.scoreUnits}`, {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByText(`${result.attemptCount} of 3 attempts confirmed`, { exact: true }),
        ).toBeVisible();
        const rows = page.getByRole('list', { name: 'Answer results' }).getByRole('listitem');
        const correctIndex = question.choices.findIndex(
          (choice) => choice.choiceId === state.question.correctChoiceId,
        );
        await expect(rows.nth(correctIndex)).toContainText(question.choices[correctIndex].text);
        await expect(rows.nth(correctIndex)).toContainText('Correct answer');
        if (chosen !== undefined)
          await expect(rows.nth(chosen)).toContainText(
            result.correct ? 'Your answer' : 'Your answer · Incorrect',
          );
        else await expect(page.getByText(/Your answer/)).toHaveCount(0);
        await verifyStandings(page, state.participants, viewer.id);
        await reflow(`Reveal ${number}`);
        if (number === 1)
          await page.screenshot({
            path: `test-results/gameplay-reveal-${index}.png`,
            fullPage: true,
          });
      }
      if (countdownOnly) {
        assert.notEqual(timerSamples[0].questionId, timerSamples[2].questionId);
        assert.ok(timerSamples[2].version > reveals[0].version);
        assert.ok(Date.parse(timerSamples[2].deadlineAt) > Date.parse(timerSamples[0].deadlineAt));
        for (const [i, reveal] of reveals.entries()) {
          assert.equal(reveal.state.question.questionId, questions[i].state.question.questionId);
          assert.ok(reveal.version > timerSamples[i * 2 + 1].version);
        }
        return { viewer, questions, reveals, timerSamples };
      }
      const finished = await snapshot('FINISHED');
      const standing = finished.state.participants.find((player) => player.playerId === viewer.id);
      await expect(page.getByRole('heading', { name: 'Match finished' })).toBeVisible();
      await expect(
        page.getByText(`Your final rank: ${standing.rank}`, { exact: true }),
      ).toBeVisible();
      await expect(page.locator('.round-result')).toContainText(
        `Score units: ${standing.score.scoreUnits}`,
      );
      await verifyStandings(page, finished.state.participants, viewer.id);
      await reflow('Finished');
      await page.screenshot({
        path: `test-results/gameplay-finished-${index}.png`,
        fullPage: true,
      });
      if (historyAcceptance) {
        await writeFile(
          `/smoke/live-viewer-${index}.json`,
          JSON.stringify({ viewer, questions, reveals, finished, timerSamples }, null, 2),
        );
        const history = await verifyParticipantHistory(
          page,
          origin,
          matchId,
          viewer,
          finished,
          reveals,
          gameplaySockets[index],
          index,
        );
        if (productionAcceptance) {
          const logout = page.waitForResponse(
            (r) => r.url().endsWith('/auth/logout') && r.request().method() === 'POST',
          );
          await page.getByRole('button', { name: 'Sign out' }).click();
          assert.equal((await logout).status(), 204);
          await expect(page).toHaveURL(origin + '/login');
          assert.equal(
            await page.evaluate(
              async () => (await fetch('/history', { credentials: 'include' })).status,
            ),
            401,
          );
          await page.goto(origin + '/play/history/' + matchId);
          await expect(page).toHaveURL(origin + '/login');
          await expect(page.locator('.question')).toHaveCount(0);
          assert.equal(
            (await page.context().cookies(origin)).some(({ name }) => name.startsWith('__Host-')),
            false,
          );
        }
        return {
          viewer,
          questions,
          reveals,
          finished,
          timerSamples,
          history,
          logoutVerified: productionAcceptance,
        };
      }
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('link', { name: 'Back to Play' }).click();
      await expect(page).toHaveURL(origin + '/play');
      return { viewer, questions, reveals, finished, timerSamples };
    }),
  );
  assert.deepEqual(evidence[0].finished, evidence[1].finished);
  assert.deepEqual(errors, []);
  await writeFile(
    countdownOnly ? '/smoke/countdown-evidence.json' : '/smoke/gameplay-evidence.json',
    JSON.stringify({ matchId, players: evidence }, null, 2),
  );
  if (historyAcceptance) {
    const outsider = await browser.newPage();
    const viewer = await registerAndLogin(outsider, {
      username: 'outsider_' + randomBytes(8).toString('hex'),
      displayName: 'History outsider',
      password: randomBytes(24).toString('base64url'),
    });
    const authorization = await verifyOutsiderHistory(outsider, origin, matchId, viewer);
    await writeFile(
      '/smoke/history-evidence.json',
      JSON.stringify({ matchId, players: evidence, authorization }, null, 2),
    );
    console.log(
      `PASS: Match ${matchId}, both viewers completed 10 questions and 10 reveals, FINISHED → History, and outsider authorization verified.`,
    );
    return;
  }
  console.log(
    countdownOnly
      ? `PASS: Match ${matchId}, both viewers observed decreasing countdowns, answers and two server reveals.`
      : `PASS: Match ${matchId}, both viewers observed 10 questions, 10 reveals, FINISHED and Back to Play.`,
  );
}

try {
  if (productionAcceptance) {
    const page = pages[0];
    await page.goto(origin + '/play/history');
    await expect(page).toHaveURL(origin + '/login');
    const assets = await page
      .locator('script[src]')
      .evaluateAll((scripts) => scripts.map((script) => script.getAttribute('src')));
    assert.ok(
      assets.some((src) => /(?:^|\/)main-[A-Z0-9]+\.js$/.test(src)),
      JSON.stringify(assets),
    );
    assert.ok(assets.every((src) => !src.includes('@vite/client')));
    await writeFile('/smoke/production-assets.json', JSON.stringify(assets));
  }
  const firstPlayer = fixtures.players.length;
  for (const [i, page] of pages.entries()) {
    await registerAndLogin(page, accounts[i]);
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
  if (fullMatch || countdownOnly || historyAcceptance) {
    await verifyFullMatch(id, fixtures.players.slice(firstPlayer));
  } else {
    const latest = (index, number = 1) =>
      snapshots[index].findLast(
        (snapshot) =>
          snapshot.phase === 'QUESTION_OPEN' && snapshot.state.questionNumber === number,
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
        const reveal = () =>
          snapshots[index].find(
            (snapshot) => snapshot.phase === 'REVEAL' && snapshot.state.questionNumber === 1,
          );
        await expect.poll(reveal, { timeout: 15000 }).toBeTruthy();
        const { state } = reveal();
        const results = page.getByRole('list', { name: 'Answer results' });
        const correct = state.question.choices.find(
          (choice) => choice.choiceId === state.question.correctChoiceId,
        );
        await expect(results.getByText(correct.text, { exact: true })).toBeVisible();
        await expect(results.getByText(/Correct answer/)).toBeVisible();
        await expect(results.getByText(/Your answer/)).toBeVisible();
        await expect(
          page.getByText('Score units awarded: ' + state.ownResult.questionScore.scoreUnits, {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByText(state.ownResult.attemptCount + ' of 3 attempts confirmed', {
            exact: true,
          }),
        ).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Current standings' })).toBeVisible();
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
      'PASS: real two-player Lobby, Host Start, QUESTION_OPEN, confirmed answers and REVEAL checked against authorized snapshots, question rollover, clipboard and keyboard, offline/stale/reload, and logout.',
    );
  }
} finally {
  await save();
  await browser.close();
}
