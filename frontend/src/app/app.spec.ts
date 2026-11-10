import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { App } from './app.js';
import { routes } from './app.routes.js';

describe('foundation routing and shell', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideRouter(routes)] }));
  it('renders the foundation and redirects unknown application paths', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/');
    expect(harness.routeNativeElement?.textContent).toContain('Frontend foundation ready');
    await harness.navigateByUrl('/unknown-page');
    expect(harness.routeNativeElement?.querySelector('h1')?.textContent).toContain('curiosity');
  });
  it('provides a skip target and named home link without feature forms', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.skip-link')?.getAttribute('href')).toBe('#main-content');
    expect(element.querySelector('main')?.id).toBe('main-content');
    expect(element.querySelector('a[aria-label="Trivia home"]')).not.toBeNull();
    expect(element.querySelector('form')).toBeNull();
  });
});
