import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { App } from './app.js';
import { routes } from './app.routes.js';
import { Session } from './auth/session.js';

const player = { id: 'player-a', displayName: 'Alice' };
describe('session-aware navigation and shell', () => {
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());
  for (const url of ['/', '/play']) {
    it(`checks before showing private content at ${url} and sends anonymous viewers to login`, async () => {
      const harness = await RouterTestingHarness.create();
      const navigation = harness.navigateByUrl(url);
      let request: ReturnType<HttpTestingController['expectOne']> | undefined;
      await vi.waitFor(() => {
        request = http.expectOne('/auth/profile');
      });
      expect(harness.routeNativeElement?.textContent ?? '').not.toContain(player.displayName);
      request!.flush({ code: 'UNAUTHENTICATED' }, { status: 401, statusText: 'Unauthorized' });
      await navigation;
      expect(TestBed.inject(Router).url).toMatch(/^\/login/);
      expect(harness.routeNativeElement?.querySelector('form')).not.toBeNull();
      http.expectNone('/auth/profile');
    });
  }
  it('restores a session and redirects authenticated login visitors to play', async () => {
    const harness = await RouterTestingHarness.create();
    const navigation = harness.navigateByUrl('/login');
    let request: ReturnType<HttpTestingController['expectOne']> | undefined;
    await vi.waitFor(() => {
      request = http.expectOne('/auth/profile');
    });
    request!.flush({ player });
    await navigation;
    expect(TestBed.inject(Router).url).toBe('/play');
    expect(harness.routeNativeElement?.textContent).toContain('Welcome, Alice');
    expect(harness.routeNativeElement?.querySelector('form')).toBeNull();
  });
  it('shows retryable verification failure without a redirect loop or private content', async () => {
    const harness = await RouterTestingHarness.create();
    const navigation = harness.navigateByUrl('/play');
    let request: ReturnType<HttpTestingController['expectOne']> | undefined;
    await vi.waitFor(() => {
      request = http.expectOne('/auth/profile');
    });
    request!.flush({ code: 'AUTH_UNAVAILABLE' }, { status: 503, statusText: 'Unavailable' });
    await navigation;
    expect(TestBed.inject(Router).url).toMatch(/^\/login/);
    expect(harness.routeNativeElement?.textContent).toContain('Check session again');
    expect(harness.routeNativeElement?.querySelector('form')).toBeNull();
  });
  it('ignores external return targets and navigates only to the implemented play route', async () => {
    const session = TestBed.inject(Session);
    const check = session.check();
    http
      .expectOne('/auth/profile')
      .flush({ code: 'UNAUTHENTICATED' }, { status: 401, statusText: 'Unauthorized' });
    await check;
    const harness = await RouterTestingHarness.create('/login?returnTo=https://evil.example');
    const login = session.login({ username: 'alice', password: 'password' });
    http.expectOne('/auth/login').flush({ player });
    await login;
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/play');
  });
  it('does not let a destroyed login component redirect from a later response', async () => {
    const session = TestBed.inject(Session);
    const check = session.check();
    http
      .expectOne('/auth/profile')
      .flush({ code: 'UNAUTHENTICATED' }, { status: 401, statusText: 'Unauthorized' });
    await check;
    const harness = await RouterTestingHarness.create('/login');
    const login = session.login({ username: 'alice', password: 'password' });
    const request = http.expectOne('/auth/login');
    await harness.navigateByUrl('/not-a-route');
    request.flush({ player });
    await login;
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/not-a-route');
  });
  it('removes protected profile content immediately on session loss', async () => {
    const session = TestBed.inject(Session);
    const login = session.login({ username: 'alice', password: 'password' });
    http.expectOne('/auth/login').flush({ player });
    await login;
    const harness = await RouterTestingHarness.create('/play');
    session.unauthenticated(session.generation);
    await harness.fixture.whenStable();
    expect(harness.routeNativeElement?.textContent).not.toContain('Alice');
    expect(TestBed.inject(Router).url).toBe('/login');
    await harness.navigateByUrl('/play');
    expect(TestBed.inject(Router).url).toMatch(/^\/login/);
  });
  it('keeps a not-found page and accessible skip navigation', async () => {
    const harness = await RouterTestingHarness.create('/unknown-page');
    expect(harness.routeNativeElement?.textContent).toContain('Page not found');
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.skip-link')?.getAttribute('href')).toBe('#main-content');
    expect(element.querySelector('main')?.id).toBe('main-content');
    expect(element.querySelector('a[aria-label="Trivia home"]')).not.toBeNull();
  });
});
