import { Component, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Session } from '../auth/session.js';

@Component({
  selector: 'app-play',
  templateUrl: './play.html',
  styleUrl: './play.scss',
})
export class Play {
  protected readonly session = inject(Session);
  private readonly router = inject(Router);
  constructor() {
    effect(() => {
      const state = this.session.state();
      if (state.status === 'anonymous' || state.status === 'unavailable') {
        void this.router.navigateByUrl('/login', { replaceUrl: true });
      }
    });
  }
}
