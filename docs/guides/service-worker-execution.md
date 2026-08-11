# Service-worker execution

The optional `@poodlelab/ngrx-offline/worker` entry point runs the same core
engine against the same IndexedDB database as the foreground Angular adapter.
It does not introduce a second queue. The shared Web Lock, with a renewable
IndexedDB lease fallback, ensures that only one context replays a scope.

## Build a custom Angular service worker

Angular supports extending its service worker with a custom script. Import
`ngsw-worker.js` first, then install the outbox handlers:

```ts
/// <reference lib="webworker" />

import {
  FetchOperationTransport,
  WorkerClientNotifier,
  WorkerOutboxExecutor,
  registerOfflineWorkerHandlers,
} from '@poodlelab/ngrx-offline/worker';
import { operationDefinitions } from './operation-definitions';

declare const self: ServiceWorkerGlobalScope;

importScripts('./ngsw-worker.js');

const executor = new WorkerOutboxExecutor({
  databaseName: 'field-app-outbox',
  definitions: operationDefinitions,
  transport: new FetchOperationTransport(),
  notifier: new WorkerClientNotifier(self.clients),
});

registerOfflineWorkerHandlers({
  scope: self,
  executor,
});
```

Bundle that file as a classic service-worker script and register it instead of
`ngsw-worker.js`. The Atlas Journal uses esbuild after the Angular production build
and registers `offline-service-worker.js`. Its first runtime action imports the
Angular worker, preserving application-shell caching and updates.

Angular's current custom-worker guidance likewise requires importing the
Angular worker first and recommends `waitUntil()` for asynchronous extension
work: [Custom service worker scripts](https://angular.dev/ecosystem/service-workers/custom-service-worker-scripts).

## Request replay from Angular

Register the optional bridge next to `provideOfflineOutbox`:

```ts
provideOfflineWorkerBridge(() => ({
  payload: async () => credentialBroker.workerPayload(),
}));
```

Then request replay through the injected bridge:

```ts
await inject(OfflineWorkerBridge).requestSync();
```

The bridge posts an explicit sync message and, where available, registers a
Background Sync tag. Background Sync is a progressive enhancement with limited
browser availability, so the explicit message and the foreground engine remain
the portable paths. See the
[MDN Background Synchronization API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API).

When replay completes, the worker writes a receipt in the same IndexedDB
transaction that removes the operation. It then announces the result through
both client `postMessage` and `BroadcastChannel`. An open app consumes the
receipt immediately; a reopened app consumes it during outbox restoration.

## Authentication boundaries

A service worker cannot read page `localStorage`, and its in-memory state may be
lost whenever the browser terminates it. Do not persist bearer tokens inside
operation inputs merely to make background execution convenient.

Choose one explicit policy:

- Prefer same-site, secure, HTTP-only cookies when the API and threat model
  permit them.
- Supply credentials through an application-owned worker credential broker.
- Send an ephemeral credential in an explicit same-origin message and keep it
  only for that worker lifetime.
- Return `false` from `canReplay` when credentials are unavailable. The worker
  leaves operations pending and the Angular bridge safely falls back to
  foreground replay.

The Atlas Journal uses the third policy for its anonymous, disposable demo
capability. It registers the workspace in the page, transfers authorization to
the worker for one explicit run, and never stores the credential in the durable
outbox. A later Background Sync event after worker restart is deferred until
the foreground can supply a fresh capability.

## Termination and duplicate safety

Service workers can stop between asynchronous boundaries. NgRx Offline handles
that by treating IndexedDB as authoritative:

- a transport begins only after a durable operation claim;
- claims expire and are recovered by the next executor;
- completion stores the result receipt and reference mappings atomically;
- the stable operation ID is also the server idempotency key;
- foreground and worker replay use the same scoped coordination key.

This produces at-least-once delivery with durable local recovery. Exactly-once
business effects still require the documented server idempotency contract.
