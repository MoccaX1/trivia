import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { form, FormField, required, submit, validate } from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { displayNameError, passwordBytesError, usernameError } from '../credential-validation.js';
import { Registration } from '../registration.js';
import type { RegistrationResult } from '../registration.js';
import { Session } from '../session.js';

const empty = () => ({ username: '', displayName: '', password: '', confirmPassword: '' });
@Component({
  selector: 'app-register',
  imports: [FormField, RouterLink],
  providers: [Registration],
  templateUrl: './register.html',
  styleUrl: './register.scss',
})
export class Register {
  protected readonly session = inject(Session);
  private readonly api = inject(Registration);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly createdHeading = viewChild<ElementRef<HTMLElement>>('createdHeading');
  private readonly credentials = signal(empty());
  protected readonly result = signal<RegistrationResult | undefined>(undefined);
  private readonly clock = signal(Date.now());
  private retryTimer?: ReturnType<typeof setTimeout>;
  protected readonly fields = form(this.credentials, (path) => {
    required(path.username, { message: 'Enter your username.' });
    validate(path.username, ({ value }) => {
      const message = usernameError(value());
      return message ? { kind: 'format', message } : undefined;
    });
    required(path.displayName, { message: 'Enter your public display name.' });
    validate(path.displayName, ({ value }) => {
      const message = displayNameError(value());
      return message ? { kind: 'format', message } : undefined;
    });
    required(path.password, { message: 'Enter your password.' });
    validate(path.password, ({ value }) => {
      const message =
        passwordBytesError(value()) ??
        (value() && [...value()].length < 15 ? 'Use at least 15 characters.' : undefined);
      return message ? { kind: 'format', message } : undefined;
    });
    required(path.confirmPassword, { message: 'Confirm your password.' });
    validate(path.confirmPassword, ({ value, valueOf }) =>
      value() && value() !== valueOf(path.password)
        ? { kind: 'match', message: 'Passwords do not match.' }
        : undefined,
    );
  });
  protected readonly isSubmitting = computed(() => this.fields().submitting());
  protected readonly retryBlocked = computed(() => {
    const result = this.result();
    return result?.status === 'error' && result.retryAt > this.clock();
  });
  protected readonly submitDisabled = computed(
    () =>
      this.isSubmitting() ||
      this.retryBlocked() ||
      !!this.session.pending() ||
      this.session.state().status !== 'anonymous',
  );
  protected readonly errors = computed(() => ({
    username: this.fields.username().touched()
      ? this.fields.username().errors()[0]?.message
      : undefined,
    displayName: this.fields.displayName().touched()
      ? this.fields.displayName().errors()[0]?.message
      : undefined,
    password: this.fields.password().touched()
      ? this.fields.password().errors()[0]?.message
      : undefined,
    confirmPassword: this.fields.confirmPassword().touched()
      ? this.fields.confirmPassword().errors()[0]?.message
      : undefined,
  }));
  protected readonly feedback = computed(() => {
    if (this.isSubmitting()) return 'Creating your account…';
    if (Object.values(this.errors()).some(Boolean)) return 'Check the highlighted fields.';
    const result = this.result();
    return result?.status === 'error' ? result.message : undefined;
  });
  constructor() {
    this.destroyRef.onDestroy(() => {
      clearTimeout(this.retryTimer);
      this.credentials.set(empty());
    });
    effect(() => {
      if (this.session.state().status === 'authenticated') {
        this.credentials.set(empty());
        void this.router.navigateByUrl('/play', { replaceUrl: true });
      }
    });
  }
  protected register(event: Event): void {
    event.preventDefault();
    if (this.submitDisabled()) return;
    void submit(this.fields, async () => {
      const generation = this.session.generation;
      const { username, displayName, password } = this.credentials();
      const result = await this.api.create({ username, displayName, password });
      if (this.destroyRef.destroyed || generation !== this.session.generation) return;
      this.result.set(result);
      if (result.status === 'created') {
        this.credentials.set(empty());
        afterNextRender(() => this.createdHeading()?.nativeElement.focus(), {
          injector: this.injector,
        });
      } else {
        this.clock.set(Date.now());
        clearTimeout(this.retryTimer);
        if (result.retryAt > Date.now())
          this.retryTimer = setTimeout(
            () => this.clock.set(Date.now()),
            Math.min(result.retryAt - Date.now(), 2_147_483_647),
          );
      }
    });
  }
}
