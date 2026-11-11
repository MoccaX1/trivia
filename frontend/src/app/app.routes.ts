import { Routes } from '@angular/router';
import { authenticated, publicEntry } from './auth/session-guards.js';
import { Login } from './auth/login/login.js';
import { Play } from './play/play.js';
import { NotFound } from './not-found.js';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'play' },
  { path: 'login', component: Login, canActivate: [publicEntry], title: 'Sign in — Trivia' },
  { path: 'play', component: Play, canActivate: [authenticated], title: 'Your space — Trivia' },
  { path: '**', component: NotFound, title: 'Page not found — Trivia' },
];
