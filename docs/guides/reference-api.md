# Reference API operations

The reference API is a Cloudflare Worker backed by D1. It gives every anonymous
showcase visitor a separate, expiring data pool and supplies the numeric IDs,
idempotent mutation behavior, ETags, and deterministic failures needed to teach
offline synchronization.

## Workspace capability

The browser generates a UUID v4 workspace ID and 32 random bytes encoded as
base64url. It registers that pair with `POST /v1/demo-workspaces`, then sends:

```http
Authorization: Bearer <workspace-id>.<secret>
```

The server stores only a keyed hash of the capability. Keep the raw capability
out of NgRx DevTools, logs, URLs, and operation payloads. A matching pair can
recover an existing workspace; a different secret for the same UUID receives a
generic conflict.

## Offline relation sequence

The showcase queues Trip, Travel Day, Place Visit, Memory, and Day Reflection
creates with client UUIDs. The API assigns positive numeric IDs. After a parent
response arrives, the library's explicit reference resolver substitutes that
server ID into dependent queued operations before dispatching them. The server
never infers or rewrites those references.

Every mutation sends a UUID `Idempotency-Key`. Updates also send the entity's
strong ETag through `If-Match`. An equivalent retry replays the original status,
body, `Location`, and ETag; reuse for a different request returns `409`.
Mutation and receipt persistence are one D1 transaction.

## Operating the service

The implementation, configuration table, local commands, deployment sequence,
and privacy warnings live in the
[`apps/demo-api` README](../../apps/demo-api/README.md). The complete API surface
is in the [server contract](../server-contract/README.md).

The principal verification commands are:

```bash
pnpm test:api
pnpm contract:check
pnpm typecheck:contracts
```

The Worker exposes unauthenticated `/v1/health` and `/v1/version` probes.
Everything that reads or changes demo data requires a workspace capability.
The scheduled cleanup removes expired pools; the reset endpoint clears one
authenticated pool while retaining its capability.

## Failure laboratory

Workspace-scoped controls can arm one operation key for a timeout,
commit-with-lost-response, or forced `409`, `412`, `422`, or `500`. A diagnostic
endpoint reports deliveries and logical mutations for that key, allowing a
browser test to prove that a lost response followed by a retry still produces
one mutation. Controls cannot observe or alter another workspace.
