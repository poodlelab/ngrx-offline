# Durable Offline Mutations for NgRx

## Architecture and Design

- Status: Implemented alpha architecture
- Document date: 2026-08-04
- Initial target: Angular 21 and NgRx 21
- Package: `@poodlelab/ngrx-offline`

## 1. Executive Summary

This document defines a public Angular library for durable, optimistic, offline
mutation handling in applications that use NgRx. The library is a mutation
outbox, not a general offline database and not a whole-Store persistence tool.

Its central guarantee is:

> Once an operation has produced its `queued` event, it has been durably stored
> and can be retried after a network failure, page reload, browser restart, or
> application update supported by the configured migrations.

Applications explicitly register worker-safe operation definitions and bind
them to NgRx lifecycle actions. The library persists operation instances in
IndexedDB, applies ordering and retry policies, executes their HTTP requests,
and publishes typed lifecycle events back to NgRx. Application reducers remain
responsible for optimistic domain state and for reconciling server results.

The public API must not infer behavior from action names, payload shapes, REST
conventions, or negative numeric IDs. Durable data uses stable operation kinds
and schema versions. Temporary entity relationships use explicit references.

The first release should focus on NgRx Store. A SignalStore adapter may be
added later over the same framework-independent engine. NgRx Data is in
maintenance mode and is not a primary integration target.

## 2. Product Definition

### 2.1 Problem

An ordinary NgRx effect loses an in-flight mutation when the page closes. A
failed request can be retried while the current application instance remains
alive, but the retry intention is not durable. Persisting the NgRx Store does
not solve this reliably because the Store is a UI projection rather than an
execution log.

Applications with intermittent connectivity need to:

- accept user mutations while offline;
- update the interface immediately;
- retain pending work across reloads and restarts;
- replay operations in a deterministic order;
- preserve relationships between records created offline;
- prevent two tabs or a service worker from sending the same operation at the
  same time;
- distinguish retryable failures from business conflicts;
- expose enough state for users and developers to understand blocked work.

### 2.2 Public Promise

The library provides:

- durable mutation enqueueing in IndexedDB;
- typed NgRx lifecycle actions;
- foreground replay whenever the application is running;
- automatic retry with configurable classification and backoff;
- scoped queues for accounts, tenants, stations, or workspaces;
- ordered execution within lanes and optional concurrency across lanes;
- explicit dependencies and local-to-server reference resolution;
- multi-tab and worker coordination;
- durable completion receipts for worker execution;
- queue inspection, retry, cancellation, and discard commands;
- operation and database schema migration hooks;
- an optional Angular service-worker integration;
- deterministic testing utilities.

### 2.3 Non-Goals

The library does not provide:

- whole NgRx Store persistence;
- automatic GET request caching;
- a normalized local database for arbitrary queries;
- automatic server conflict merging;
- CRDTs or collaborative editing;
- transparent interception of every HTTP request or NgRx action;
- automatic discovery of API URLs or request payloads;
- authentication token persistence;
- exactly-once server execution without server cooperation;
- domain-specific UI components;
- a replacement for NgRx Entity, SignalStore Entities, RxDB, or a backend sync
  protocol.

## 3. Design Principles

1. **Explicit operations:** only registered mutation definitions are durable.
2. **Durable before optimistic:** `queued` is emitted only after IndexedDB
   commits the operation.
3. **Pure reducers:** reducers and meta-reducers perform no storage, network, or
   synchronization side effects.
4. **At-least-once delivery:** duplicate network delivery is possible after a
   crash; server idempotency converts this into one logical mutation.
5. **IndexedDB is authoritative:** NgRx contains queue summaries and domain
   projections, not the canonical operation log.
6. **Foreground correctness:** synchronization works without Background Sync.
   A service worker is an optional accelerator.
7. **Stable persisted contracts:** persisted operations reference a stable
   `kind` and `version`, never a serialized NgRx action creator.
8. **No hidden ID rewriting:** dependencies are declared with typed references.
9. **Headless integration:** the library exposes state and commands but does not
   impose Angular Material or another design system.
10. **Failure is visible:** unresolved conflicts and permanent failures become
    blocked operations rather than being silently deleted or rolled back.

## 4. Terminology

- **Mutation definition:** application code describing one durable operation
  type, such as `todos.save`.
- **Operation:** one persisted instance of a mutation definition.
- **Outbox:** the IndexedDB collection of operations awaiting completion.
- **Scope:** security and ownership boundary, such as an account or tenant.
- **Lane:** ordering boundary within a scope. Operations in one lane execute in
  FIFO order.
- **Reference:** symbolic value produced by one operation and consumed by
  another, such as a server ID for an offline-created parent.
- **Receipt:** durable success result produced when an operation completes,
  especially when execution happens in a service worker.
- **Blocked operation:** operation that requires user or application action and
  will not be retried automatically.
- **Transport:** foreground or worker implementation that sends a request
  descriptor.

## 5. Package and Repository Structure

The alpha uses one versioned npm package with secondary entry points:

```text
@poodlelab/ngrx-offline
@poodlelab/ngrx-offline/core
@poodlelab/ngrx-offline/indexeddb
@poodlelab/ngrx-offline/worker
@poodlelab/ngrx-offline/testing
```

Repository structure:

```text
projects/ngrx-offline/
  core/                 # Pure TypeScript state machine and contracts
  indexeddb/            # Browser persistence implementation
  src/                  # Angular providers, actions, effects, selectors
  worker/               # Worker-safe coordinator and fetch transport
  testing/              # In-memory stores, fake clock and test harness
apps/
  showcase/             # Atlas Journal Angular and NgRx example
  demo-api/             # API with idempotency and conflict handling
e2e/
  browser/              # Playwright offline, reload, worker and multi-tab tests
docs/
  decisions/
  guides/
  server-contract/
```

The package should use the Angular Package Format and partial compilation for
the Angular entry point. `core`, IndexedDB, and worker modules must not import
Angular or NgRx. The worker bundle must be usable without loading Angular.

Initial peer dependencies:

```json
{
  "@angular/core": "^21.0.0",
  "@ngrx/store": "^21.0.0",
  "@ngrx/effects": "^21.0.0",
  "rxjs": "^7.8.0"
}
```

Support for Angular and NgRx 20 should be added only if the same source can be
verified in a CI compatibility matrix. The package version should follow its
own semantic versioning rather than mirroring the NgRx major version.

## 6. High-Level Architecture

```text
Angular component
      |
      | dispatch mutation.requested
      v
NgRx adapter effect
      |
      | construct and persist operation
      v
IndexedDB outbox -----------------------------+
      |                                        |
      | dispatch mutation.queued               | claim pending work
      v                                        v
Application reducer                    Replay coordinator
(optimistic domain state)                     |
                                               | build request at send time
                                               v
                                      Foreground or worker transport
                                               |
                                      +--------+--------+
                                      |                 |
                                   success          failure
                                      |                 |
                               durable receipt    retry or block
                                      |
                                      v
                             NgRx lifecycle action
                                      |
                                      v
                             Application reconciliation
```

The core replay engine communicates through ports. It does not dispatch NgRx
actions directly. The NgRx adapter subscribes to engine events and translates
them into typed lifecycle actions.

### 6.1 Core Ports

The engine depends on interfaces rather than browser or Angular globals:

```ts
export interface OperationRepository {
  enqueue(operation: StoredOperation): Promise<void>;
  listEligible(query: EligibilityQuery): Promise<StoredOperation[]>;
  claim(id: string, claim: OperationClaim): Promise<boolean>;
  scheduleRetry(id: string, retry: StoredRetry): Promise<void>;
  block(id: string, failure: StoredFailure): Promise<void>;
  complete(completion: OperationCompletion): Promise<void>;
  cancel(id: string): Promise<CancelResult>;
  recoverExpiredClaims(now: number): Promise<number>;
}

export interface OperationTransport {
  execute(
    request: HttpRequestDescriptor,
    context: TransportContext,
  ): Promise<TransportResponse>;
}

export interface CoordinationLock {
  runExclusive<T>(key: string, work: () => Promise<T>): Promise<T>;
}
```

Clock, UUID generation, retry scheduling, logging, and connectivity are also
injected. This makes the engine deterministic in tests and usable without
Angular.

## 7. Public Mutation API

### 7.1 Definition

Definitions and NgRx bindings are deliberately separate. The operation
definition is pure TypeScript and can be imported by both the Angular
application and a service worker:

```ts
export const createTravelDay = defineOfflineCreate<
  CreateTravelDayInput,
  CreatedEntity
>({
  kind: 'journal.travel-day.create',
  entity: 'travel-day',

  request: (input, context) => ({
    method: 'POST',
    url: '/api/travel-days',
    body: {
      clientId: input.clientId,
      tripId: context.resolve(input.trip),
      date: input.date,
      title: input.title,
    },
  }),
});
```

Version 1 is the default. Tagged offline references inside the input are
discovered automatically. For conventional `clientId` inputs and `id` results,
the helper also derives the pre-execution producer key and post-success server
ID mapping. `defineOfflineOperation` retains the fully explicit low-level path.

The NgRx entry point binds that definition to generated typed actions:

```ts
export const travelDayMutation = createOfflineMutation(createTravelDay);
```

The returned binding contains the definition and generated actions:

```ts
travelDayMutation.requested
travelDayMutation.enqueueFailed
travelDayMutation.queued
travelDayMutation.restored
travelDayMutation.executionStarted
travelDayMutation.retryScheduled
travelDayMutation.succeeded
travelDayMutation.blocked
travelDayMutation.cancelled
```

Applications dispatch only `requested` during normal use:

```ts
store.dispatch(saveTodo.requested({
  input: { todo },
}));
```

All other lifecycle actions are produced by the library. Their action type
strings are for NgRx observability only and are not persisted.

Operation inputs must be JSON-compatible values, plus library-defined
`OfflineReference` and `AttachmentHandle` values. Dates are represented as ISO
strings. Functions, class instances, DOM objects, circular structures, and raw
authentication objects are rejected at enqueue time. This restriction keeps
worker execution and operation migrations predictable.

Operation-definition modules must also be worker-safe: they cannot call Angular
dependency injection, access the DOM, or close over application service
instances. Runtime values such as API origin and authentication belong in the
request context or transport enhancer.

### 7.2 Operation Definition Contract

Conceptual interface:

```ts
export interface OfflineOperationDefinition<Input, Result> {
  readonly kind: string;
  readonly version: number;

  readonly request: (
    input: Input,
    context: RequestBuildContext,
  ) => HttpRequestDescriptor;

  readonly lane?: (input: Input) => string;
  readonly dependencies?: (input: Input) => OfflineReference[];
  readonly produces?: (
    value: MutationSuccess<Input, Result>,
  ) => ResolvedReference[];

  readonly parseResult?: (response: TransportResponse) => Result;
  readonly migrate?: OperationMigration<Input>[];
  readonly retryPolicy?: RetryPolicy;
  readonly redact?: (input: Input) => unknown;
}
```

`kind` must be globally unique within an application and must never be derived
from a minified class name. `version` describes the persisted input contract,
not the npm package version.

### 7.3 Provider API

```ts
bootstrapApplication(AppComponent, {
  providers: [
    provideStore({ todos: todosReducer }),
    provideEffects(),

    provideOfflineOutbox(() => {
      const accounts = inject(AccountService);
      const connectivity = inject(ConnectivityService);
      const applicationReady = inject(ApplicationReadyService);

      return {
        databaseName: 'todo-offline-outbox',
        mutations: [saveTodo, deleteTodo],

        scope: () => accounts.currentAccountId(),
        connectivity$: connectivity.connected$,

        transport: withAngularHttpTransport(),
        classifyFailure: todoFailureClassifier,

        execution: {
          maxConcurrentLanes: 3,
          operationTimeoutMs: 30_000,
        },

        restoreWhen$: applicationReady.ready$,
      };
    }),
  ],
});
```

The configuration factory is evaluated in an Angular injection context. It may
inject services, but operation definitions and policy functions should remain
deterministic where possible. `mutations` are NgRx bindings; the engine receives
their underlying operation definitions.

## 8. NgRx Integration

### 8.1 Action Lifecycle

```text
requested
  -> enqueueFailed
  -> queued
       -> executionStarted
            -> succeeded
            -> retryScheduled -> executionStarted
            -> blocked
       -> cancelled
```

Semantics:

- `requested`: command to create an operation. Not yet durable.
- `enqueueFailed`: IndexedDB rejected the operation. No optimistic update should
  have occurred.
- `queued`: operation is durable. Reducers may apply optimistic state.
- `restored`: pending operation was loaded after application startup. Reducers
  may reconstruct their optimistic projection idempotently.
- `executionStarted`: diagnostic event. Domain reducers normally ignore it.
- `retryScheduled`: retryable execution failure was persisted.
- `succeeded`: server result is durable and can reconcile domain state.
- `blocked`: automatic retries stopped.
- `cancelled`: pending operation was removed before confirmed server execution.

The library does not automatically roll back domain state when an operation is
blocked. The application decides whether to keep the optimistic value marked as
blocked, restore a previous value, or guide the user through conflict repair.

### 8.2 Application Reducer Example

```ts
export const todosReducer = createReducer(
  initialState,

  on(saveTodo.queued, saveTodo.restored, (state, event) =>
    adapter.upsertOne(
      {
        ...event.input.todo,
        syncState: {
          operationId: event.operationId,
          status: 'pending',
        },
      },
      state,
    ),
  ),

  on(saveTodo.succeeded, (state, event) =>
    adapter.upsertOne(
      {
        ...event.result,
        syncState: { status: 'synchronized' },
      },
      state,
    ),
  ),

  on(saveTodo.blocked, (state, event) =>
    markTodoBlocked(
      state,
      event.input.todo.clientId,
      event.failure,
    ),
  ),
);
```

Reducers must handle `restored` idempotently because startup or receipt
delivery can happen more than once after crashes.

### 8.3 Library Feature State

The library registers a small feature state containing only reactive summaries:

```ts
export interface OfflineOutboxState {
  hydrated: boolean;
  syncing: boolean;
  activeScope: string | null;
  pendingCount: number;
  blockedCount: number;
  operations: Record<string, OperationSummary>;
  storageHealth: StorageHealth;
}
```

The full input, response bodies, attachments, leases, and retry records remain
in IndexedDB. Keeping them out of NgRx avoids large Redux DevTools
serialization costs and accidental exposure of sensitive payloads.

Public selectors:

```ts
selectOfflineHydrated
selectOfflineSyncing
selectOfflinePendingCount
selectOfflineBlockedCount
selectOfflineOperations
selectOfflineOperationById
selectOfflineOperationsForScope
selectOfflineStorageHealth
```

Consumers can use observable selectors or `store.selectSignal(...)`.

### 8.4 Library Commands

```ts
OfflineOutboxActions.syncNow()
OfflineOutboxActions.retry({ operationId })
OfflineOutboxActions.cancel({ operationId })
OfflineOutboxActions.discard({ operationId })
OfflineOutboxActions.pauseScope({ scope })
OfflineOutboxActions.resumeScope({ scope })
OfflineOutboxActions.restoreOptimisticState()
```

Cancellation is guaranteed only before a request is sent. Cancelling an
executing request cannot prove that the server did not commit it. In that case,
the resulting receipt must still be processed.

### 8.5 Why No Meta-Reducer

Meta-reducers remain synchronous and pure. They cannot safely await IndexedDB,
perform HTTP requests, coordinate locks, or correlate concurrent operations.
The library uses functional effects as the NgRx boundary and a dedicated engine
for side effects.

## 9. Durable Storage Model

IndexedDB is the default and initially only production storage adapter. It uses
the structured clone algorithm and explicit database migrations.

### 9.1 Object Stores

```text
operations
receipts
references
attachments
metadata
```

### 9.2 Operation Record

```ts
export interface StoredOperation<Input = unknown> {
  id: string;                     // UUID and default idempotency key
  kind: string;
  version: number;
  scope: string;
  lane: string;
  input: Input;

  status: 'pending' | 'executing' | 'blocked';
  dependencies: string[];

  attempts: number;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;

  claimOwner: string | null;
  claimExpiresAt: number | null;
  lastFailure: StoredFailure | null;
}
```

Required indexes:

```text
by_scope_status_nextAttemptAt
by_scope_lane_createdAt
by_status_claimExpiresAt
by_kind_version
```

### 9.3 Receipt Record

```ts
export interface StoredReceipt<Result = unknown> {
  operationId: string;
  kind: string;
  version: number;
  scope: string;
  input: unknown;
  result: Result;
  producedReferences: ResolvedReference[];
  completedAt: number;
}
```

The completion transaction writes the receipt and produced references, then
removes the operation atomically. The application later consumes the receipt
and dispatches `succeeded`. Receipt consumption is at-least-once; application
reducers must reconcile by operation or client ID rather than append blindly.

### 9.4 Reference Record

```ts
export interface StoredReference {
  key: string;
  scope: string;
  value: string | number;
  producerOperationId: string;
  resolvedAt: number;
}
```

Reference keys are scoped. A reference from one account must never resolve an
operation belonging to another account.

### 9.5 Attachments

Large `Blob` values should not be embedded repeatedly inside operation inputs.
An optional attachment API stores them once:

```ts
const attachment = await outbox.attach(file);

store.dispatch(uploadDocument.requested({
  input: { document, attachment },
}));
```

Attachment records are reference-counted and deleted when no pending operation
or retained receipt uses them. File upload support may be added after the JSON
mutation API, but the storage schema reserves this boundary from the start.

### 9.6 Transactions

The following operations must be transactional:

- enqueue operation;
- claim pending operation;
- schedule retry and release claim;
- mark operation blocked and release claim;
- store completion receipt, store produced references, and delete operation;
- consume and delete receipt;
- remove operation and decrement attachment references.

Network execution cannot be part of an IndexedDB transaction. This unavoidable
gap is why the server must support idempotency.

## 10. Replay Engine

### 10.1 Triggers

Synchronization is attempted when:

- the application starts;
- the configured connectivity stream reports connected;
- the browser fires an `online` event;
- a new operation is queued while apparently online;
- the next retry time is reached;
- the user dispatches `syncNow` or `retry`;
- an optional service-worker sync event fires;
- the application sends an explicit message to its service worker.

Connectivity is a hint only. A request attempt and the resulting failure
classification determine actual reachability.

### 10.2 Coordination

Only one coordinator may execute operations for a database and scope at a time.
The primary implementation uses the Web Locks API. An IndexedDB lease fallback
should be provided for supported browsers without Web Locks.

Each claimed operation also has an expiring claim. If a page or worker is
terminated during execution, a future coordinator returns stale `executing`
operations to `pending` and retries them with the same idempotency key.

### 10.3 Ordering

- Operations are FIFO within a lane.
- Only one operation per lane executes at a time.
- Independent lanes may execute concurrently up to
  `maxConcurrentLanes`.
- An operation with unresolved dependencies is not eligible.
- A blocked operation blocks later operations in the same lane by default.
- Applications may choose a global lane when strict total ordering is needed.

The default lane is `default`, producing globally ordered behavior until the
consumer opts into concurrency.

### 10.4 Execution Algorithm

1. Acquire the coordination lock for the active scope.
2. Recover stale claims.
3. Load eligible pending operations in deterministic order.
4. Verify that the operation definition exists.
5. Migrate older input versions inside a durable transaction.
6. Verify dependencies and resolve references.
7. Claim the operation with an expiry.
8. Build the request using the current definition.
9. Add the operation ID as the idempotency key.
10. Enhance the request with current authentication and API configuration.
11. Execute through the selected transport.
12. Parse and validate the result.
13. On success, write the receipt and references and remove the operation.
14. On retryable failure, persist retry time and release the claim.
15. On conflict or permanent failure, mark the operation blocked.
16. Continue with eligible lanes until no work remains.

### 10.5 Retry Policy

Default behavior:

- network failure: retry;
- timeout: retry;
- HTTP `408`, `425`, `429`, and `5xx`: retry;
- HTTP `401`: pause the scope until authentication changes;
- HTTP `403`: block as a permission failure;
- HTTP `409` or `412`: block as conflict;
- other `4xx`: block as permanent/application failure;
- malformed successful response: block as response failure.

Retry delay uses exponential backoff with full jitter and honors `Retry-After`.
Applications can replace this classifier because API semantics differ. The
library must never classify errors based on application-specific response
properties unless configured to do so.

Suggested defaults:

```text
initial delay:       1 second
maximum delay:       5 minutes
backoff multiplier:  2
jitter:              full
maximum attempts:    unlimited for retryable network failures
```

Unlimited retry does not mean tight looping. The operation remains durable and
waits for its next scheduled attempt.

## 11. Request and Transport Model

```ts
export interface HttpRequestDescriptor {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  responseType?: 'json' | 'text' | 'blob' | 'none';
  credentials?: RequestCredentials;
  timeoutMs?: number;
}
```

The descriptor is built at execution time rather than persisted. This allows
API base URLs, headers, and request formats to evolve through definition
migrations. Authorization headers must be supplied by a transport enhancer and
must not be stored in IndexedDB.

Foreground transport may use Angular `HttpClient`, retaining application
interceptors. Worker transport uses `fetch` and therefore needs an explicitly
configured worker-safe request enhancer. Applications whose authentication
cannot be accessed safely by a worker should use foreground replay only.

Custom transports may support GraphQL or RPC, but v1 should document and test
HTTP mutations first. Transport APIs must preserve operation IDs so an
idempotency key can be sent even when the protocol is not HTTP.

## 12. Temporary Identity and Dependencies

### 12.1 Preferred Strategy

Prefer client-generated UUIDs that the server accepts as entity identifiers.
This avoids local-to-server ID replacement entirely.

### 12.2 Explicit References

When a server controls numeric IDs, consumers use symbolic references:

```ts
const parentReference = offlineRef(
  'todo',
  parent.clientId,
);
```

The child input stores the reference, not a negative number:

```ts
{
  todo: {
    clientId: crypto.randomUUID(),
    title: 'Child',
    parent: parentReference,
  },
}
```

Its request definition resolves it explicitly:

```ts
request: ({ todo }, context) => ({
  method: 'POST',
  url: '/api/todos',
  body: {
    title: todo.title,
    parentId: context.resolve(todo.parent),
  },
})
```

The parent definition declares what it produces:

```ts
produces: ({ input, result }) => [
  resolveReference(
    `todo:${input.todo.clientId}`,
    result.id,
  ),
]
```

The engine never scans all numeric payload values. Missing references prevent
execution and are visible in diagnostics.

## 13. Startup and Rehydration

Startup has two separate concerns:

1. hydrate queue summaries and process durable receipts;
2. reconstruct application-specific optimistic domain state.

The library can hydrate its own summary state immediately. Reapplying domain
optimism may need to wait until the application has loaded its persisted Store
or initial server snapshot. Configuration therefore accepts `restoreWhen$`.

Once ready, the adapter emits `restored` once for every pending or blocked
operation definition. Reducers must upsert by client ID and operation ID.

If a receipt exists for an operation whose optimistic state has not been
restored, `succeeded` still contains the original input and result so the
application can reconcile directly.

The outbox may execute before domain restoration is ready. Execution and UI
projection are independent, and completion remains durable through receipts.

## 14. Service-Worker Integration

Service-worker execution is optional. Foreground replay remains the correctness
baseline because Background Sync is not available in every browser.

The worker entry point should expose an API similar to:

```ts
startOfflineOutboxWorker({
  databaseName: 'todo-offline-outbox',
  operations: [saveTodoOperation, deleteTodoOperation],
  canExecuteScope: resolveWorkerScopeAccess,
  transport: withFetchTransport({
    enhanceRequest: addWorkerAuthentication,
  }),
});
```

Responsibilities:

- react to Background Sync events with `event.waitUntil(...)`;
- react to explicit page messages requesting synchronization;
- use the same IndexedDB schema and replay engine as the page;
- coordinate through Web Locks or leases;
- write success receipts rather than attempting to dispatch NgRx actions;
- notify open clients through `BroadcastChannel` or `postMessage`;
- tolerate termination at every await point;
- never assume periodic execution is guaranteed.

Angular applications using the Angular service worker can extend it through a
custom worker script. The reference application must demonstrate the complete
build and registration setup, because worker packaging is otherwise a common
integration failure point.

## 15. Scope, Authentication, and Logout

Every operation belongs to an immutable scope captured at enqueue time.

Rules:

- only execute operations for the currently authenticated compatible scope;
- never send one user's operation with another user's credentials;
- changing scope pauses, but does not automatically delete, other scopes;
- logout behavior is application-configurable: preserve, prompt, or explicitly
  discard;
- tokens and cookies are not copied into operation records;
- worker execution is disabled when the worker cannot establish valid current
  credentials for the operation scope;
- reference resolution is scope-local.

The library should expose pending counts by scope so applications can warn
before logout or account switching.

## 16. Server Contract

### 16.1 Idempotency

Every request carries:

```http
Idempotency-Key: <operation UUID>
```

The server must atomically associate that key with the mutation result. A
duplicate request with the same key and equivalent payload returns the original
result without applying the mutation again. Reuse with a different payload
should be rejected.

Without this contract the library provides at-least-once delivery only. It must
not advertise exactly-once execution.

### 16.2 Concurrency and Conflicts

Updates should include an entity version, ETag, or equivalent concurrency
token. The server returns `409 Conflict` or `412 Precondition Failed` when the
client version is stale. The library marks the operation blocked and exposes
the response to application conflict handling.

The library does not merge domain objects automatically. Consumers may discard,
edit and replace, or create a new operation after conflict resolution.

### 16.3 Reference Results

Create responses must include the stable server identifier required by
`produces`. The reference application should show both UUID-native entities and
server-generated numeric IDs.

## 17. Failure and Recovery Model

Failure decisions:

```ts
export type FailureDecision =
  | { type: 'retry'; delayMs?: number }
  | { type: 'block'; code: string; detail?: unknown }
  | { type: 'pause-scope'; code: string };
```

There is intentionally no automatic `discard` classification. Silent data loss
is worse than retaining an operation that needs attention. Discard is an
explicit application or user command.

Blocked operations retain:

- sanitized failure code and message;
- HTTP status where applicable;
- attempt count;
- last attempt time;
- operation kind and version;
- enough input metadata for the application to identify affected domain data.

Raw response bodies should only be persisted through an opt-in sanitizer to
avoid retaining secrets or unexpectedly large payloads.

## 18. Observability and Diagnostics

The library is headless but must be easy to inspect.

Required capabilities:

- NgRx lifecycle actions visible in Redux DevTools;
- selectors for pending, executing, retrying, paused, and blocked summaries;
- structured transition events for logging and telemetry;
- an optional debug logger with payload redaction;
- queue export containing sanitized metadata only;
- storage health reporting, including quota errors and migration failures;
- timestamps and attempt counters;
- stable failure codes suitable for localization by applications.

The library should not put complete operation payloads into its feature state or
diagnostic actions by default. This avoids DevTools serialization stalls and
reduces accidental data disclosure.

Potential future tooling may provide a standalone development inspector, but v1
should expose enough APIs for consumers to build their own status UI.

## 19. Security and Privacy

IndexedDB data is readable by JavaScript executing in the same origin. The
library must document that it is not protection against XSS.

Requirements:

- never persist bearer tokens or short-lived authentication headers;
- allow consumers to redact stored failure details and diagnostics;
- provide a serialization/encryption adapter boundary without claiming that
  browser-side encryption solves compromised-origin attacks;
- avoid copying Blob data into NgRx or Redux DevTools;
- expose explicit scope deletion APIs;
- optionally request persistent browser storage and report whether it was
  granted;
- handle quota errors as `enqueueFailed`, never as successful queueing;
- document data-retention responsibilities for sensitive applications.

## 20. Storage and Operation Migrations

There are two migration levels:

### 20.1 IndexedDB Schema Migration

Database migrations create or change object stores and indexes. They run in the
IndexedDB upgrade transaction. Failed upgrades must leave the previous version
intact and surface a storage-health error.

### 20.2 Mutation Input Migration

Each operation definition owns migrations from earlier persisted versions:

```ts
defineOfflineOperation({
  kind: 'journal.travel-day.create',
  version: 3,
  migrations: [
    { fromVersion: 1, toVersion: 2, migrate: migrateDayV1ToV2 },
    { fromVersion: 2, toVersion: 3, migrate: migrateDayV2ToV3 },
  ],
  // ...
});
```

Missing definitions or migration paths block operations with a specific
diagnostic code. They are never silently removed. Breaking persisted-operation
changes require a library or application migration strategy and must be called
out in release notes.

## 21. Testing Strategy

### 21.1 Core Unit Tests

Use injected clock, random source, repository, lock, and transport ports.
Validate:

- deterministic FIFO and lane ordering;
- concurrency limits;
- dependency blocking and reference resolution;
- retry classification and jitter bounds;
- stale claim recovery;
- scope isolation;
- unknown definition and migration failures;
- cancellation and discard semantics;
- idempotent receipt handling.

### 21.2 IndexedDB Integration Tests

Use `fake-indexeddb` for fast tests and real browsers for behavioral tests:

- transactional enqueue;
- completion transaction atomicity;
- failed schema upgrades;
- quota and structured-clone errors;
- attachment reference counting;
- simultaneous repository instances;
- operation input migrations.

### 21.3 NgRx Adapter Tests

- `requested` emits `queued` only after durable commit;
- failed persistence emits `enqueueFailed` and no `queued`;
- engine transitions create correct typed actions;
- selectors expose summaries without full payloads;
- restored operations reapply optimism idempotently;
- receipts reconcile after reload;
- functional effects do not duplicate subscriptions;
- teardown stops listeners and timers.

### 21.4 Browser End-to-End Tests

Use Playwright with a real reference API. Required scenarios:

1. Queue while offline, reload, reconnect, succeed.
2. Queue a parent and dependent child offline, close the browser, reopen, and
   resolve IDs in order.
3. Lose the response after the server commits, retry with the same idempotency
   key, and observe one server mutation.
4. Terminate the page while an operation is executing and recover its stale
   claim.
5. Open two tabs and prove only one transport call executes at a time.
6. Complete in the worker while the page is closed, then consume the receipt.
7. Upgrade application definitions with pending older operations.
8. Switch accounts and prove queues never cross scopes.
9. Receive `409`/`412`, block the operation, resolve it, and retry.
10. Deny persistent storage or simulate quota exhaustion and show enqueue
    failure without optimistic state.

Run cross-browser tests for supported Chrome, Edge, Firefox, and Safari
versions. Worker-specific scenarios should be conditionally asserted according
to platform capability, while foreground replay must pass everywhere.

## 22. Reference Application

The example must demonstrate more than a single retried Todo POST.

Atlas Journal demonstrates a complete travel journal whose records can all be
created before server IDs exist:

- a Trip contains Travel Days;
- a Travel Day contains Place Visits and Memories;
- Memories can belong to Places created in the same offline session;
- a Reflection branches from a Travel Day;
- the UI shows pending, blocked, and synchronized state;
- browser controls demonstrate offline replay, response loss, conflicts, and
  recovery without relying on a trivial Todo domain.

The reference server must implement:

- an isolated data pool identified by a client-generated workspace ID and
  capability secret;
- idempotency-key storage and duplicate response replay;
- optimistic concurrency with ETags or numeric versions;
- deterministic test endpoints for timeout, commit-with-lost-response, `409`,
  `422`, and `500` behavior;
- request-count diagnostics used by browser tests.

The README introduces the concise mutation API, while Atlas Journal proves the
difficult guarantees with a realistic relationship graph.

## 23. Public Release Criteria

The package should not reach stable `1.0` until:

- all documented delivery guarantees have browser tests;
- the server idempotency contract has a working reference implementation;
- queue schema and mutation migrations are tested;
- foreground replay works without service-worker features;
- worker execution cannot duplicate an active foreground executor;
- account and tenant scope isolation is verified;
- failure recovery never silently discards an operation;
- public APIs have been exercised by at least two materially different example
  domains or early adopters;
- upgrade and compatibility policies are documented;
- the project has a clear maintenance and security-reporting process.

## 24. Scope Decisions

- Start with NgRx Store, not SignalStore or NgRx Data.
- Use functional effects and ordinary reducers, not a meta-reducer.
- Use IndexedDB as the durable source of truth.
- Persist stable operation kinds and input versions, not actions.
- Emit optimistic lifecycle only after durable enqueue.
- Guarantee at-least-once transport execution.
- Require server idempotency for one logical mutation.
- Keep Background Sync optional.
- Use explicit references instead of negative-ID scanning.
- Ship headless APIs rather than UI components.
- Publish `@poodlelab/ngrx-offline` with secondary entry points.
- Support the current Angular and NgRx 21 release line, with browser-wide
  foreground correctness and an IndexedDB coordination fallback.
- Use Angular `HttpClient` for foreground execution and `fetch` in workers.

Deferred extensions include SignalStore integration, lazy mutation-definition
registration, attachments, custom protocol transports, storage encryption
adapters, and a standalone queue inspector. They should be driven by real user
requirements rather than expanding the alpha surface speculatively.

These choices must not weaken the core invariants: durable-before-optimistic,
scope isolation, stable operation versions, and server idempotency.

## 25. External References

- NgRx Store: https://ngrx.io/guide/store
- NgRx Effects: https://ngrx.io/guide/effects
- NgRx SignalStore: https://ngrx.io/guide/signals/signal-store
- NgRx SignalStore Entities:
  https://ngrx.io/guide/signals/signal-store/entity-management
- NgRx Data maintenance status: https://ngrx.io/guide/data
- Angular library creation:
  https://angular.dev/tools/libraries/creating-libraries
- Angular custom service workers:
  https://angular.dev/ecosystem/service-workers/custom-service-worker-scripts
- Web Locks API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
- Background Sync API:
  https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API
- Storage persistence:
  https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist
- Storage quotas and eviction:
  https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- IETF Idempotency-Key draft:
  https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header
