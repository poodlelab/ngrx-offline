# ADR-0001: Package and repository structure

- Status: Accepted
- Date: 2026-08-10

## Context

The travel day needs framework-independent runtime code, Angular/NgRx integration,
worker support, deterministic test utilities, a showcase, and a reference API.
Consumers should not need to coordinate versions across several npm packages.

The repository belongs to the `poodlelab` GitHub organization. A package name
should communicate that ownership and leave room for secondary entry points.

## Decision

Publish one package named `@poodlelab/ngrx-offline` with these entry points:

- the primary Angular and NgRx adapter;
- `/core` for framework-independent contracts and the replay engine;
- `/indexeddb` for browser persistence;
- `/worker` for worker-safe execution;
- `/testing` for deterministic utilities.

Use an Angular CLI workspace with Angular Package Format and partial
compilation. Keep the showcase and reference API in the same repository so
changes to client, server contract, documentation, and browser tests can be
reviewed together.

## Consequences

- Consumers install and version one package.
- All entry points share a release cadence.
- Package-level Angular and NgRx peers apply even to consumers importing only
  `/core`; the source and emitted `/core` bundle must nevertheless remain free
  of Angular and NgRx code.
- The `@poodlelab` npm organization must exist or be made available before the
  first publish.
