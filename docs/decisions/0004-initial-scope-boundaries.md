# ADR-0004: Initial scope boundaries

- Status: Accepted
- Date: 2026-08-10

## Context

The initial design leaves attachment timing, receipt retention, diagnostic
retention, and IndexedDB API exposure open. These decisions affect package
shape and data-loss behavior.

## Decision

- Publish the IndexedDB adapter through `/indexeddb` so non-Angular consumers
  can compose it with `/core`.
- Reserve the attachment object-store boundary, but defer Blob attachment APIs
  and transports until after 1.0 unless core use cases prove they are required.
- Never expire unconsumed completion receipts automatically. Delete a receipt
  only after acknowledged consumption.
- Do not persist a separate long-lived consumed-receipt history in v1.
- Retain sanitized demo API diagnostics for no more than 30 days.

## Consequences

- The IndexedDB adapter is part of the supported public surface.
- The first release stays focused on JSON-compatible mutations.
- Correctness takes priority over automatic cleanup of unconsumed receipts;
  storage-health reporting must make unusual accumulation visible.
- Rich historical diagnostics remain an application or telemetry concern.
