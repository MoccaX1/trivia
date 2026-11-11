import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { routes } from '../../app.routes.js';
import { Session } from '../session.js';
import { Login } from './login.js';

describe('Login form', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<Login>;
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
    fixture = TestBed.createComponent(Login);
    element = fixture.nativeElement;
    await fixture.whenStable();
  });
  afterEach(() => http.verify());
  async function fill(username: string, password: string) {
    for (const [id, value] of [
      ['username', username],
      ['password', password],
    ]) {
      const input = element.querySelector<HTMLInputElement>(`#${id}`)!;
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
  it('labels credentials and uses appropriate password-manager autocomplete', () => {
    expect(element.querySelector('label[for="username"]')?.textContent).toBe('Username');
    expect(element.querySelector('#username')?.getAttribute('autocomplete')).toBe('username');
    expect(element.querySelector('#password')?.getAttribute('type')).toBe('password');
    expect(element.querySelector('#password')?.getAttribute('autocomplete')).toBe(
      'current-password',
    );
  });
  it('shows field errors on submit and prevents empty requests', async () => {
    send();
    await fixture.whenStable();
    expect(element.querySelector('#username-error')?.textContent).toContain('Enter your username');
    expect(element.querySelector('#password-error')?.textContent).toContain('Enter your password');
    http.expectNone('/auth/login');
  });
  it('does not normalize invalid username whitespace or enforce password-creation rules', async () => {
    await fill(' alice', 'p');
    send();
    await fixture.whenStable();
    expect(element.querySelector<HTMLInputElement>('#username')?.value).toBe(' alice');
    expect(element.querySelector('#username-error')?.textContent).toContain('no spaces');
    http.expectNone('/auth/login');
  });
  it('bounds password bytes rather than Unicode character count', async () => {
    await fill('alice', '😀'.repeat(257));
    send();
    await fixture.whenStable();
    expect(element.querySelector('#password-error')?.textContent).toContain('1024 UTF-8 bytes');
    http.expectNone('/auth/login');
  });
  it('preserves exact input on rejection, announces error and blocks duplicate sends', async () => {
    await fill('ALIce', ' páss 👩‍💻 ');
    send();
    send();
    const request = http.expectOne('/auth/login');
    expect(request.request.body).toEqual({ username: 'ALIce', password: ' páss 👩‍💻 ' });
    // HttpClient intentionally keeps Angular unstable until the request completes.
    expect(TestBed.inject(Session).pending()).toBe('login');
    request.flush({ code: 'INVALID_CREDENTIALS' }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();
    expect(element.querySelector('form .feedback[role="status"]')?.textContent).toContain(
      'incorrect',
    );
    expect(element.querySelector<HTMLInputElement>('#username')?.value).toBe('ALIce');
    expect(element.querySelector<HTMLInputElement>('#password')?.value).toBe(' páss 👩‍💻 ');
    expect(element.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
  });
  it('navigates on confirmed current login success', async () => {
    await fill('alice', 'p');
    send();
    http.expectOne('/auth/login').flush({ player: { id: 'a', displayName: 'Alice' } });
    await fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/play');
  });
  it('uses native submitting through the complete async login and disables the button', async () => {
    const component = fixture.componentInstance;
    expect(component['fields']().submitting()).toBe(false);
    expect(component['isSigningIn']()).toBe(false);
    await fill('alice', 'p');
    send();
    const request = http.expectOne('/auth/login');
    expect(component['fields']().submitting()).toBe(true);
    expect(component['isSigningIn']()).toBe(true);
    await vi.waitFor(() => {
      const button = element.querySelector<HTMLButtonElement>('button[type=submit]')!;
      expect(button.disabled).toBe(true);
      expect(button.textContent).toContain('Signing in…');
      expect(button.getAttribute('aria-busy')).toBe('true');
    });
    send();
    http.expectNone('/auth/login');
    request.flush({ code: 'INVALID_CREDENTIALS' }, { status: 401, statusText: 'Unauthorized' });
    await fixture.whenStable();
    expect(component['fields']().submitting()).toBe(false);
    expect(component['isSigningIn']()).toBe(false);
    expect(component['submitDisabled']()).toBe(false);
  });
  it('retains independent session-level pending protection outside form submission', async () => {
    const session = TestBed.inject(Session);
    const operation = session.login({ username: 'alice', password: 'p' });
    const request = http.expectOne('/auth/login');
    expect(fixture.componentInstance['fields']().submitting()).toBe(false);
    expect(fixture.componentInstance['submitDisabled']()).toBe(true);
    send();
    http.expectNone('/auth/login');
    request.flush({ code: 'INVALID_CREDENTIALS' }, { status: 401, statusText: 'Unauthorized' });
    await operation;
    await fixture.whenStable();
    expect(fixture.componentInstance['submitDisabled']()).toBe(false);
  });
  it('keeps Retry-After protection after native submission has finished', async () => {
    await fill('alice', 'p');
    send();
    http.expectOne('/auth/login').flush(
      { code: 'RATE_LIMITED' },
      {
        status: 429,
        statusText: 'Limited',
        headers: { 'Retry-After': '900' },
      },
    );
    await fixture.whenStable();
    expect(fixture.componentInstance['fields']().submitting()).toBe(false);
    expect(fixture.componentInstance['submitDisabled']()).toBe(true);
    expect(element.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true);
    expect(element.querySelector('[role=status]')?.textContent).toContain('900 seconds');
    send();
    http.expectNone('/auth/login');
  });
  for (const failure of ['network', 'server', 'unavailable']) {
    it(`ends native submission and shows readable ${failure} recovery`, async () => {
      await fill('alice', 'p');
      send();
      const request = http.expectOne('/auth/login');
      if (failure === 'network') request.error(new ProgressEvent('error'));
      else
        request.flush(
          { code: 'INTERNAL_ERROR' },
          {
            status: failure === 'server' ? 500 : 503,
            statusText: 'Failure',
          },
        );
      await fixture.whenStable();
      expect(fixture.componentInstance['fields']().submitting()).toBe(false);
      expect(element.querySelector('[role=alert]')?.textContent).toContain(
        'Sign-in was not confirmed',
      );
      expect(element.textContent).toContain(
        failure === 'network' ? 'could not reach' : failure === 'server' ? 'server' : 'unavailable',
      );
      expect(element.textContent).toContain('Check session again');
    });
  }
  it('associates only visible field descriptions and announces one validation summary', async () => {
    expect(element.querySelectorAll('[role=alert]')).toHaveLength(0);
    expect(element.querySelector('[role=status] p')).toBeNull();
    expect(element.querySelector('#username')?.hasAttribute('aria-describedby')).toBe(false);
    send();
    await fixture.whenStable();
    expect(element.querySelectorAll('[role=status]')).toHaveLength(1);
    expect(element.querySelector('[role=status]')?.getAttribute('aria-atomic')).toBe('true');
    expect(element.querySelector('[role=status]')?.textContent).toContain(
      'Check the highlighted fields',
    );
    expect(element.querySelector('#username')?.getAttribute('aria-describedby')).toBe(
      'username-error',
    );
    expect(element.querySelector('#username')?.getAttribute('aria-invalid')).toBe('true');
    expect(element.querySelector('#password')?.getAttribute('aria-describedby')).toBe(
      'password-error',
    );
    expect(element.querySelectorAll('[role=alert]')).toHaveLength(0);
    await fill('alice', 'p');
    expect(element.querySelector('#username-error')).toBeNull();
    expect(element.querySelector('#password-error')).toBeNull();
    expect(element.querySelector('#username')?.hasAttribute('aria-describedby')).toBe(false);
    expect(element.querySelector('#username')?.getAttribute('aria-invalid')).toBe('false');
    expect(element.querySelector('[role=status] p')).toBeNull();
  });
  it('keeps the 128-character username boundary without trimming', async () => {
    await fill('a'.repeat(129), 'p');
    send();
    await fixture.whenStable();
    expect(element.querySelector('#username-error')?.textContent).toContain('at most 128');
    http.expectNone('/auth/login');
  });
});
