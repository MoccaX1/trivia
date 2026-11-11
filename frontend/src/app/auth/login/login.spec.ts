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
    expect(element.querySelector('#username-error')?.textContent).toContain(
      'Spaces are not allowed',
    );
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
    expect(element.querySelector('form .feedback[role="alert"]')?.textContent).toContain(
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
});
