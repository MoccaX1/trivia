import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  template: `<h1>Page not found</h1>
    <p>That page is not available.</p>
    <a routerLink="/">Go to Trivia</a>`,
})
export class NotFound {}
