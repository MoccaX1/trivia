import { DOCUMENT } from '@angular/common';
import { afterNextRender, Component, inject, Injector } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { Session } from './auth/session.js';

@Component({
  imports: [RouterLink, RouterOutlet],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly session = inject(Session);
  protected readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  constructor() {
    let initialNavigation = true;
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        if (initialNavigation) {
          initialNavigation = false;
          return;
        }
        afterNextRender(() => this.document.getElementById('main-content')?.focus(), {
          injector: this.injector,
        });
      });
  }
  protected skipToContent(event: Event): void {
    // The document base is '/', so a bare fragment would leave a nested route.
    event.preventDefault();
    this.document.getElementById('main-content')?.focus();
  }
}
