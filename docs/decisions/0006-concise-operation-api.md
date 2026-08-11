# ADR-0006: Concise operation-definition API

- Status: Accepted
- Date: 2026-08-11

## Context

The replay engine must persist a stable kind and version, dependency keys, and
the keys an operation can produce. After success it must persist the matching
client-to-server ID mappings. Requiring every consumer to declare each engine
phase separately made correct create operations repetitive and made the first
example look harder than the underlying workflow.

Offline references are already tagged JSON values, and the dominant create
shape uses a string `clientId` in the input and a string or numeric `id` in the
result. These conventions provide enough information to derive the repetitive
metadata without weakening the durable record.

## Decision

Keep `OfflineOperationDefinition` as the explicit engine contract and
`defineOfflineOperation` as its advanced public helper. Make its version default
to 1 and automatically collect unique tagged offline references from operation
input unless dependency discovery is overridden.

Add `defineOfflineCreate` as the primary create-operation helper. It accepts an
entity name and derives:

- the producer key before execution;
- the successful client-to-server ID mapping;
- the default client ID from `input.clientId`;
- the default server ID from `result.id`.

Custom ID shapes use explicit `clientId` and `serverId` selectors. Migration,
lane, parsing, retry, and dependency overrides remain available. NgRx mutation
bindings default their display source so `createOfflineMutation(definition)` is
the normal form.

## Consequences

- Common relational create operations declare each fact once.
- Stored operations and replay semantics remain unchanged.
- Dependency discovery is deterministic and worker-safe because it only walks
  already JSON-compatible input and recognizes tagged references.
- Applications with unusual dependency or ID rules retain the explicit API.
- The showcase and introductory documentation use the concise API; low-level
  producer callbacks are documented as an escape hatch rather than the
  starting point.
