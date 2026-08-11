# Browser end-to-end tests

Playwright is configured at the repository root. The foreground replay scenario
uses the built package in stable Chrome and Edge plus Playwright Chromium,
Firefox, and WebKit contexts to queue while offline, reload, restore optimistic
state, and synchronize using the same idempotency key. Chromium and WebKit
mobile profiles exercise the responsive navigation with touch input.

The Chromium production-build suite also proves that a worker can drain the
related outbox after its page closes, that a reopened app consumes the durable
receipts, and that foreground/worker contention does not duplicate delivery.

The hardening scenarios cover response-loss idempotency, stale-claim recovery,
definition migrations, scope and reference isolation, 409/412 repair, quota
exhaustion, cancellation races, authentication pause/resume, and the IndexedDB
lock fallback. Background Sync is capability-specific and asserted only in
stable Chrome; foreground correctness runs across the complete matrix.
