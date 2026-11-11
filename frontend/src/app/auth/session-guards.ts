import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Session } from './session.js';

export const authenticated: CanActivateFn = async (_route, navigation) => {
  const session = inject(Session);
  const router = inject(Router);
  await session.ensureChecked();
  return (
    session.state().status === 'authenticated' ||
    router.createUrlTree(['/login'], {
      queryParams: { returnTo: navigation.url === '/play' ? '/play' : undefined },
    })
  );
};

export const publicEntry: CanActivateFn = async () => {
  const session = inject(Session);
  const router = inject(Router);
  await session.ensureChecked();
  return session.state().status !== 'authenticated' || router.createUrlTree(['/play']);
};
