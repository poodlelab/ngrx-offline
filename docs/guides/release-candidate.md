# Release-candidate validation

The release gate treats the package as an external artifact rather than a
workspace-only library.

## Supported framework line

| Dependency | Supported release line | CI coverage             |
| ---------- | ---------------------- | ----------------------- |
| Angular    | `^21.0.0`              | 21.0 and current 21.2   |
| NgRx       | `^21.0.0`              | 21.0 and current 21.1   |
| RxJS       | `^7.8.0`               | 7.8                     |
| Node.js    | 20.19, 22.12, or 24    | all three release lines |

Angular 22 is intentionally deferred until the matching stable NgRx release is
available and the full browser guarantee suite passes unchanged.

## Browser contract

Foreground replay is the correctness baseline in stable Chrome, stable Edge,
Firefox, and Safari/WebKit. The Playwright suite also exercises Chromium and
WebKit mobile profiles with touch input. It proves reload recovery, relational
ID mapping, idempotent recovery after a lost response, stale-claim recovery,
single execution across tabs, operation migrations, scope isolation, conflict
repair, quota failures, cancellation races, authentication pauses, and worker
receipts.

Web Locks and Background Sync are capabilities, not correctness requirements.
An IndexedDB lease serializes executors when Web Locks is unavailable.
Background Sync is asserted in Chrome; every browser retains foreground replay
and explicit worker-message fallback.

## Public API maturity

Every exported symbol is explicitly marked `@alpha`. There are no stable or
beta promises in the release-candidate surface. The committed reports under
`etc/` are the reviewable API contract, and `pnpm api:check` fails on accidental
drift. Secondary entry points re-export the core contract types needed to use
their APIs, so the reports contain no forgotten exports.

The entry points are:

- `@poodlelab/ngrx-offline` for Angular and NgRx integration;
- `@poodlelab/ngrx-offline/core` for the framework-independent engine;
- `@poodlelab/ngrx-offline/indexeddb` for browser persistence and locking;
- `@poodlelab/ngrx-offline/worker` for optional worker replay;
- `@poodlelab/ngrx-offline/testing` for deterministic tests.

Promotion from `@alpha` requires external evaluation and a deliberate API
report update. It is not implied by the first npm publication.

## Package gates

`pnpm package:verify` validates the actual npm tarball. It runs package lint and
type-resolution analysis, checks every export-map type and ESM target, confirms
`sideEffects: false`, detects Angular partial compilation, and proves the core
and worker bundles contain no Angular or NgRx imports. It rejects tests,
fixtures, development-secret markers, and files outside the package allowlist.

The same tarball is installed into clean minimum-peer and current-peer Angular
consumers. A core-only browser bundle must remain below 20 kB and must not pull
Angular or NgRx into its dependency graph.

## Performance budgets

Release-candidate tests enqueue and drain 1,000 operations across eight lanes
within a conservative 10-second CI budget. They also hydrate a payload-free
NgRx/DevTools projection of 5,000 operations within 1.5 seconds. These are
regression ceilings, not throughput promises; IndexedDB, transport latency, and
device performance dominate real applications.

The NgRx projection intentionally excludes operation inputs and response
payloads. Full durable records remain in IndexedDB, avoiding large or sensitive
payload duplication in Redux DevTools.

## Reproduce the candidate checks

```bash
pnpm check
pnpm test:e2e
```

CI installs stable Chrome and Edge plus Playwright Firefox, WebKit, Chromium,
and mobile-emulation runtimes. Local Edge can be supplied with
`NGRX_OFFLINE_EDGE_PATH` when a system-wide Edge installation is unavailable.
