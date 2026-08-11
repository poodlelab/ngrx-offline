# ADR-0002: Compatibility and browser support

- Status: Accepted
- Date: 2026-08-10

## Context

Angular 22 is stable, while the matching NgRx 22 line is still prerelease. The
latest mutually compatible stable release line is Angular 21 and NgRx 21.
Durable storage and cross-context coordination also require a clear browser
policy.

## Decision

Start with Angular 21.2.x, NgRx 21.1.x, RxJS 7.8.x, TypeScript 5.9.x, and Node
22.12 for primary development and CI.

Published peers accept Angular 21 and NgRx 21. CI covers minimum supported
peers, current peers, and current peers on supported Node release lines. Move to
Angular 22 and NgRx 22 after both are stable and the same browser guarantees
pass.

Support the browser set defined by Angular's Baseline policy for the supported
Angular major. Foreground execution is mandatory in every supported browser.
Web Locks is the primary coordination mechanism, with an IndexedDB lease
fallback required for the first alpha to cover capability gaps and restricted
contexts.

## Consequences

- The first alpha uses stable dependencies rather than NgRx release candidates.
- The compatibility matrix expands when another Angular/NgRx major is added.
- Background Sync remains capability-enhanced behavior and is never required
  for correctness.
- Maintaining a lock fallback costs implementation effort but makes the core
  coordination guarantee independent of Web Locks availability.
