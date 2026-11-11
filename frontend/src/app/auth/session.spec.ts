import { HttpClient, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Session } from './session.js';

const player = { id: 'player-a', displayName: 'Alice 👩‍💻' };
const credentials = { username: 'ALIce', password: ' páss 👩‍💻 ' };

describe('Session HTTP ownership and generations', () => {
  let session: Session;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    session = TestBed.inject(Session);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });
  async function signIn() {
    const result = session.login(credentials);
    http.expectOne('/auth/login').flush({ player });
    await result;
  }
  it('starts checking, shares the initial profile request, and never exposes a token', async () => {
    expect(session.state().status).toBe('checking');
    const first = session.ensureChecked();
    expect(session.ensureChecked()).toBe(first);
    const request = http.expectOne('/auth/profile');
    expect(request.request.method).toBe('GET');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush({ player });
    await first;
    expect(session.state()).toEqual({ status: 'authenticated', player });
    await session.ensureChecked();
    http.expectNone('/auth/profile');
  });
  it('makes a missing session anonymous', async () => {
    const result = session.check();
    http
      .expectOne('/auth/profile')
      .flush({ code: 'UNAUTHENTICATED' }, { status: 401, statusText: 'Unauthorized' });
    await result;
    expect(session.state().status).toBe('anonymous');
    expect(session.player()).toBeUndefined();
  });
  for (const status of [500, 503, 403]) {
    it(`does not interpret profile ${status} as an invalid session`, async () => {
      await signIn();
      const result = session.check();
      expect(session.player()).toBeUndefined();
      http
        .expectOne('/auth/profile')
        .flush({ code: 'INTERNAL_ERROR' }, { status, statusText: 'Failure' });
      await result;
      expect(session.state().status).toBe('unavailable');
      expect(session.player()).toBeUndefined();
    });
  }
  it('makes network verification failures unavailable and permits an explicit recheck', async () => {
    const result = session.check();
    http.expectOne('/auth/profile').error(new ProgressEvent('error'));
    await result;
    expect(session.state().status).toBe('unavailable');
    const retry = session.check();
    http.expectOne('/auth/profile').flush({ player });
    await retry;
    expect(session.player()).toEqual(player);
  });
  it('sends exact credential strings and blocks duplicate submission', async () => {
    const result = session.login(credentials);
    expect(session.pending()).toBe('login');
    expect(await session.login(credentials)).toBe(false);
    const request = http.expectOne('/auth/login');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual(credentials);
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.urlWithParams).toBe('/auth/login');
    request.flush({ player });
    expect(await result).toBe(true);
    expect(session.pending()).toBeUndefined();
    expect(session.player()).toEqual(player);
  });
  it('presents invalid credentials without treating them as transport failure', async () => {
    const result = session.login(credentials);
    http
      .expectOne('/auth/login')
      .flush({ code: 'INVALID_CREDENTIALS' }, { status: 401, statusText: 'Unauthorized' });
    expect(await result).toBe(false);
    expect(session.state().status).toBe('anonymous');
    expect(session.issue()?.message).toContain('username or password is incorrect');
  });
  for (const [status, text] of [
    [400, 'format'],
    [403, 'HTTPS'],
    [500, 'server'],
    [503, 'unavailable'],
  ] as const) {
    it(`maps login ${status} to safe public feedback`, async () => {
      const result = session.login(credentials);
      http
        .expectOne('/auth/login')
        .flush({ code: 'PRIVATE_DETAILS', stack: 'SECRET' }, { status, statusText: 'Failure' });
      await result;
      expect(session.issue()?.message).toContain(text);
      expect(session.issue()?.message).not.toContain('SECRET');
    });
  }
  it('honors Retry-After without automatically retrying login', async () => {
    vi.useFakeTimers();
    const result = session.login(credentials);
    http
      .expectOne('/auth/login')
      .flush(
        { code: 'RATE_LIMITED' },
        { status: 429, statusText: 'Limited', headers: { 'Retry-After': '2' } },
      );
    await result;
    expect(session.retryBlocked()).toBe(true);
    expect(await session.login(credentials)).toBe(false);
    http.expectNone('/auth/login');
    vi.advanceTimersByTime(2000);
    expect(session.retryBlocked()).toBe(false);
    http.expectNone('/auth/login');
  });
  it('sends JSON {} for logout, hides private state while pending and clears it on 204', async () => {
    await signIn();
    const result = session.logout();
    expect(session.player()).toBeUndefined();
    const request = http.expectOne('/auth/logout');
    expect(request.request.body).toEqual({});
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.method).toBe('POST');
    request.flush(null, { status: 204, statusText: 'No Content' });
    expect(await result).toBe(true);
    expect(session.state().status).toBe('anonymous');
    expect(session.logoutUnconfirmed()).toBe(false);
  });
  for (const failure of ['network', 'server']) {
    it(`does not claim logout succeeded after ${failure} failure`, async () => {
      await signIn();
      const result = session.logout();
      const request = http.expectOne('/auth/logout');
      if (failure === 'network') request.error(new ProgressEvent('error'));
      else request.flush({ code: 'INTERNAL_ERROR' }, { status: 500, statusText: 'Failure' });
      expect(await result).toBe(false);
      expect(session.logoutUnconfirmed()).toBe(true);
      expect(session.state().status).toBe('unavailable');
      expect(session.player()).toBeUndefined();
      http.expectNone('/auth/logout');
      const check = session.check();
      http.expectOne('/auth/profile').flush({ player });
      await check;
      expect(session.player()).toEqual(player);
      expect(session.logoutUnconfirmed()).toBe(true);
    });
  }
  it('handles a logout 401 as an already-ended session without claiming successful revocation', async () => {
    await signIn();
    const result = session.logout();
    http
      .expectOne('/auth/logout')
      .flush({ code: 'UNAUTHENTICATED' }, { status: 401, statusText: 'Unauthorized' });
    expect(await result).toBe(false);
    expect(session.state().status).toBe('anonymous');
    expect(session.pending()).toBeUndefined();
    expect(session.issue()?.message).toContain('session has ended');
  });
  it('ignores a profile response that arrives after confirmed logout', async () => {
    const profile = session.check();
    const old = http.expectOne('/auth/profile');
    const logout = session.logout();
    http.expectOne('/auth/logout').flush(null, { status: 204, statusText: 'No Content' });
    await logout;
    old.flush({ player });
    await profile;
    expect(session.state().status).toBe('anonymous');
    expect(session.player()).toBeUndefined();
  });
  it('ignores an obsolete profile 401 after a newer successful login', async () => {
    const profile = session.check();
    const old = http.expectOne('/auth/profile');
    await signIn();
    old.flush({ code: 'UNAUTHENTICATED' }, { status: 401, statusText: 'Unauthorized' });
    await profile;
    expect(session.player()).toEqual(player);
  });
  it('ignores a stale login result after a later session decision', async () => {
    const result = session.login(credentials);
    const old = http.expectOne('/auth/login');
    session.unauthenticated(session.generation);
    old.flush({ player });
    expect(await result).toBe(false);
    expect(session.player()).toBeUndefined();
  });
  it('scopes protected-operation session loss to the originating viewer generation', async () => {
    await signIn();
    const oldGeneration = session.generation;
    await signIn();
    session.unauthenticated(oldGeneration);
    expect(session.player()).toEqual(player);
    session.unauthenticated(session.generation);
    expect(session.player()).toBeUndefined();
    expect(session.state().status).toBe('anonymous');
  });
  it('uses a bounded request timeout without profile keep-alive requests', async () => {
    const result = session.check();
    const request = http.expectOne('/auth/profile');
    expect(request.request.timeout).toBe(10_000);
    expect(TestBed.inject(HttpClient)).toBeDefined();
    request.flush({ player });
    await result;
    http.expectNone('/auth/profile');
  });
});
