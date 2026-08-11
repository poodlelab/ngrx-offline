# Relations, Scopes, and Multi-tab Replay

Phase 4 adds explicit relationships, independent replay lanes, operation input
migrations, scope lifecycle policies, and browser-wide coordination.

## Explicit relationships

Relationship resolution is opt-in. An operation declares every dependency and
every key it intends to produce. Its request builder can resolve only those
declared dependencies, in the operation's immutable scope.

```ts
import { defineOfflineCreate, offlineRef } from '@poodlelab/ngrx-offline';

const createTravelDay = defineOfflineCreate<CreateTravelDay, TravelDayResult>({
  kind: 'journal.travel-day.create',
  entity: 'travel-day',
  lane: () => 'journal-foundation',
  request: (input, context) => ({
    method: 'POST',
    url: '/travel-days',
    body: {
      clientId: input.clientId,
      date: input.date,
      title: input.title,
      tripId: context.resolve(input.trip),
    },
  }),
  parseResult: (response) => response.body as TravelDayResult,
});

const input: CreateTravelDay = {
  clientId: crypto.randomUUID(),
  trip: offlineRef('trip', localTripId),
  date: '2026-08-10',
  title: 'A slow morning in Alfama',
};
```

The tagged `trip` reference is discovered automatically anywhere in the input.
The `entity` plus conventional `clientId` input and `id` result derive both the
pre-execution producer key and the successful ID mapping. No relationship is
hidden in a URL or inferred from an arbitrary string.

The derived dependency and produced-key lists are stored with the operation. A
missing producer blocks with `missing_dependency`; a blocked producer blocks
its child with `dependency_failed`; and a live producer keeps its child visibly
waiting. Successful mappings are written atomically with the receipt and are
keyed by both scope and reference key.

For an unusual input, override discovery explicitly:

```ts
defineOfflineCreate({
  // ...
  dependencies: (input) => customReferences(input),
  clientId: (input) => input.localKey,
  serverId: (result) => result.serverKey,
});
```

## Lanes and bounded concurrency

FIFO is strict within a lane. A blocked or delayed lane head prevents later
operations in that lane from overtaking it. Lane heads from other lanes remain
eligible and can execute concurrently:

```ts
provideOfflineOutbox(() => ({
  databaseName: 'travel-journal-outbox',
  mutations,
  scope: () => activeWorkspace.id,
  maximumConcurrentLanes: 3,
}));
```

Selection is always `createdAt`, then operation ID. The default concurrency is
one, preserving the original single-lane behavior unless an application opts
in.

## Scope-aware credentials and logout

The enqueue scope is copied into the durable record and never inferred again.
Angular interceptors can select current credentials compatible with that scope
using `OFFLINE_HTTP_SCOPE` from the request's `HttpContext`.

Configure `logoutPolicy` as:

- `preserve` (default): retain and pause the signed-out scope.
- `prompt`: emit `OfflineOutboxActions.logoutConfirmationRequired` while work
  exists; dispatch `logoutScope({ scope, confirmed: true })` after consent.
- `discard`: delete that scope's operations, receipts, mappings, and pause
  metadata.

`selectOfflineCountsByScope` and `selectOfflineCountsForScope(scope)` expose
payload-free pending and blocked counts for account/workspace switch UI.

## Cross-tab ownership

Foreground replay uses a lock key containing the immutable scope. Native Web
Locks provide browser-wide mutual exclusion. If Web Locks are unavailable, a
transactional IndexedDB lease is acquired, renewed, expired, and released from
the shared metadata store. Individual executing-operation claims are renewed
independently, so a long request stays owned; an abandoned claim becomes
eligible after its expiry.

## Input migrations

Persisted inputs migrate through explicit, pure forward steps before claiming:

```ts
migrations: [
  { fromVersion: 1, toVersion: 2, migrate: renameLegacyField },
  { fromVersion: 2, toVersion: 3, migrate: addRequiredDefault },
];
```

Each completed chain is stored transactionally with its new version, input,
lane, dependencies, and produced keys before transport runs. A missing path,
future stored version, thrown migration, or non-JSON result blocks the operation
without discarding it.
