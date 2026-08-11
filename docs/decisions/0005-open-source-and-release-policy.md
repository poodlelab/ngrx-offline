# ADR-0005: Open-source and release policy

- Status: Accepted
- Date: 2026-08-10

## Context

The library will be publicly consumed from npm and requires predictable
licensing, contribution, versioning, and artifact-verification practices.

## Decision

Use the MIT license and copyright attribution to NgRx Offline contributors.
Follow semantic versioning independently of Angular and NgRx. Use Changesets
for release intent and changelogs. Publish public packages with npm provenance
through trusted publishing when credentials become available.

Every release candidate must pass formatting, linting, strict type checking,
unit tests, the framework compatibility matrix, Angular package build, API
report checks, package linting, type-resolution analysis, and installation of
the packed tarball in a clean consumer fixture.

## Consequences

- Release intent is reviewable in pull requests.
- Public API drift fails CI unless the committed report is deliberately updated.
- npm organization setup and trusted-publishing configuration remain external
  prerequisites for the first publication.
