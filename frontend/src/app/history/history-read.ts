import { HttpErrorResponse } from '@angular/common/http';
import { computed, DestroyRef, effect, inject, linkedSignal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { type Observable, Subscription, take } from 'rxjs';
import { Session } from '../auth/session.js';

interface ReadState<T> {
  data?: T;
  loading: boolean;
  error?: number;
}

/** One read lifecycle per History route, including cancellation and session isolation. */
export function historyRead<T>(key: () => string, initial: (key: string) => Observable<T>) {
  const session = inject(Session);
  const router = inject(Router);
  const owner = inject(DestroyRef);
  const context = computed(() => {
    if (!session.player()) return undefined;
    return { key: key(), generation: session.generation };
  });
  const state = linkedSignal({
    source: context,
    computation: (): ReadState<T> => ({ loading: true }),
  });
  let request: Subscription | undefined;

  function read(fetch: (key: string) => Observable<T>, merge?: (page: T, previous?: T) => T) {
    const scope = context();
    if (!scope || scope.generation !== session.generation || request || owner.destroyed) return;

    const previous = merge ? state().data : undefined;
    state.set({ data: previous, loading: true });
    const active = new Subscription();
    request = active;
    const isCurrent = () =>
      request === active && context() === scope && session.generation === scope.generation;
    active.add(
      fetch(scope.key)
        .pipe(take(1))
        .subscribe({
          next: (data) => {
            if (!isCurrent()) return;
            request = undefined;
            state.set({ data: merge ? merge(data, previous) : data, loading: false });
          },
          error: (error: unknown) => {
            if (!isCurrent()) return;
            request = undefined;
            if (
              error instanceof HttpErrorResponse &&
              error.status === 401 &&
              error.error?.code === 'UNAUTHENTICATED'
            ) {
              state.set({ loading: false });
              session.unauthenticated(scope.generation);
            } else {
              state.set({
                data: previous,
                loading: false,
                error: error instanceof HttpErrorResponse ? error.status : -1,
              });
            }
          },
        }),
    );
  }

  session.watchForeground(owner);
  effect((cleanup) => {
    const scope = context();
    if (scope) untracked(() => read(initial));
    else if (session.state().status !== 'checking')
      void router.navigateByUrl('/login', { replaceUrl: true });
    cleanup(() => {
      const obsolete = request;
      request = undefined;
      obsolete?.unsubscribe();
    });
  });

  return {
    state: state.asReadonly(),
    refresh: () => read(initial),
    append: (fetch: () => Observable<T>, merge: (next: T, previous?: T) => T) => read(fetch, merge),
  };
}

export function historyError(status: number | undefined, invalid: string) {
  switch (status) {
    case 0:
      return 'Could not connect to History. Check your connection and try again.';
    case 400:
      return invalid;
    case 403:
      return 'History could not be opened because the request was blocked.';
    case 404:
      return 'Match results unavailable. The results may not be available yet, or you may not have access to this Match.';
    case 503:
      return 'History is temporarily unavailable. Try again.';
    default:
      return 'Could not load History. Try again.';
  }
}
