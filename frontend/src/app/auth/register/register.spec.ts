import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from '../../app.routes.js';
import { Session } from '../session.js';
import { Register } from './register.js';

const valid = {
  username: 'ALIce',
  displayName: ' Nguyễn 👩‍💻 ',
  password: ' exact password 👩‍💻 ',
  confirmPassword: ' exact password 👩‍💻 ',
};
describe('Register form and HTTP boundary', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<Register>;
  let element: HTMLElement;
  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter(routes)],
    });
    http = TestBed.inject(HttpTestingController);
    const check = TestBed.inject(Session).check();
    http
      .expectOne('/auth/profile')
      .flush({ code: 'UNAUTHENTICATED' }, { status: 401, statusText: 'Unauthorized' });
    await check;
    fixture = TestBed.createComponent(Register);
    element = fixture.nativeElement;
    await fixture.whenStable();
  });
  afterEach(() => http.verify());
  async function fill(values = valid) {
    for (const [name, value] of Object.entries(values)) {
      const input = element.querySelector<HTMLInputElement>(`#register-${name}`)!;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await fixture.whenStable();
  }
  function send() {
    element
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }
  it('uses separate named identity/password fields and password-manager semantics', () => {
    expect(element.querySelectorAll('input')).toHaveLength(4);
    for (const name of ['password', 'confirmPassword']) {
      expect(element.querySelector(`#register-${name}`)?.getAttribute('autocomplete')).toBe(
        'new-password',
      );
      expect(element.querySelector(`#register-${name}`)?.getAttribute('type')).toBe('password');
    }
    expect(element.querySelector('#register-username')?.getAttribute('autocomplete')).toBe(
      'username',
    );
    expect(element.querySelector('label[for="register-displayName"]')?.textContent).toBe(
      'Public display name',
    );
    expect(element.querySelectorAll('[role=alert]')).toHaveLength(0);
  });
  it('shows associated required errors with one polite summary and blocks empty submissions', async () => {
    send();
    await fixture.whenStable();
    for (const name of ['username', 'displayName', 'password', 'confirmPassword']) {
      expect(element.querySelector(`#register-${name}`)?.getAttribute('aria-invalid')).toBe('true');
      expect(element.querySelector(`#register-${name}`)?.getAttribute('aria-describedby')).toBe(
        `register-${name}-error`,
      );
    }
    expect(element.querySelector('[role=status]')?.textContent).toContain(
      'Check the highlighted fields',
    );
    http.expectNone('/auth/register');
  });
  for (const [name, changes, message] of [
    ['username whitespace', { username: ' alice' }, 'no spaces'],
    ['username long', { username: 'a'.repeat(129) }, 'at most 128'],
    ['username Unicode', { username: 'é' }, 'no spaces'],
    ['blank display name', { displayName: '  ' }, 'not blank'],
    ['display control', { displayName: 'a\u0000b' }, 'control'],
    ['display bidi', { displayName: 'a\u202eb' }, 'control'],
    ['display surrogate', { displayName: '\ud800' }, 'control'],
    ['display long', { displayName: '👩‍💻'.repeat(65) }, 'at most 64'],
    [
      '14 Unicode points',
      { password: '😀'.repeat(14), confirmPassword: '😀'.repeat(14) },
      'at least 15',
    ],
    [
      'UTF-8 bytes',
      { password: '😀'.repeat(257), confirmPassword: '😀'.repeat(257) },
      '1024 UTF-8 bytes',
    ],
    ['confirmation mismatch', { confirmPassword: 'something different' }, 'do not match'],
  ] as const) {
    it(`blocks ${name} synchronously`, async () => {
      await fill({ ...valid, ...changes });
      send();
      await fixture.whenStable();
      expect(element.textContent).toContain(message);
      http.expectNone('/auth/register');
    });
  }
  for (const password of ['😀'.repeat(15), '😀'.repeat(256), 'a'.repeat(1024), ' '.repeat(15)]) {
    it(`accepts the approved ${new TextEncoder().encode(password).length}-byte password without extra restrictions`, async () => {
      await fill({
        ...valid,
        username: 'x'.repeat(128),
        displayName: '👩‍💻'.repeat(64),
        password,
        confirmPassword: password,
      });
      send();
      const request = http.expectOne('/auth/register');
      expect(request.request.body.password).toBe(password);
      request.flush(
        { player: { id: 'player-new', displayName: valid.displayName } },
        { status: 201, statusText: 'Created' },
      );
      await fixture.whenStable();
    });
  }
  it('awaits native submission, prevents duplicates, sends exact fields and never logs in or changes the viewer', async () => {
    await fill();
    send();
    send();
    expect(fixture.componentInstance['fields']().submitting()).toBe(true);
    const request = http.expectOne('/auth/register');
    expect(request.request.method).toBe('POST');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.body).toEqual({
      username: valid.username,
      displayName: valid.displayName,
      password: valid.password,
    });
    expect(request.request.timeout).toBe(10000);
    await vi.waitFor(() =>
      expect(element.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true),
    );
    request.flush(
      { player: { id: 'player-new', displayName: valid.displayName } },
      { status: 201, statusText: 'Created' },
    );
    await fixture.whenStable();
    await vi.waitFor(() => expect(fixture.componentInstance['fields']().submitting()).toBe(false));
    expect(TestBed.inject(Session).state().status).toBe('anonymous');
    expect(element.textContent).toContain('Account created');
    expect(element.querySelector('form')).toBeNull();
    expect(fixture.componentInstance['credentials']()).toEqual({
      username: '',
      displayName: '',
      password: '',
      confirmPassword: '',
    });
    const link = element.querySelector<HTMLAnchorElement>('a.continue')!;
    expect(link.textContent).toBe('Continue to sign in');
    link.click();
    await fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/login');
    http.expectNone('/auth/login');
  });
  for (const status of [400, 403, 409, 429, 500, 503, 0]) {
    it(`presents safe ${status} feedback without automatic retry or login`, async () => {
      await fill();
      send();
      const request = http.expectOne('/auth/register');
      if (status === 0) request.error(new ProgressEvent('error'));
      else
        request.flush(
          { code: status === 409 ? 'USERNAME_TAKEN' : 'SERVER_CODE', diagnostics: 'SECRET' },
          {
            status,
            statusText: 'Failure',
            headers: status === 429 ? { 'Retry-After': '900' } : {},
          },
        );
      await fixture.whenStable();
      expect(fixture.componentInstance['fields']().submitting()).toBe(false);
      expect(element.textContent).not.toContain('SECRET');
      expect(element.textContent).not.toContain('Account created');
      expect(TestBed.inject(Session).state().status).toBe('anonymous');
      if (status === 409) expect(element.textContent).toContain('username is not available');
      if (status === 403) expect(element.textContent).toContain('HTTPS');
      if ([0, 500, 503].includes(status))
        expect(element.textContent).toContain('it may have succeeded');
      if (status === 429) {
        expect(element.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(
          true,
        );
        send();
      }
      http.expectNone('/auth/register');
      http.expectNone('/auth/login');
    });
  }
  it('does not turn an unexpected 200 into confirmed registration', async () => {
    await fill();
    send();
    http.expectOne('/auth/register').flush({ player: { id: 'new', displayName: 'Name' } });
    await fixture.whenStable();
    expect(element.textContent).toContain('was not confirmed');
  });
  it('cancels UI ownership on destruction without a stale success or navigation', async () => {
    await fill();
    send();
    const request = http.expectOne('/auth/register');
    fixture.destroy();
    expect(request.cancelled).toBe(true);
    await Promise.resolve();
    expect(TestBed.inject(Session).state().status).toBe('anonymous');
    expect(TestBed.inject(Router).url).toBe('/');
    expect(fixture.componentInstance['credentials']().password).toBe('');
  });
  it('ignores a completion from an obsolete session generation', async () => {
    await fill();
    send();
    const request = http.expectOne('/auth/register');
    const session = TestBed.inject(Session);
    session.unauthenticated(session.generation);
    request.flush(
      { player: { id: 'old', displayName: 'Old' } },
      { status: 201, statusText: 'Created' },
    );
    await fixture.whenStable();
    expect(fixture.componentInstance['result']()).toBeUndefined();
    expect(TestBed.inject(Router).url).toBe('/');
  });
  it('uses public-entry policy to redirect authenticated viewers', async () => {
    fixture.destroy();
    const session = TestBed.inject(Session);
    const login = session.login({ username: 'legacy', password: 'p' });
    http.expectOne('/auth/login').flush({ player: { id: 'known', displayName: 'Known' } });
    await login;
    const harness = await RouterTestingHarness.create('/register');
    expect(TestBed.inject(Router).url).toBe('/play');
    expect(harness.routeNativeElement?.textContent).toContain('Welcome, Known');
  });
  it('keeps profile unavailability distinct from anonymous registration and permits explicit recovery', async () => {
    const session = TestBed.inject(Session);
    const check = session.check();
    http
      .expectOne('/auth/profile')
      .flush({ code: 'AUTH_UNAVAILABLE' }, { status: 503, statusText: 'Unavailable' });
    await check;
    await fixture.whenStable();
    expect(element.querySelector('form')).toBeNull();
    expect(element.textContent).toContain('Check session again');
    const retry = session.check();
    http
      .expectOne('/auth/profile')
      .flush({ code: 'UNAUTHENTICATED' }, { status: 401, statusText: 'Unauthorized' });
    await retry;
    await fixture.whenStable();
    expect(element.querySelector('form')).not.toBeNull();
    http.expectNone('/auth/register');
  });
});
