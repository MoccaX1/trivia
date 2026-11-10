import { Routes } from '@angular/router';
import { Foundation } from './foundation/foundation.js';

export const routes: Routes = [
  { path: '', component: Foundation, title: 'Trivia — Frontend foundation' },
  { path: '**', redirectTo: '' },
];
