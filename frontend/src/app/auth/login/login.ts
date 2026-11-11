import { Component, computed, effect, inject, signal } from '@angular/core';
import { form, FormField, readonly, required, submit, validate } from '@angular/forms/signals';
import { Router } from '@angular/router';
import { Session } from '../session.js';

@Component({
  selector: 'app-login',
  imports: [FormField],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  protected readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly credentials = signal({ username: '', password: '' });
  protected readonly fields = form(this.credentials, (path) => {
    readonly(path, { when: () => !!this.session.pending() });
    required(path.username, { message: 'Enter your username.' });
    validate(path.username, ({ value }) => {
      const text = value();
      return text && (text.length > 128 || /[^A-Za-z0-9_.-]/.test(text))
        ? {
            kind: 'format',
            message:
              text.length > 128
                ? 'Use at most 128 characters.'
                : 'Use A–Z, a–z, 0–9, _ . -; no spaces.',
          }
        : undefined;
    });
    required(path.password, { message: 'Enter your password.' });
    validate(path.password, ({ value }) =>
      new TextEncoder().encode(value()).length > 1024
        ? { kind: 'format', message: 'Use at most 1024 UTF-8 bytes.' }
        : undefined,
    );
  });

  protected readonly isSigningIn = computed(() => this.fields().submitting());
  protected readonly submitDisabled = computed(
    () => this.isSigningIn() || !!this.session.pending() || this.session.retryBlocked(),
  );
  protected readonly usernameError = computed(() => {
    const field = this.fields.username();
    return field.touched() ? field.errors()[0]?.message : undefined;
  });
  protected readonly passwordError = computed(() => {
    const field = this.fields.password();
    return field.touched() ? field.errors()[0]?.message : undefined;
  });
  protected readonly feedback = computed(() => {
    if (this.isSigningIn()) return 'Checking your credentials…';
    if (this.usernameError() || this.passwordError()) return 'Check the highlighted fields.';
    return this.session.issue()?.message;
  });

  constructor() {
    // This effect belongs to the routed component and stops on destruction.
    // Navigation follows current service state, never an old request callback.
    effect(() => {
      if (this.session.state().status === 'authenticated') {
        this.credentials.set({ username: '', password: '' });
        void this.router.navigateByUrl('/play', { replaceUrl: true });
      }
    });
  }

  protected signIn(event: Event): void {
    event.preventDefault();
    if (this.submitDisabled()) return;
    void submit(this.fields, async () => {
      await this.session.login(this.credentials());
    });
  }
}
