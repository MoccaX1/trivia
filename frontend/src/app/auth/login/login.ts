import { Component, computed, effect, inject, signal } from '@angular/core';
import { form, FormField, readonly, required, submit, validate } from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { passwordBytesError, usernameError } from '../credential-validation.js';
import { Session } from '../session.js';

@Component({
  selector: 'app-login',
  imports: [FormField, RouterLink],
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
      const message = usernameError(value());
      return message ? { kind: 'format', message } : undefined;
    });
    required(path.password, { message: 'Enter your password.' });
    validate(path.password, ({ value }) => {
      const message = passwordBytesError(value());
      return message ? { kind: 'format', message } : undefined;
    });
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
