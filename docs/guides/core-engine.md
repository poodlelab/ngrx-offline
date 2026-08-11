# Deterministic Core Engine

The worker-safe operation state machine is available through
`@poodlelab/ngrx-offline/core` and deterministic fakes through
`@poodlelab/ngrx-offline/testing`. Neither entry point imports Angular or NgRx.

## Define and enqueue an operation

Definitions have stable, globally unique kinds and positive integer versions.
Inputs and successful results must be JSON-compatible.

```ts
import {
  ReplayEngine,
  createOperationRegistry,
  defineOfflineCreate,
} from '@poodlelab/ngrx-offline/core';

const createTrip = defineOfflineCreate<
  { clientId: string; name: string },
  { id: string; clientId: string; name: string }
>({
  kind: 'travel-journal.trip-create',
  entity: 'trip',
  request: (input) => ({
    method: 'POST',
    url: '/trips',
    body: input,
  }),
  parseResult: (response) => response.body as { id: string; clientId: string; name: string },
});

const registry = createOperationRegistry(createTrip);
// Supply repository, transport, lock, clock, UUID, random, connectivity,
// scheduler, and event ports when constructing ReplayEngine.
declare const engine: ReplayEngine;

await engine.enqueue(
  createTrip,
  { clientId: crypto.randomUUID(), name: 'Ada Services' },
  { scope: 'demo-pool-id' },
);
await engine.replay('demo-pool-id');
```

The concise helper defaults to version 1 and derives the client-to-server ID
mapping from conventional `clientId` and `id` properties. Use
`defineOfflineOperation` when an operation does not create an entity or needs
fully custom producer metadata.

The repository commit finishes before `queued` is emitted. Each transport call
receives the operation UUID as `Idempotency-Key`. A successful completion writes
its receipt before `succeeded` is emitted, and receipts remain available until
the consumer acknowledges them.

## Deterministic tests

`EngineTestHarness` supplies an in-memory repository, fake clock and scheduler,
deterministic UUID and random sources, a serialized coordination lock, a
scripted transport, and recording event and log sinks.

```ts
import { EngineTestHarness } from '@poodlelab/ngrx-offline/testing';

const harness = new EngineTestHarness([createTrip], { random: [0.5] });
harness.transport.respond(201, {
  id: 'server-42',
  clientId: 'local-1',
  name: 'Ada Services',
});

await harness.engine.enqueue(
  createTrip,
  { clientId: 'local-1', name: 'Ada Services' },
  { scope: 'test-pool' },
);
await harness.engine.replay('test-pool');
```

Use scripted async handlers to hold a request in flight and prove cancellation
races. Use `scheduler.advanceBy(...)` to execute retries without sleeping.

## Replay policies

- The default lane is strict FIFO. A retrying or blocked head prevents later
  operations in that lane from overtaking it.
- Network failures, timeouts, HTTP 408, 425, 429, and 5xx responses retry with
  capped exponential backoff and full jitter by default.
- HTTP 401 pauses the scope; 403, conflicts, other permanent 4xx responses, and
  invalid request or response data block the operation.
- Cancelling or discarding an executing operation is rejected. This avoids
  claiming that an already-sent mutation was cancelled.
- An unknown kind or stored version without a migration path is blocked with a
  stable failure code. Chained migrations and reference resolution are handled
  by the same replay engine.
