import { MatchLobby, leaveLobby } from './match/match-lobby.js';
import { Routes } from '@angular/router';
import { authenticated, publicEntry } from './auth/session-guards.js';
import { Register } from './auth/register/register.js';
import { Login } from './auth/login/login.js';
import { Play } from './play/play.js';
import { NotFound } from './not-found.js';
import { HistoryDetail } from './history/history-detail.js';
import { HistoryList } from './history/history-list.js';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'play' },
  {
    path: 'register',
    component: Register,
    canActivate: [publicEntry],
    title: 'Create an account — Trivia',
  },
  { path: 'login', component: Login, canActivate: [publicEntry], title: 'Sign in — Trivia' },
  {
    path: 'play/match/:matchId',
    component: MatchLobby,
    canActivate: [authenticated],
    canDeactivate: [leaveLobby],
    title: 'Match lobby — Trivia',
  },
  {
    path: 'play/history/:matchId',
    component: HistoryDetail,
    canActivate: [authenticated],
    title: 'Match results — Trivia',
  },
  {
    path: 'play/history',
    component: HistoryList,
    canActivate: [authenticated],
    title: 'Match History — Trivia',
  },
  { path: 'play', component: Play, canActivate: [authenticated], title: 'Your space — Trivia' },
  { path: '**', component: NotFound, title: 'Page not found — Trivia' },
];
