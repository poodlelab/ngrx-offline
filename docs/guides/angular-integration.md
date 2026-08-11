# Angular and NgRx Integration

The Angular adapter connects the deterministic replay engine to IndexedDB,
Angular `HttpClient`, and NgRx. It provides a foreground outbox: synchronization
happens while the application is open, immediately after an online enqueue, at
startup, on reconnect, or after `syncNow`.

## Define and bind a mutation

Keep the operation definition free of Angular injection and browser globals so
the same definition can later run in a worker.

```ts
import { createOfflineMutation, defineOfflineCreate } from '@poodlelab/ngrx-offline';

export const createTripOperation = defineOfflineCreate<
  { clientId: string; name: string },
  { id: number; clientId: string; name: string }
>({
  kind: 'travel-journal.trip-create',
  entity: 'trip',
  request: (input) => ({
    method: 'POST',
    url: '/api/trips',
    body: input,
  }),
  parseResult: (response) => response.body as { id: number; clientId: string; name: string },
});

export const createTrip = createOfflineMutation(createTripOperation);
```

`defineOfflineCreate` defaults to operation version 1. Because the conventional
input has `clientId` and the result has `id`, it also derives the durable
client-to-server mapping. Custom property names can use `clientId` and
`serverId` selectors.

Application code follows the normal NgRx workflow: dispatch an action, handle
typed lifecycle actions in reducers or effects, and read state through
selectors. Applications normally dispatch only `requested`. Apply optimistic
domain state from `queued`, because that action is emitted only after the
IndexedDB enqueue transaction commits.

```ts
store.dispatch(
  createTrip.requested({
    input: { clientId: crypto.randomUUID(), name: 'Ada Services' },
  }),
);
```

If storage rejects the operation, `enqueueFailed` is emitted instead. The
library never emits `queued` for that request.

Every request still commits to IndexedDB first, even when the browser appears
online. After that commit, the outbox schedules replay without blocking later
enqueues. Rapid writes share one replay run, so related operations can become
durable before the first HTTP request finishes.

## Configure the foreground outbox

```ts
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideStore } from '@ngrx/store';
import { provideOfflineOutbox } from '@poodlelab/ngrx-offline';

bootstrapApplication(AppComponent, {
  providers: [
    provideStore(),
    provideHttpClient(
      withInterceptors([
        (request, next) =>
          next(
            request.clone({
              setHeaders: { Authorization: `Bearer ${currentAccessToken()}` },
            }),
          ),
      ]),
    ),
    provideOfflineOutbox(() => ({
      databaseName: 'travel-journal-outbox',
      mutations: [createTrip],
      scope: () => currentDemoPoolId(),
      operationTimeoutMs: 30_000,
    })),
  ],
});
```

The request descriptor is rebuilt immediately before execution and is never
stored. Angular interceptors therefore obtain the current authentication state
for every attempt; authorization headers and tokens never enter IndexedDB.

## Lifecycle and restoration

Each mutation binding exposes:

- `requested`, `enqueueFailed`, and durable `queued`;
- idempotent `restored` after application startup;
- `executionStarted`, `retryScheduled`, and `blocked`;
- durable `succeeded` receipt reconciliation;
- `cancelled` when removal is still provably safe.

On startup, pending and blocked operations are restored, then unacknowledged
success receipts are delivered. Receipt acknowledgement happens only after the
corresponding NgRx action is dispatched, so a crash can cause safe at-least-once
redelivery.

## State and commands

The registered `ngrxOfflineOutbox` feature contains payload-free summaries.
Full inputs, response bodies, claims, and receipts stay in IndexedDB.

Public selectors include `selectOfflineHydrated`, `selectOfflineSyncing`, count
selectors, operation-summary selectors, and `selectOfflineStorageHealth`.

```ts
store.dispatch(OfflineOutboxActions.syncNow());
store.dispatch(OfflineOutboxActions.retry({ operationId }));
store.dispatch(OfflineOutboxActions.cancel({ operationId }));
store.dispatch(OfflineOutboxActions.discard({ operationId }));
store.dispatch(OfflineOutboxActions.pauseScope({ scope }));
store.dispatch(OfflineOutboxActions.resumeScope({ scope }));
```

Normal online writes do not need `syncNow`; it explicitly requests another
replay pass for recovery controls and application-specific workflows.

Cancellation is rejected once transport execution starts because the server may
already have committed. `discard` remains an explicit destructive choice.

## Current boundary

Foreground replay now includes cross-tab locking, dependency resolution,
multiple concurrent lanes, scoped lifecycle policies, and operation-input
migrations. The application service worker may cache the shell, but executing
the outbox from a service worker remains optional; see the
[service-worker execution guide](./service-worker-execution.md).
