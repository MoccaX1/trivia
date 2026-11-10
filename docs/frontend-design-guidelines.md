# Trivia Frontend Design Guidelines

## Authority and scope

**Direction: Trivia — Modern Minimal Product UI.** This is the authoritative
design reference for the future standalone Angular SPA in `frontend/`.
It establishes presentation rules before bootstrap; it does not create an app,
choose an Angular version, or change backend architecture or gameplay.

[API contract](api-contract.md) owns actual HTTP and Socket.IO integration.
[System design](system-design.md) owns architecture and M1 requirements;
[low-level design](low-level-design.md) owns runtime contracts;
[database design](database-design.md) owns durable constraints. Follow
[programming principles](programming-principles.md) and the
[known-issues registry](known-issues.md). These guidelines do not override them.
The approved backend uses Fastify; older NestJS references are not setup guidance.

Mandatory directions below are design decisions. All numeric design-token values
and token names proposed below are **provisional examples**, to validate with real
content and accessibility checks. No final brand palette or pixel-perfect screen
design is approved here.

## Product philosophy and visual language

Take primary inspiration from the clarity, typography, precision, and purposeful
whitespace of Apple's product website, with secondary inspiration from Microsoft's
product website. Translate those qualities into Trivia's own identity; do not
copy their branding, assets, layouts, or effects. No Apple-specific skill or
proprietary font is required.

Trivia should feel like a polished consumer product. Use a focused page hierarchy,
plain language, calm colors, solid surfaces, consistent controls, and careful
alignment. Avoid the persistent sidebars, metric tiles, dense toolbars, and nested
cards associated with enterprise administration dashboards.

Minimalism means every element supports a task. Never remove question context,
submission feedback, connection status, accessibility cues, or useful results to
create visual emptiness. During gameplay, comprehension and timely selection take
priority over marketing composition.

## Layout, spacing, shape, and elevation

- Use a shared mobile-first content grid: consistent page gutters, a centered
  maximum-width content region, and aligned headings, controls, and content edges.
  Use CSS Grid for page/choice layouts and Flexbox for small aligned groups.
- Group related information through proximity and whitespace before adding a
  container. Distinguish within-control, within-group, between-group, and
  page-section spacing through shared tokens; avoid arbitrary component values.
- Keep a focused reading column. Gameplay should keep the question, choices,
  timer, progress, and submission status near each other. Secondary standings
  must not push answer choices below the initial viewport unnecessarily.
- Let content determine height. Wrap long questions, names, and choices; do not
  truncate essential content, shrink text to fit, or enforce a fixed-height screen.
  Scrolling remains available when text scaling or content length requires it.
- Use a small radius scale and restrained one-level elevation. Prefer borders or
  spacing for grouping; reserve a subtle shadow for meaningful separation, such
  as a dialog. Avoid nested cards, pill-shaped panels, and stacked shadows.

Provisional layout examples: page gutters `1rem` growing to `2rem`; broad content
width `72rem`; focused question column `48rem`. Validate rather than impose them
as final screen dimensions. Use content-driven breakpoints in relative units,
adding columns only when readable content and adequate targets fit.

## Typography

Use a modern system stack, for example
`system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`.
This uses available system fonts; do not require or distribute proprietary Apple
fonts or download a font merely to imitate another product.

Use a limited type scale, expressed in `rem`, and regular, medium, and semibold
weights as needed. Establish these consistent roles:

| Role | Treatment |
| --- | --- |
| Page title | Strongest page-level heading; landing pages may be more expansive |
| Question | Primary gameplay heading; readable at a glance and allowed to wrap |
| Answer choice | Comfortable body-sized or larger text with equal visual weight across choices |
| Labels and body | Clear, stable sizing; labels remain visible outside inputs |
| Metadata | Subordinate through placement and weight without becoming faint or tiny |
| Timer, score, progress | Legible numerals; use tabular numerals where supported to reduce movement |

Provisional scale: `0.875rem`, `1rem`, `1.25rem`, `1.5rem`, `2rem`, `3rem`.
Use approximately `1.5` body line height and `1.2–1.3` heading line height;
allow more space for multiline questions. Aim for roughly `45–75ch` in prose.
Avoid all-caps paragraphs, decorative type, excessive weight changes, and large
typographic jumps inside gameplay. Never use a smaller size to conceal long text.

## Colors, surfaces, and themes

Use a small semantic palette: page background, surface, border, primary action,
primary-action text, main text, muted text, and success/warning/error/information.
Provide paired foreground/background roles where needed. Brand hue selection
remains open; this document approves no literal color palette.

All UI surfaces must be solid and opaque. Keep color accents limited to actions
and meaningful state. Distinguish selected, pending, correct, incorrect, and
unanswered states with text and a visible non-color cue such as a checkmark,
border treatment, or state label. Icons must not require guessing their meaning.
Muted text still needs adequate contrast. Verify status, hover, focus, selected,
and error combinations in each supported theme.

Support light and dark themes architecturally through semantic CSS custom
properties and a small root-level theme override. Components consume roles rather
than hard-coded light/dark colors. Theme preference, default, and any user-facing
switch remain scope-discovery decisions. Do not build a theme service, persistence
scheme, or customization UI before a demonstrated need. Never simulate a dark
theme by reducing opacity or inverting the rendered page.

## Interaction and feedback

| Element or state | Required behavior |
| --- | --- |
| Buttons | Use native buttons for actions and links for navigation. Give the primary action the clearest emphasis; label actions specifically. Provide consistent hover, active, focus, disabled, and pending treatments. |
| Inputs | Use persistent labels, appropriate input types/autocomplete, and associated help/error text. Preserve entered values after recoverable errors. Do not alter passwords or infer new validation policy. |
| Answer choices | Make the entire labeled target selectable with consistent spacing. Distinguish local intent, pending submission, and server-confirmed selection. Explain the answer-change/attempt rule without introducing new gameplay rules. |
| Loading | Use a brief textual loading state or stable placeholder appropriate to the task. Reserve space to avoid layout shifts; never fabricate percentage progress. |
| Pending operation | Identify the action in progress and prevent accidental duplicate intent. Keep unrelated usable controls available. A timeout becomes an unknown outcome rather than an automatic failure. |
| Success | Confirm the actual supported outcome near the initiating control. Persistent state should remain understandable after a transient notice disappears. |
| Failure | Explain the failure in plain language and provide a supported next action. Keep local input and confirmed state; do not silently replace either with invented success. |
| Disabled control | Give a visible reason when it is not obvious, such as waiting for another player. Do not rely on low opacity or a hover-only tooltip to explain it. |
| Empty state | State what is empty and offer an available next step. Distinguish no History from loading, unavailable storage, or an inaccessible result. |
| Confirmation dialog | Use only for a consequential supported action needing confirmation. Name the consequence and action; avoid routine confirmation for answers or navigation. Never imply that closing a page cancels or leaves an active Match. |
| Focus and keyboard | Keep logical DOM order, visible focus, and native keyboard behavior. Preserve focus during pending operations; after navigation/dialog closure place it at a sensible heading or initiating control. |

For answers, choose native semantics to match the eventual submission flow.
A staged single-choice form can use labeled radios within a fieldset; do not
attach network submissions to mere focus movement. If activation submits
immediately, labeled buttons with an exposed selection state may be more suitable.
Decide that flow during scope discovery and verify keyboard behavior; do not mix
radio selection, focus, and server acceptance into one ambiguous state.

During `QUESTION_OPEN`, prioritize the question, equal answer targets, a compact
timer/progress area, and the viewer's submission state. Do not reveal correctness
early. During `REVEAL`, clearly label the correct answer, the viewer's accepted
choice or no answer, and the server-provided result. During `FINISHED`, show final
standings, shared winners where applicable, and access to History without extra
metric panels. A local animation never confirms a backend change.

## Responsive behavior by task

Design mobile-first and validate desktop and tablet layouts as first-class cases.
Use available width and content needs rather than device names as breakpoints.
Preserve a stable reading and keyboard order when columns change.

| Area | Responsive priorities |
| --- | --- |
| Landing and login | Product-oriented composition may use larger titles and more whitespace. Keep sign-in easy to find and form fields usable with the on-screen keyboard. Do not promise registration or account recovery absent from M1. |
| Lobby | Prioritize Match identity, player list, Host controls, connection status, and supported join/leave actions. Allow long IDs/names to wrap without displacing the main action. |
| Gameplay | Stack choices on narrow screens; add columns only when text and touch targets remain comfortable. Keep timer, question progress, and submission state visible near the question. Reduce secondary material before reducing readability. Avoid unnecessary timed scrolling. |
| History | Use scannable Match summaries, readable final standings, and ordered question review. Provide accessible navigation through results and pagination; do not require wide tables for essential information. |

Avoid horizontal page scrolling. Sticky elements are optional and must not obscure
focus, answers, or zoomed content; prefer normal flow if they crowd a small viewport.
Test narrow screens, landscape, long content, text enlargement, and touch input.

## Motion

Use short native CSS transitions for feedback and continuity, such as a restrained
opacity change or small positional/scale transition. Provisional timing tokens:
`120ms` for control feedback and `180ms` for a simple transition with `ease-out`.
Animate explicit properties; avoid `transition: all` and layout shifts.

Respect `prefers-reduced-motion: reduce` by removing nonessential animation and
transforms and making state changes immediate. Replace animated loading indicators
with understandable static/text feedback where necessary. Never remove feedback
itself. Avoid continuous decoration, parallax, spring/bounce, cinematic page
transitions, flashing urgency, and animation libraries without demonstrated need.

Never delay answer availability, server-state rendering, focus, or phase changes
to finish animation. Do not animate countdowns or scores in ways that obscure their
current value. Time-sensitive gameplay must remain usable with all motion removed.

## Accessibility expectations

Target **WCAG 2.2 AA where applicable**. Accessibility is part of visual quality;
these guidelines are not a claim of implemented or verified compliance.

- Use semantic landmarks, a logical heading hierarchy, native controls, and
  descriptive accessible names. Prefer HTML semantics before custom ARIA.
- Support every action by keyboard without traps or pointer-only/hover-only
  content. Ensure visible focus in both themes and keep focused controls
  unobscured. Provide a skip link when repeated navigation warrants it.
- Meet at least `4.5:1` contrast for normal text and `3:1` for qualifying large
  text; meaningful control boundaries and state indicators need `3:1` against
  adjacent colors where applicable. Review focus styling separately. Disabled
  controls must still be understandable even where contrast exceptions apply.
- Aim for touch targets at least `44 × 44` CSS pixels. Meet the WCAG 2.2 AA
  `24 × 24` CSS-pixel minimum or its applicable spacing/other exceptions; large
  answer targets should not depend on exceptions.
- Associate instructions and errors with fields. Announce asynchronous failures
  and important status changes with appropriate live regions; use assertive
  announcements sparingly. Do not steal focus for routine updates.
- Expose selected, disabled, pending, and revealed states programmatically and
  visually. Use text alongside color/icons, and accessible names for icon-only
  controls. Mark purely decorative icons as hidden from assistive technology.
- Announce a new question and meaningful phase/submission changes without
  re-announcing the entire page on each snapshot. Avoid live-region updates every
  countdown tick; provide readable remaining time without speech flooding.
- Support text resizing to 200% and reflow at a 320 CSS-pixel viewport where
  applicable. Do not disable browser zoom, clip text, or sacrifice content to keep
  gameplay in one viewport. Respect user text spacing and reduced motion.
- Verify manually with keyboard, zoom, touch, reduced-motion settings, and screen
  readers alongside automated checks once components exist.

Timed-game accessibility needs explicit review during scope discovery. The fixed
server window is not adjustable by frontend design. Do not assume a WCAG timing
exception or promise extended time; identify any unmet requirement for a separately
approved product/backend decision. The broader accessibility scope remains open
in the registry; this task establishes frontend expectations without changing rules.

## Angular styling architecture and tokens

**Use SCSS + Modern CSS.** Keep presentation primarily in each component's SCSS
file with Angular's default Emulated style encapsulation. No Angular app/version
exists yet; choose version-dependent APIs at bootstrap, not in these guidelines.

- Use semantic class names describing the component's parts and states. Keep
  templates focused on structure and behavior, with readable class/state bindings.
  Mandatory BEM naming and large utility-class chains are unnecessary.
- Keep selectors local and shallow, normally no more than two levels of nesting.
  Use `:host` for the component's own layout boundary. Do not reach into child
  internals; expose a small intentional styling interface only when needed.
- Reserve global styles for semantic tokens, theme mappings, a minimal baseline,
  and document typography. Avoid broad selectors that restyle unrelated controls
  or defeat encapsulation. Do not disable encapsulation for convenience.
- Use CSS custom properties for runtime-adjustable values, especially colors.
  Use Grid, Flexbox, logical properties, and native CSS where they simplify layout.
  Use Sass modules through `@use` only for genuine compile-time reuse; avoid
  deprecated Sass imports and abstractions for trivial declarations.
- Avoid `::ng-deep`, excessive `!important`, deep nesting, Less, Tailwind CSS,
  and duplicate styling systems. Solve ownership/specificity problems locally.

Start with a small token set, growing only from actual component needs:

| Category | Proposed examples and purpose |
| --- | --- |
| Color | `--color-background`, `--color-surface`, `--color-border`, `--color-primary`, `--color-on-primary`, `--color-text`, `--color-text-muted`, semantic status roles; theme mappings remain provisional |
| Typography | `--font-body`, `--text-body`, `--text-question`, `--text-title`, shared line-height roles; use the provisional scale above |
| Spacing | `--space-1` through `--space-6`, provisionally `0.25rem`, `0.5rem`, `0.75rem`, `1rem`, `1.5rem`, `2rem` |
| Radius | Small control/surface roles, provisionally `0.25rem`, `0.5rem`, `0.75rem` |
| Elevation | None and one subtle raised-surface shadow; exact shadow remains provisional |
| Motion | Short feedback/transition durations and easing; reduced-motion overrides |
| Focus | Ring color, width, and offset; provisionally `2px` width and `2px` offset, subject to visibility and contrast verification |

These are proposed names and values, not a token implementation or final brand
system. Define each shared value once; reference it locally. Do not create a large
token library, generated theme framework, or design-system package before real
components demonstrate the need.

## Reuse and maintainability

Favor small, cohesive, clearly named components. Extract shared presentation or
behavior when demonstrated by real use; do not wrap every HTML element or create
speculative polymorphic controls. Keep templates readable and decisions explainable.
Maintain consistency while allowing each task the layout it needs.

Keep local presentation state (focus, selection intent, pending operation) separate
from the latest authoritative snapshot. Derive confirmed views from server data
without constructing a second gameplay engine. Prefer straightforward code and
few dependencies over clever abstractions or a custom component framework.

No large UI library is required for M1. Do not add Angular Material, Ant Design,
Bootstrap, Tailwind, or another component framework by default. A focused dependency
may be evaluated later for a specific demonstrated need, including accessibility,
after assessing its behavior, styling fit, and maintenance cost.

## Backend authority and UI implications

Use the [API contract](api-contract.md) for payloads, versions, errors, privacy,
and transport configuration; do not duplicate or extend the API here.

- **Authentication:** use the approved server-managed HttpOnly session and
  credentialed requests. Do not store a bearer token or invent client identity.
  Clear viewer-private state on logout/account change and replace the authenticated
  socket appropriately. Accounts are pre-provisioned; no registration/reset UI is
  implied. Do not use silent requests to invent session keep-alive behavior.
- **Snapshots:** apply newer full viewer-specific snapshots using one version
  tracker per Match across lobby/gameplay events, scoped to the authenticated
  viewer. Ignore older/equal versions. Gaps are allowed; ACK versions must not
  advance the tracker. Do not display stale retained content as a live connection.
- **ACKs and intent:** receipts may describe historical outcomes, accepted no-ops,
  or replays. Correlate them to the initiating intent; an old ACK cannot undo a
  newer view. Pending selection is not a confirmed accepted answer. Missing ACKs
  mean unknown outcome; any explicit retry preserves the original command ID and
  payload. Do not introduce unlimited automatic retries or wait for a new version
  as the only way to resolve a no-op's pending indicator.
- **Scoring:** render supplied results and ranks. Never calculate authoritative
  awards or break ties locally. Preserve exact decimal-string score units; avoid
  unsafe numeric conversion. Human-facing decimal formatting remains deferred
  (DEF-005); choose no rounding/points convention in this document.
- **Timers:** client countdowns present server deadlines and may be affected by
  clock skew. Zero does not change phase, reveal correctness, or guarantee that an
  answer was rejected. Wait for authoritative snapshots; never add Next, Skip,
  Pause, early-close, or deadline-extension behavior absent from the contract.
- **Disconnects:** transport reconnection does not restore a subscription. M1 has
  no active-state fetch or resume operation; cached Create/Join receipts do not
  restore delivery. Present lost connection/unsupported resume clearly. Do not
  infer membership removal, Host transfer, penalties, or a reconnect workaround.
  Restart loses sessions and active Matches; committed History remains available
  after login. A stalled timer has no approved client recovery policy.
- **Completion:** `FINISHED` gives the final live outcome, not durable History
  COMMIT. Offer a participant History read/refresh without claiming “saved” from
  the snapshot. A missing result does not establish permanent loss; there is no
  commit-status event or durability deadline. Any bounded read-retry UX needs
  separate scope discovery and must not become an endless spinner.
- **Privacy:** show only fields authorized for the viewer and phase. Do not infer
  others' selections/answer status or preload future answers. History detail is
  participant-only with own private question results. A uniform not-found response
  must not identify unauthorized Matches. Render names/question text as plain
  text; do not leak private snapshots across accounts, persistent caches, or logs.

Some baseline diagrams describe future recovery or older disconnect behavior;
these are not implemented capabilities. The API contract documents current M1
limitations and ACK shorthand gaps. If a future screen needs an ambiguous or absent
capability, record the question and obtain a decision before implementing that
dependent flow; do not reinterpret a diagram as permission to redesign the backend.

## Explicitly prohibited patterns

**Liquid Glass is strictly prohibited.** This includes Apple Liquid Glass,
glassmorphism, frosted-glass panels, decorative backdrop blur, simulated glass
refraction, translucent floating glass surfaces, and heavy acrylic/glass overlays.
Renaming an equivalent effect does not make it acceptable. Dialog surfaces remain
opaque; a simple dimming scrim may separate a dialog without blur or glass effects.

Also prohibited: excessive gradients, neon-heavy palettes, decorative glows,
unnecessary floating panels, elaborate shadows, excessive rounding, decorative
motion without functional value, and dashboard-like clutter. Prefer solid
backgrounds, restrained borders/shadows, and deliberate spacing. The styling and
dependency restrictions above apply equally to shared and feature components.

## Open choices and next step

Frontend scope discovery should resolve the final brand palette, light/dark launch
coverage and preference behavior, answer activation/submission flow, score display
format, detailed navigation, and timed-game accessibility review. Confirm deployment
origins and safe connection/unknown-outcome copy against the existing contract.
Validate provisional typography, spacing, breakpoints, and shapes using real content.
These choices do not block this reference and do not authorize backend extensions.

This document is ready to guide frontend scope discovery. Bootstrap, screen designs,
dependencies, and UI implementation are separate work.

## Practical component review

- [ ] Is the primary action obvious and the hierarchy focused on the current task?
- [ ] Does the layout work across narrow/wide screens, long content, and text scaling?
- [ ] Are typography, semantic colors, spacing, and surfaces consistent?
- [ ] Are keyboard/focus, labels, contrast, targets, and all interaction states accessible?
- [ ] Is motion purposeful, reduced when requested, and harmless to timed play?
- [ ] Are Liquid Glass, equivalent glass effects, and decorative clutter absent?
- [ ] Are templates readable and component SCSS scoped, shallow, and maintainable?
- [ ] Is reuse justified by actual need, without speculative frameworks or dependencies?
- [ ] Does feedback distinguish local intent, pending/unknown outcomes, snapshots,
      and durable History while preserving privacy and server authority?
