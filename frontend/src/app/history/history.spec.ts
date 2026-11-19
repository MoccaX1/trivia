import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from '../app.routes.js';
import { Session } from '../auth/session.js';
import type { HistoryPage, HistoryResult } from './history-api.js';

const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const player = { id: first, displayName: 'Alice' };
const peer = { id: second, displayName: 'Bob' };
const start = '2026-11-19T09:00:00.000Z';
const finish = '2026-11-19T09:02:30.000Z';
const exact = '9007199254740993';
const score = { scoreUnits: exact };
const cursor = 'opaque_unchanged-1';
const empty: HistoryPage = { items: [], nextCursor: null };
const listPath = '/play/history';
const detailPath = listPath + '/' + first;
const detailUrl = '/history/' + first;

function page(matchId: string, nextCursor: string | null = null): HistoryPage {
  return {
    items: [{ matchId, finishedAt: finish, ownResult: { score, rank: 1 }, participantCount: 2 }],
    nextCursor,
  };
}

function result(matchId = first): HistoryResult {
  return {
    match: { matchId, hostPlayerId: first, startedAt: start, finishedAt: finish },
    participants: [
      { playerId: first, displayName: 'Alice', score, rank: 1 },
      { playerId: second, displayName: 'Bob', score, rank: 1 },
    ],
    questions: ['a', 'b', null].map((selectedChoiceId, i) => ({
      questionNumber: i + 1,
      text: `Question ${matchId[0]}${i + 1}`,
      choices: [
        { choiceId: 'a', text: 'Alpha' },
        { choiceId: 'b', text: 'Beta' },
      ],
      correctChoiceId: 'a',
      ownResult: {
        selectedChoiceId,
        attemptCount: selectedChoiceId === null ? 0 : 1,
        finalAnsweredMs: selectedChoiceId === null ? null : 123,
        score: { scoreUnits: selectedChoiceId === 'a' ? exact : '0' },
      },
    })),
  };
}

describe('History routes and HTTP lifecycle', () => {
  let http: HttpTestingController;
  let session: Session;
  let router: Router;
  let harness: RouterTestingHarness;
  const html = () => harness.routeNativeElement!;
  function click(label: string) {
    const button = [...html().querySelectorAll('button')].find(
      (item) => item.textContent.trim() === label,
    )!;
    button.click();
  }
  async function open(path: string) {
    await harness.navigateByUrl(path);
    await harness.fixture.whenStable();
  }
  async function signIn(as = player) {
    const pending = session.login({ username: 'alice', password: 'password' });
    http.expectOne('/auth/login').flush({ player: as });
    await pending;
  }

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter(routes)],
    });
    http = TestBed.inject(HttpTestingController);
    session = TestBed.inject(Session);
    router = TestBed.inject(Router);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  it('checks the session before a fresh authenticated detail deep link and uses a relative credentialed GET', async () => {
    const navigation = open(detailPath);
    const profile = await vi.waitFor(() => http.expectOne('/auth/profile'));
    http.expectNone(detailUrl);
    profile.flush({ player });
    await navigation;
    const request = http.expectOne(detailUrl);
    expect(request.request.method).toBe('GET');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush(result());
    await harness.fixture.whenStable();
    expect(router.url).toBe(detailPath);
    expect(html().textContent).toContain('Final standings');
  });

  it('redirects an anonymous deep link without reading History', async () => {
    const pending = session.ensureChecked();
    http
      .expectOne('/auth/profile')
      .flush({ code: 'UNAUTHENTICATED' }, { status: 401, statusText: 'Unauthorized' });
    await pending;
    await open(detailPath);
    expect(router.url).toBe('/login');
    http.expectNone(detailUrl);
  });

  it('loads the default list, then renders an empty response and retryable error', async () => {
    await signIn();
    await open(listPath);
    expect(html().textContent).toContain('Loading History');
    const initial = http.expectOne('/history');
    expect(initial.request.withCredentials).toBe(true);
    expect(initial.request.params.keys()).toEqual([]);
    initial.flush(empty);
    await harness.fixture.whenStable();
    expect(html().textContent).toContain('No completed Matches yet');
    click('Refresh');
    http.expectOne('/history').error(new ProgressEvent('error'));
    await harness.fixture.whenStable();
    expect(html().querySelector('[role="alert"]')?.textContent).toContain('Check your connection');
  });

  it('guards duplicate appends, retries failed pages with the same cursor, and refreshes from page one', async () => {
    await signIn();
    await open(listPath);
    http.expectOne('/history').flush(page(first, cursor));
    await harness.fixture.whenStable();
    click('Load More');
    click('Load More');
    const append = () => http.expectOne('/history?cursor=' + cursor);
    append().flush({ code: 'HISTORY_UNAVAILABLE' }, { status: 503, statusText: 'Unavailable' });
    await harness.fixture.whenStable();
    expect(html().querySelector('[role="alert"]')?.textContent).toContain(
      'temporarily unavailable',
    );
    expect(html().querySelector('li')?.textContent).toContain(exact);
    click('Load More');
    append().flush(page(second));
    await harness.fixture.whenStable();
    expect([...html().querySelectorAll('li a')].map((link) => link.getAttribute('href'))).toEqual([
      listPath + '/' + first,
      listPath + '/' + second,
    ]);
    click('Refresh');
    http.expectOne('/history').flush(page(second));
    await harness.fixture.whenStable();
    expect(html().querySelectorAll('li')).toHaveLength(1);
    expect(html().querySelector('li a')?.getAttribute('href')).toBe(listPath + '/' + second);
  });

  it('keeps loaded rows on an invalid continuation and asks for a page-one refresh', async () => {
    await signIn();
    await open(listPath);
    http.expectOne('/history').flush(page(first, cursor));
    await harness.fixture.whenStable();
    click('Load More');
    http
      .expectOne('/history?cursor=' + cursor)
      .flush({ code: 'INVALID_REQUEST' }, { status: 400, statusText: 'Bad Request' });
    await harness.fixture.whenStable();
    expect(html().querySelector('li')?.textContent).toContain(exact);
    expect(html().textContent).not.toContain('Load More');
    expect(html().querySelector('[role="alert"]')?.textContent).toContain('first page');
    click('Refresh');
    http.expectOne('/history').flush(empty);
  });

  it('shows a uniform unavailable state and only reads again after manual refresh', async () => {
    await signIn();
    await open(detailPath);
    http
      .expectOne(detailUrl)
      .flush({ code: 'NOT_FOUND' }, { status: 404, statusText: 'Not Found' });
    await harness.fixture.whenStable();
    expect(html().querySelector('[role="alert"]')?.textContent).toContain(
      'Match results unavailable',
    );
    expect(html().querySelector('nav a')?.getAttribute('href')).toBe(listPath);
    http.expectNone(detailUrl);
    click('Refresh');
    http.expectOne(detailUrl).flush(result());
    await harness.fixture.whenStable();
    const text = html().textContent;
    expect(text).toContain('Tied rank 1 · Alice');
    expect(text).toContain('Tied rank 1 · Bob');
    expect(text).toContain(exact);
    expect(text).toContain('Correct answer');
    expect(text).toContain('Your answer');
    expect(
      [...html().querySelectorAll('.question p strong')].map((item) => item.textContent),
    ).toEqual(['Correct', 'Incorrect', 'No answer']);
    expect(text).toContain('123 ms');
    expect(text).toContain('No response');
  });

  it('clears old Detail on a same-component Match change and cancels the obsolete request', async () => {
    await signIn();
    await open(detailPath);
    http.expectOne(detailUrl).flush(result());
    await harness.fixture.whenStable();
    expect(html().textContent).toContain('Question a1');
    click('Refresh');
    const obsolete = http.expectOne(detailUrl);
    await open(listPath + '/' + second);
    expect(obsolete.cancelled).toBe(true);
    expect(html().textContent).not.toContain('Question a1');
    expect(html().textContent).toContain('Loading Match results');
    const latest = http.expectOne('/history/' + second);
    latest.flush(result(second));
    await harness.fixture.whenStable();
    expect(html().textContent).toContain('Question b1');
  });

  it('ignores an obsolete 401 before cancellation and fetches under the new viewer', async () => {
    await signIn();
    await open(detailPath);
    const obsolete = http.expectOne(detailUrl);
    const nextViewer = session.login({ username: 'bob', password: 'password' });
    const login = http.expectOne('/auth/login');
    obsolete.flush({ code: 'UNAUTHENTICATED' }, { status: 401, statusText: 'Unauthorized' });
    login.flush({ player: peer });
    await nextViewer;
    await harness.fixture.whenStable();
    expect(session.player()?.id).toBe(second);
    http.expectOne(detailUrl).flush(result());
    await harness.fixture.whenStable();
    expect(html().textContent).toContain('Final standings');
  });

  it('clears private data and redirects on a current 401', async () => {
    await signIn();
    await open(detailPath);
    http.expectOne(detailUrl).flush(result());
    await harness.fixture.whenStable();
    click('Refresh');
    http
      .expectOne(detailUrl)
      .flush({ code: 'UNAUTHENTICATED' }, { status: 401, statusText: 'Unauthorized' });
    await harness.fixture.whenStable();
    expect(router.url).toBe('/login');
    expect(session.player()).toBeUndefined();
    expect(html().textContent).not.toContain(exact);
  });

  it('keeps the session on request-policy rejection and offers a retry after a server error', async () => {
    await signIn();
    await open(detailPath);
    http
      .expectOne(detailUrl)
      .flush({ code: 'ORIGIN_FORBIDDEN' }, { status: 403, statusText: 'Forbidden' });
    await harness.fixture.whenStable();
    expect(html().querySelector('[role="alert"]')?.textContent).toContain('request was blocked');
    expect(session.player()?.id).toBe(first);
    click('Refresh');
    http
      .expectOne(detailUrl)
      .flush({ code: 'INTERNAL_ERROR' }, { status: 500, statusText: 'Internal Error' });
    await harness.fixture.whenStable();
    expect(html().querySelector('[role="alert"]')?.textContent).toContain('Could not load History');
    expect(router.url).toBe(detailPath);
  });
});
