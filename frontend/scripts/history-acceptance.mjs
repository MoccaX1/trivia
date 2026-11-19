import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';

function historyResponse(page, path) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === path && response.request().resourceType() === 'fetch';
  });
}

const unavailable = /Match results unavailable/;

export async function verifyParticipantHistory(
  page,
  origin,
  matchId,
  viewer,
  finished,
  reveals,
  sockets,
  index,
) {
  const api = '/history/' + matchId;
  const url = origin + '/play' + api;
  const link = page.getByRole('link', { name: 'View Match History' });
  page.once('dialog', (dialog) => dialog.dismiss());
  await link.click();
  await expect(page.getByRole('heading', { name: 'Match finished' })).toBeVisible();
  const liveSockets = sockets.filter((socket) => !socket.isClosed());
  assert.ok(liveSockets.length > 0, 'Expected an upgraded gameplay socket before leaving FINISHED');
  page.once('dialog', (dialog) => dialog.accept());
  const response = historyResponse(page, api);
  await link.click();
  await expect(page).toHaveURL(url);
  await expect.poll(() => liveSockets.every((socket) => socket.isClosed())).toBe(true);
  let committed = await response;
  const initialStatus = committed.status();
  for (let retry = 0; committed.status() === 404 && retry < 3; retry++) {
    await expect(page.getByRole('alert')).toContainText(unavailable);
    const refreshed = historyResponse(page, api);
    await page.getByRole('button', { name: 'Refresh' }).click();
    committed = await refreshed;
  }
  assert.equal(committed.status(), 200);
  const detail = await committed.json();
  assert.equal(detail.match.matchId, matchId);
  assert.equal(detail.questions.length, 10);
  const byId = (a, b) => a.playerId.localeCompare(b.playerId);
  assert.deepEqual(
    [...detail.participants].sort(byId),
    [...finished.state.participants].sort(byId),
  );
  const own = detail.participants.find((participant) => participant.playerId === viewer.id);
  const heading = page.getByRole('heading', { name: 'Match results', exact: true });
  await expect(heading).toBeVisible();
  await expect(page.getByText(String(own.rank), { exact: true }).first()).toBeVisible();
  const times = page.locator('time');
  await expect(times.nth(0)).toHaveAttribute('datetime', detail.match.startedAt);
  await expect(times.nth(1)).toHaveAttribute('datetime', detail.match.finishedAt);
  const standings = page.getByRole('list', { name: 'Final standings' }).getByRole('listitem');
  await expect(standings).toHaveCount(detail.participants.length);
  for (const [i, player] of detail.participants.entries()) {
    await expect(standings.nth(i)).toContainText(player.displayName);
    await expect(standings.nth(i)).toContainText(`rank ${player.rank}`, { ignoreCase: true });
    await expect(standings.nth(i)).toContainText(`Score units: ${player.score.scoreUnits}`);
  }
  for (const [i, question] of detail.questions.entries()) {
    const { state } = reveals[i];
    const { text, choices, correctChoiceId } = state.question;
    assert.deepEqual(question, {
      questionNumber: state.questionNumber,
      text,
      choices,
      correctChoiceId,
      ownResult: {
        selectedChoiceId: state.ownResult.selectedChoiceId ?? null,
        attemptCount: state.ownResult.attemptCount,
        finalAnsweredMs: state.ownResult.finalAnsweredMs ?? null,
        score: state.ownResult.questionScore,
      },
    });
    const region = page.getByRole('region', { name: `${i + 1}. ${text}`, exact: true });
    await expect(region.locator('p strong')).toHaveText(
      question.ownResult.selectedChoiceId === null
        ? 'No answer'
        : state.ownResult.correct
          ? 'Correct'
          : 'Incorrect',
    );
    await expect(region.getByRole('listitem')).toHaveText(
      choices.map(
        (choice) =>
          choice.text +
          (choice.choiceId === correctChoiceId ? ' · Correct answer' : '') +
          (choice.choiceId === question.ownResult.selectedChoiceId ? ' · Your answer' : ''),
      ),
    );
    await expect(region.locator('dd')).toHaveText([
      String(question.ownResult.attemptCount),
      question.ownResult.finalAnsweredMs === null
        ? 'No response'
        : `${question.ownResult.finalAnsweredMs} ms`,
      question.ownResult.score.scoreUnits,
    ]);
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: `test-results/history-detail-${index}.png`, fullPage: true });
  for (const action of [
    () => page.getByRole('button', { name: 'Refresh' }).click(),
    () => page.reload(),
    () => page.goto(url),
  ]) {
    const refreshed = historyResponse(page, api);
    await action();
    const fresh = await refreshed;
    assert.equal(fresh.status(), 200);
    assert.deepEqual(await fresh.json(), detail);
    await expect(page.locator('.question')).toHaveCount(10);
  }
  const listResponse = historyResponse(page, '/history');
  await page.getByRole('link', { name: 'Back to History' }).click();
  await expect(page).toHaveURL(origin + '/play/history');
  const list = await listResponse;
  assert.equal(list.status(), 200);
  const listData = await list.json();
  assert.deepEqual(
    listData.items.find((item) => item.matchId === matchId),
    {
      matchId,
      finishedAt: detail.match.finishedAt,
      participantCount: detail.participants.length,
      ownResult: { score: own.score, rank: own.rank },
    },
  );
  const row = page.getByRole('listitem').filter({ has: page.locator(`a[href="/play${api}"]`) });
  await expect(row).toContainText(`${detail.participants.length} players · Rank ${own.rank}`);
  await expect(row).toContainText(`Score units: ${own.score.scoreUnits}`);
  await expect(row.locator('time')).toHaveAttribute('datetime', detail.match.finishedAt);
  const back = page.getByRole('link', { name: 'Back to Play' });
  for (
    let tab = 0;
    tab < 8 && !(await back.evaluate((element) => element === document.activeElement));
    tab++
  ) {
    await page.keyboard.press('Tab');
  }
  await expect(back).toBeFocused();
  assert.equal(await back.evaluate((element) => getComputedStyle(element).outlineStyle), 'solid');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: `test-results/history-list-${index}.png`, fullPage: true });
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(origin + '/play');
  return { initialStatus, detail, list: listData };
}

export async function verifyOutsiderHistory(page, origin, matchId, viewer) {
  const response = historyResponse(page, '/history');
  await page.goto(origin + '/play/history');
  const list = await response;
  assert.equal(list.status(), 200);
  const history = await list.json();
  assert.deepEqual(history, { items: [], nextCursor: null });
  await expect(page.getByText('No completed Matches yet.')).toBeVisible();
  const probes = [];
  for (const id of [matchId, randomUUID()]) {
    const path = '/history/' + id;
    const pending = historyResponse(page, path);
    await page.goto(origin + '/play' + path);
    const result = await pending;
    assert.equal(result.status(), 404);
    const body = await result.json();
    assert.deepEqual(body, { code: 'NOT_FOUND' });
    const rendered = page.getByRole('alert');
    await expect(rendered).toContainText(unavailable);
    await expect(page.locator('.question, #standings-title')).toHaveCount(0);
    probes.push({
      matchId: id,
      status: result.status(),
      body,
      message: await rendered.innerText(),
    });
  }
  assert.equal(probes[0].message, probes[1].message);
  await page.getByRole('link', { name: 'Back to History' }).click();
  await expect(page.getByText('No completed Matches yet.')).toBeVisible();
  return { viewer, history, probes };
}
