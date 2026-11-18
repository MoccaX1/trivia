import { DOCUMENT } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface Player {
  readonly id: string;
  readonly displayName: string;
}
export interface Credentials {
  readonly username: string;
  readonly password: string;
}
export interface SessionIssue {
  readonly message: string;
  readonly retryAt: number;
}
export type SessionState =
  | { readonly status: 'checking' }
  | { readonly status: 'authenticated'; readonly player: Player }
  | { readonly status: 'anonymous' }
  | { readonly status: 'unavailable'; readonly issue: SessionIssue };

// Only safe public copy is rendered; backend diagnostics never enter the UI.
export function sessionIssue(error: unknown): SessionIssue {
  const response = error instanceof HttpErrorResponse ? error : undefined;
  const retry = response?.headers.get('Retry-After');
  const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : 0;
  const retryAt = retry && !/^\d+$/.test(retry) ? Date.parse(retry) : Date.now() + delay;
  const guidance =
    delay > 0 ? ` Wait at least ${Math.ceil(delay / 1000)} seconds before retrying.` : '';
  let message: string;
  switch (response?.status) {
    case 400:
    case 413:
    case 415:
      message = 'Check your username and password format and try again.';
      break;
    case 401:
      message =
        response?.error?.code === 'INVALID_CREDENTIALS'
          ? 'The username or password is incorrect.'
          : 'Your session has ended. Sign in again.';
      break;
    case 403:
      message =
        'This connection is not permitted. Check the HTTPS address or contact the administrator.';
      break;
    case 429:
      message = 'Too many sign-in attempts. Please wait before trying again.';
      break;
    case 503:
      message = 'The service is temporarily unavailable. Please try again later.';
      break;
    case 500:
      message = 'Something went wrong on the server. Please try again later.';
      break;
    default:
      message = 'We could not reach the service. Check your connection and try again.';
  }
  return { message: message + guidance, retryAt: Number.isFinite(retryAt) ? retryAt : 0 };
}

@Injectable({ providedIn: 'root' })
export class Session {
  private readonly http = inject(HttpClient);
  private readonly current = signal<SessionState>({ status: 'checking' });
  readonly state = this.current.asReadonly();
  readonly player = computed(() => {
    const state = this.state();
    return state.status === 'authenticated' ? state.player : undefined;
  });
  private readonly operation = signal<'login' | 'logout' | undefined>(undefined);
  readonly pending = this.operation.asReadonly();
  private readonly currentIssue = signal<SessionIssue | undefined>(undefined);
  readonly issue = this.currentIssue.asReadonly();
  private readonly logoutUnknown = signal(false);
  readonly logoutUnconfirmed = this.logoutUnknown.asReadonly();
  private readonly cooldown = signal(false);
  readonly retryBlocked = this.cooldown.asReadonly();
  private readonly document = inject(DOCUMENT);
  private readonly verificationState = signal<'pending' | 'unavailable' | undefined>(undefined);
  readonly verification = this.verificationState.asReadonly();
  private epoch = 0;
  private profile?: { epoch: number; promise: Promise<SessionState> };
  private mutation?: Promise<boolean>;
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.retryTimer));
  }

  /** Capture when starting a protected read; never invalidate a newer viewer. */
  get generation(): number {
    return this.epoch;
  }

  unauthenticated(generation: number): void {
    if (generation !== this.epoch) return;
    this.epoch++;
    this.verificationState.set(undefined);
    this.current.set({ status: 'anonymous' });
    this.operation.set(undefined);
    this.currentIssue.set({ message: 'Your session has ended. Sign in again.', retryAt: 0 });
    this.logoutUnknown.set(false);
  }

  ensureChecked(): Promise<SessionState> {
    return this.state().status === 'checking' ? this.check() : Promise.resolve(this.state());
  }

  check(): Promise<SessionState> {
    return this.verify(false);
  }

  revalidate(): Promise<SessionState> {
    return this.verify(true);
  }

  watchForeground(owner: DestroyRef): void {
    let wasHidden = this.document.hidden;
    const onVisibility = () => {
      const resumed = wasHidden && !this.document.hidden;
      wasHidden = this.document.hidden;
      if (resumed && this.player()) void this.revalidate();
    };
    this.document.addEventListener('visibilitychange', onVisibility);
    owner.onDestroy(() => this.document.removeEventListener('visibilitychange', onVisibility));
  }

  private verify(background: boolean): Promise<SessionState> {
    if (this.mutation) return this.mutation.then(() => this.state());
    if (this.profile?.epoch === this.epoch) return this.profile.promise;
    if (this.retryBlocked()) return Promise.resolve(this.state());
    const viewer = background ? this.player() : undefined;
    if (background && !viewer) return Promise.resolve(this.state());
    const epoch = viewer ? this.epoch : ++this.epoch;
    if (viewer) this.verificationState.set('pending');
    else this.current.set({ status: 'checking' });
    const promise = firstValueFrom(
      this.http.get<{ player: Player }>('/auth/profile', {
        withCredentials: true,
        timeout: 10_000,
      }),
    )
      .then(({ player }) => {
        if (epoch !== this.epoch) return this.state();
        if (viewer && player?.id !== viewer.id) {
          this.epoch++;
          this.verificationState.set(undefined);
          this.current.set({
            status: 'unavailable',
            issue: {
              message: 'The session changed. Check your session again to continue.',
              retryAt: 0,
            },
          });
        } else if (!viewer) this.current.set({ status: 'authenticated', player });
        return this.state();
      })
      .catch((error: unknown) => {
        if (epoch === this.epoch) {
          if (
            error instanceof HttpErrorResponse &&
            error.status === 401 &&
            error.error?.code === 'UNAUTHENTICATED'
          ) {
            const wasLogoutUnconfirmed = this.logoutUnconfirmed();
            this.unauthenticated(epoch);
            if (!viewer && !wasLogoutUnconfirmed) this.currentIssue.set(undefined);
          } else {
            const issue = sessionIssue(error);
            if (viewer) this.verificationState.set('unavailable');
            else this.current.set({ status: 'unavailable', issue });
            this.setRetry(issue);
          }
        }
        return this.state();
      })
      .finally(() => {
        if (this.profile?.epoch === epoch) this.profile = undefined;
        if (epoch === this.epoch && this.verification() === 'pending')
          this.verificationState.set(undefined);
      });
    this.profile = { epoch, promise };
    return promise;
  }

  login(credentials: Credentials): Promise<boolean> {
    if (this.pending() || this.retryBlocked()) return Promise.resolve(false);
    return this.mutate('login', credentials);
  }

  logout(): Promise<boolean> {
    if (this.pending() || this.retryBlocked()) return Promise.resolve(false);
    return this.mutate('logout', {});
  }

  private mutate(
    action: 'login' | 'logout',
    body: Credentials | Record<string, never>,
  ): Promise<boolean> {
    const epoch = ++this.epoch;
    this.verificationState.set(undefined);
    this.operation.set(action);
    this.currentIssue.set(undefined);
    this.current.set({ status: 'checking' }); // Removes the previous private profile immediately.
    const promise = firstValueFrom(
      this.http.post<{ player: Player } | null>(`/auth/${action}`, body, {
        withCredentials: true,
        timeout: 10_000,
      }),
    )
      .then((response) => {
        if (epoch !== this.epoch) return false;
        if (action === 'login' && response) {
          this.current.set({ status: 'authenticated', player: response.player });
        } else {
          this.current.set({ status: 'anonymous' });
        }
        this.logoutUnknown.set(false);
        return true;
      })
      .catch((error: unknown) => {
        if (epoch !== this.epoch) return false;
        const issue = sessionIssue(error);
        this.currentIssue.set(issue);
        this.setRetry(issue);
        if (
          error instanceof HttpErrorResponse &&
          error.status === 401 &&
          error.error?.code === 'UNAUTHENTICATED'
        ) {
          this.unauthenticated(epoch);
        } else if (action === 'logout') {
          this.logoutUnknown.set(true);
          this.current.set({
            status: 'unavailable',
            issue: {
              ...issue,
              message: 'Sign-out was not confirmed. ' + issue.message,
            },
          });
        } else if (
          error instanceof HttpErrorResponse &&
          [400, 401, 403, 413, 415, 429].includes(error.status)
        ) {
          this.current.set({ status: 'anonymous' });
        } else {
          this.current.set({
            status: 'unavailable',
            issue: {
              ...issue,
              message:
                'Sign-in was not confirmed. Check your session before trying again. ' +
                issue.message,
            },
          });
        }
        return false;
      })
      .finally(() => {
        if (epoch === this.epoch) this.operation.set(undefined);
        if (this.mutation === promise) this.mutation = undefined;
      });
    this.mutation = promise;
    return promise;
  }

  private setRetry(issue: SessionIssue): void {
    clearTimeout(this.retryTimer);
    const delay = Math.max(0, issue.retryAt - Date.now());
    this.cooldown.set(delay > 0);
    if (delay > 0)
      this.retryTimer = setTimeout(() => this.cooldown.set(false), Math.min(delay, 2_147_483_647));
  }
}
