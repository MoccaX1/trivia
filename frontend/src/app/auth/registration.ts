import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { DestroyRef, inject, Injectable } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import type { Player } from './session.js';

export interface RegistrationInput {
  readonly username: string;
  readonly displayName: string;
  readonly password: string;
}
export type RegistrationResult =
  | { readonly status: 'created'; readonly player: Player }
  | { readonly status: 'error'; readonly message: string; readonly retryAt: number };

@Injectable()
export class Registration {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  async create(input: RegistrationInput): Promise<RegistrationResult> {
    try {
      const response = await firstValueFrom(
        this.http
          .post<{ player: Player }>('/auth/register', input, {
            withCredentials: true,
            observe: 'response',
            timeout: 10_000,
          })
          .pipe(takeUntilDestroyed(this.destroyRef)),
      );
      if (
        response.status !== 201 ||
        !response.body?.player ||
        typeof response.body.player.id !== 'string' ||
        typeof response.body.player.displayName !== 'string'
      )
        throw new Error('Unexpected registration response');
      return { status: 'created', player: response.body.player };
    } catch (error: unknown) {
      const response = error instanceof HttpErrorResponse ? error : undefined;
      const retry = response?.headers.get('Retry-After');
      const retryAt = retry
        ? /^\d+$/.test(retry)
          ? Date.now() + Number(retry) * 1000
          : Date.parse(retry)
        : 0;
      let message: string;
      switch (response?.status) {
        case 409:
          message =
            'That username is not available. Choose another, or sign in if this may be your account.';
          break;
        case 400:
        case 413:
        case 415:
          message = 'Check the field requirements and try again.';
          break;
        case 403:
          message =
            'This connection is not permitted. Check the HTTPS address or contact the administrator.';
          break;
        case 429:
          message = 'Too many account creation attempts. Please wait before trying again.';
          break;
        default:
          message =
            (response?.status === 503
              ? 'The service is temporarily unavailable. '
              : response?.status === 500
                ? 'Something went wrong on the server. '
                : 'We could not reach the service. ') +
            'Account creation was not confirmed; it may have succeeded. Try signing in with your chosen credentials before retrying manually.';
      }
      const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
      if (remaining > 0) message += ` Wait at least ${remaining} seconds before retrying.`;
      return { status: 'error', message, retryAt: Number.isFinite(retryAt) ? retryAt : 0 };
    }
  }
}
