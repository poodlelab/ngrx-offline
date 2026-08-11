# Reference API contract

This directory contains the normative contract for the public travel-journal
demo API. It is designed to prove the delivery guarantees of
`@poodlelab/ngrx-offline`; it is not part of the library's public API.

## Contract sources

- [Domain model and offline relationships](./domain-model.md)
- [HTTP, idempotency, concurrency, and errors](./http-semantics.md)
- [Demo workspace isolation, retention, quotas, and CORS](./demo-workspaces.md)
- [Deterministic failure controls](./failure-simulation.md)
- [Acceptance cases](./acceptance-cases.md)
- [OpenAPI 3.1 definition](./openapi.yaml)
- [Generated JSON Schemas](./schemas.json)

The runtime schemas are defined in
[`apps/demo-api/src/contracts.ts`](../../apps/demo-api/src/contracts.ts).
`schemas.json` is generated from that source and must not be edited manually.
The Worker implementation, D1 migration, local setup, and deployment procedure
are documented in the
[`apps/demo-api` README](../../apps/demo-api/README.md).

## Validation

```bash
pnpm contract:generate
pnpm contract:check
pnpm test:contracts
```

`contract:check` fails when the generated schema is stale, when an OpenAPI
reference is unresolved, or when the description violates the configured API
rules.
