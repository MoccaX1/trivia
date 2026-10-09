# Trivia Game Programming Principles

Minimum rules that prevent maximum engineering debt.

These rules apply to AI-assisted implementation and refactoring, primarily through
Codex CLI, and equally to Codex, Gemini, Claude, and other coding models. Model
output is a proposal; repository evidence and verification establish correctness.
This document governs engineering decisions, not coding style or delivery order.

## Design authority and M1 constraints

[System design](system-design.md) is the architectural source of truth.
[LLD](low-level-design.md) defines runtime contracts;
[database design](database-design.md) defines durable constraints and queries;
[components](HLD_Component_Diagram.md) and [data flows](Data_Flow_Diagram.md)
provide complementary views. Preserve approved contracts and domain invariants;
this document does not replace or extend them.

- Preserve the modular monolith: one backend process and one authoritative
  in-memory owner per active Match. PostgreSQL stores identity and completed
  History, not live gameplay authority.
- Keep responsibilities explicit: Gateway validates transport and resolves trusted
  Player identity; Coordinator orders ingress, serializes commands, and handles
  idempotency; Engine alone validates and mutates gameplay; Timer schedules through
  Coordinator; Presenter emits safe projections; application hands immutable
  completion to Persistence; History authorizes committed reads.
- Keep framework and infrastructure details outside the domain. Do not duplicate
  gameplay authority in clients, Gateway, Coordinator, timers, or database logic.
  Required transport validation, completion validation, and SQL constraints protect
  their respective boundaries; they do not become alternative gameplay engines.
- Preserve exclusive ingress-time deadlines, ordered player/timer commands,
  attempt/no-op rules, exact integer scoring and shared ranks, versioned safe
  snapshots, answer secrecy, terminal immutability, atomic completion, and
  self-contained historical snapshots. Consult the designs for exact contracts;
  do not derive new rules from this abbreviated list.
- Do not implement open/deferred policies or speculative infrastructure. This
  includes Host departure, active reconnect, enabled early-close policy, external
  History cursor policy, Redis/brokers, distributed ownership, active recovery,
  and durable workers. If a task depends on an unresolved decision, identify it
  and obtain an approved decision before implementing that part. Architectural
  changes require updating the authoritative design and affected contracts first.

## Engineering rules

1. **Apply KISS, YAGNI, DRY, and SOLID pragmatically.** Keep the solution simple;
   build only approved behavior; share genuine repeated knowledge; assign cohesive
   responsibilities and depend on established ports. Similar-looking code alone
   does not justify extraction. Do not add interfaces, inheritance, generic
   frameworks, or extension points merely to satisfy an acronym.

2. **Keep cohesion high and coupling low.** Put behavior with its owner, encapsulate
   mutable state, and cross modules through established contracts. Keep one source
   of truth for each rule or fact. Separate domain state, transport DTOs, and
   persistence models where their responsibilities differ; do not force them into
   a universal model or create independently maintained authorities.

3. **Understand before editing.** Read the relevant designs, implementation,
   callers, tests, configuration, and repository instructions. Verify file paths,
   APIs, dependencies, commands, and assumptions against current evidence. Never
   invent missing code or treat stale conversation context as repository fact.
   Record material uncertainty and resolve it before dependent edits.

4. **Choose the simplest correct solution.** Satisfy the complete contract,
   including failure and boundary behavior. Simplicity does not excuse omitted
   validation, transactions, authorization, or ordering. Justify added dependencies,
   abstractions, caches, indexes, and infrastructure with a current requirement or
   measured problem; use existing mechanisms when they fit.

5. **Fix root causes.** Reproduce the failure or capture concrete evidence, trace
   it to the responsible boundary, and test a specific causal hypothesis. Correct
   the violated assumption at its owner. Do not scatter guards, delays, retries,
   or unrelated edits until symptoms disappear. If a workaround is unavoidable,
   state its reason, limits, and removal condition; do not claim root-cause closure.

6. **Replace obsolete implementations cleanly.** Update affected callers and remove
   superseded code, wiring, flags, dependencies, and tests made obsolete by the
   change. Do not stack a second implementation beside the first. Keep parallel
   paths only for an explicitly required compatibility or migration contract,
   with a clear selection rule and removal condition.

7. **Keep changes small, cohesive, and scoped.** Change what the task and its
   correctness require. Preserve unrelated behavior, public contracts, and module
   boundaries. Separate incidental cleanup from necessary removal. Do not expand
   a fix into a redesign or introduce product requirements. Respect existing user
   changes; never overwrite or revert them to simplify the task.

8. **Make failures diagnosable.** Preserve stable error outcomes and useful safe
   context; distinguish expected rejection from invariant or infrastructure failure.
   Never swallow errors, silently substitute success, or mask invalid internal state
   with defaults. Validate at trust boundaries and invariant owners, rather than
   repeatedly defending against impossible states. Retry only when the established
   contract and failure justify it; preserve idempotency and conflict detection.
   Diagnostics must not leak secrets/answer keys or block gameplay.

9. **Test meaningful behavior.** Assert outcomes, invariants, boundary conditions,
   and regressions at the responsible layer. Use controlled time for gameplay;
   integration tests must exercise real transport/database guarantees when relevant.
   Check unchanged state for rejections/no-ops. Avoid tests that merely mirror code,
   mock away the property under test, or count calls without proving a contract.
   Do not weaken assertions to accept a defect. Scale verification to the change;
   document edits do not require application tests.

10. **Review cumulative complexity.** Inspect the resulting implementation, not
    just added lines. Remove task-related dead code, duplication, patch residue,
    and competing paths. Ask whether repeated fixes indicate the wrong ownership
    or abstraction. Refactor within scope when it reduces demonstrated complexity;
    propose broader work separately instead of silently undertaking it.

## Implementation workflow

**Understand → Plan → Implement → Verify → Review → Complete**

- **Understand:** Establish the requested behavior, evidence, owning component,
  affected contracts, and open decisions. For a bug, establish a reproduction.
- **Plan:** State the smallest cohesive change, acceptance criteria, relevant
  invariants, and verification. Identify any justified complexity or blockers.
- **Implement:** Change the authoritative path and affected callers; remove its
  obsolete implementation. Avoid unrelated edits and speculative facilities.
- **Verify:** Run relevant repository checks and meaningful behavioral tests.
  Inspect failures before further edits. Report exact checks and limitations;
  never claim unrun checks passed.
- **Review:** Inspect the full diff and resulting paths. Does each addition serve
  the requirement? Is there one authority? Are unrelated contracts preserved?
  What complexity or obsolete code remains? Do affected docs match the result?
- **Complete:** Summarize behavior changed, evidence, and remaining limitations.
  Resolve required work or explicitly report it incomplete; do not conceal gaps.

## Definition of Done

For every task, the change is scoped, reviewed, and consistent with approved design;
relevant checks pass; obsolete affected artifacts are removed; affected documentation
is accurate without inventing policy. A required decision or missing verification
must be reported and prevents an unqualified claim of completion.

| Change | Additional completion criteria |
|---|---|
| Feature | Approved acceptance criteria work through the required boundaries, including rejection/failure behavior; relevant invariants and authorization are verified; no open/deferred capability is silently enabled. |
| Bug fix | Evidence identifies the cause; the owning path is corrected; a regression test fails before and passes after the fix where executable; relevant adjacent/boundary behavior is preserved. An unresolved workaround is reported as mitigation. |
| Refactoring | Intended behavior and contracts remain unchanged; relevant verification demonstrates equivalence; callers use the replacement; superseded paths are removed; resulting cohesion or complexity improvement is concrete. |
