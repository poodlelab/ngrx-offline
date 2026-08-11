import {
  JsonValue,
  ReplayEngine,
  StoredOperation,
  createOperationRegistry,
  defineOfflineOperation,
} from '@poodlelab/ngrx-offline/core';
import {
  DeterministicUuidGenerator,
  FakeClock,
  FakeScheduler,
  InMemoryCoordinationLock,
  RecordingEventSink,
  ScriptedTransport,
  SequenceRandomSource,
  StaticConnectivity,
} from '@poodlelab/ngrx-offline/testing';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { normalizeIndexedDbError } from './indexeddb-errors';
import {
  INDEXED_DB_SCHEMA_VERSION,
  INDEXED_DB_STORES,
  IndexedDbOperationRepository,
  OPERATION_INDEXES,
} from './indexeddb-operation-repository';

describe('IndexedDbOperationRepository', () => {
  it('creates every store and required operation index through schema migrations', async () => {
    const factory = new IDBFactory();
    const repository = createRepository(factory, 'schema');
    await repository.listOperations();

    const database = await openDatabase(factory, 'schema');
    expect(database.version).toBe(INDEXED_DB_SCHEMA_VERSION);
    expect([...database.objectStoreNames].sort()).toEqual(Object.values(INDEXED_DB_STORES).sort());
    const transaction = database.transaction(INDEXED_DB_STORES.operations, 'readonly');
    const indexes = [...transaction.objectStore(INDEXED_DB_STORES.operations).indexNames];
    expect(indexes).toEqual(expect.arrayContaining(Object.values(OPERATION_INDEXES)));
    database.close();
    await repository.close();
  });

  it('upgrades an existing v1 database without losing durable operations', async () => {
    const factory = new IDBFactory();
    const legacy = await createLegacyV1(factory, 'legacy');
    const operation = storedOperation();
    const legacyOperation: Record<string, unknown> = { ...operation };
    delete legacyOperation['dependencies'];
    delete legacyOperation['produces'];
    const transaction = legacy.transaction(INDEXED_DB_STORES.operations, 'readwrite');
    transaction.objectStore(INDEXED_DB_STORES.operations).put(legacyOperation);
    await transactionDone(transaction);
    legacy.close();

    const repository = createRepository(factory, 'legacy');
    expect(await repository.get(operation.id)).toEqual(operation);
    const database = await openDatabase(factory, 'legacy');
    expect(
      database
        .transaction(INDEXED_DB_STORES.operations, 'readonly')
        .objectStore(INDEXED_DB_STORES.operations)
        .indexNames.contains(OPERATION_INDEXES.kindVersion),
    ).toBe(true);
    database.close();
    await repository.close();
  });

  it('atomically replaces an executing operation with a receipt and produced references', async () => {
    const factory = new IDBFactory();
    const repository = createRepository(factory, 'completion');
    const pending = storedOperation();
    await repository.enqueue(pending);
    const executing = await repository.claim(pending.id, {
      owner: 'page-a',
      claimedAt: 10,
      expiresAt: 1_010,
    });
    expect(executing?.status).toBe('executing');

    await repository.complete({
      operationId: pending.id,
      receipt: {
        operationId: pending.id,
        kind: pending.kind,
        version: pending.version,
        scope: pending.scope,
        input: pending.input,
        result: { id: 42 },
        producedReferences: [{ key: 'customer:local-1', value: 42 }],
        completedAt: 20,
      },
      references: [
        {
          key: 'customer:local-1',
          value: 42,
          scope: pending.scope,
          producerOperationId: pending.id,
          resolvedAt: 20,
        },
      ],
    });

    expect(await repository.get(pending.id)).toBeUndefined();
    expect(await repository.listReceipts(pending.scope)).toHaveLength(1);
    expect(await repository.listReferences(pending.scope)).toEqual([
      expect.objectContaining({ key: 'customer:local-1', value: 42 }),
    ]);
    expect(await repository.listReceipts(pending.scope)).toHaveLength(1);
    expect(await repository.acknowledgeReceipt(pending.id)).toBe(true);
    expect(await repository.listReceipts(pending.scope)).toEqual([]);
    await repository.close();
  });

  it('persists retry state, manual retry, blocking, and stale claim recovery', async () => {
    const repository = createRepository(new IDBFactory(), 'transitions');
    const first = storedOperation();
    const second = storedOperation({ id: 'operation-2', createdAt: 2, updatedAt: 2 });
    await repository.enqueue(first);
    await repository.enqueue(second);
    await repository.claim(first.id, { owner: 'page-a', claimedAt: 10, expiresAt: 20 });
    await repository.scheduleRetry(first.id, {
      attempt: 1,
      failure: failure('network'),
      nextAttemptAt: 100,
      updatedAt: 10,
    });
    expect(await repository.listEligible({ scope: first.scope, now: 99, limit: 10 })).toEqual([]);
    expect(await repository.retryNow(first.id, 50)).toBe(true);
    expect(await repository.listEligible({ scope: first.scope, now: 50, limit: 10 })).toEqual([
      expect.objectContaining({ id: first.id }),
    ]);

    await repository.claim(first.id, { owner: 'dead-page', claimedAt: 50, expiresAt: 60 });
    expect(await repository.recoverExpiredClaims(61, first.scope)).toEqual([first.id]);
    await repository.block(first.id, failure('permanent_failure'), 62);
    expect(await repository.listEligible({ scope: first.scope, now: 1_000, limit: 10 })).toEqual(
      [],
    );
    expect((await repository.get(first.id))?.status).toBe('blocked');
    await repository.close();
  });

  it('updates versions and leases transactionally and deletes only one scope', async () => {
    const repository = createRepository(new IDBFactory(), 'indexeddb-transaction-tests');
    const first = storedOperation({ dependencies: ['customer:local-1'] });
    const otherScope = storedOperation({ id: 'operation-b', scope: 'pool-b' });
    await repository.enqueue(first);
    await repository.enqueue(otherScope);
    expect(
      await repository.migrateOperation({
        id: first.id,
        expectedVersion: 1,
        version: 2,
        input: { clientId: 'local-1', name: 'Migrated' },
        lane: 'customer:local-1',
        dependencies: [],
        produces: ['customer:local-1'],
        updatedAt: 2,
      }),
    ).toMatchObject({ version: 2, lane: 'customer:local-1' });
    expect(
      await repository.migrateOperation({
        id: first.id,
        expectedVersion: 1,
        version: 3,
        input: {},
        lane: 'wrong',
        dependencies: [],
        produces: [],
        updatedAt: 3,
      }),
    ).toBeUndefined();

    expect(
      await repository.acquireCoordinationLease(
        { key: 'queue', owner: 'tab-a', expiresAt: 100 },
        0,
      ),
    ).toBe(true);
    expect(
      await repository.acquireCoordinationLease(
        { key: 'queue', owner: 'tab-b', expiresAt: 100 },
        50,
      ),
    ).toBe(false);
    expect(
      await repository.acquireCoordinationLease(
        { key: 'queue', owner: 'tab-b', expiresAt: 200 },
        101,
      ),
    ).toBe(true);
    await repository.deleteScope('pool-a');
    expect(await repository.get(first.id)).toBeUndefined();
    expect(await repository.get(otherScope.id)).toBeDefined();
    await repository.close();
  });

  it('surfaces serialization and quota failures with stable codes', async () => {
    const repository = createRepository(new IDBFactory(), 'errors');
    const invalid = storedOperation({
      input: { invalid: (() => undefined) as unknown as JsonValue },
    });

    await expect(repository.enqueue(invalid)).rejects.toMatchObject({
      code: 'serialization_failed',
    });
    expect(
      normalizeIndexedDbError(new DOMException('full', 'QuotaExceededError'), 'enqueuing'),
    ).toMatchObject({ code: 'quota_exceeded' });
    await repository.close();
  });

  it('queues offline, reloads, persists a lost-response retry, and reconnects idempotently', async () => {
    const factory = new IDBFactory();
    const firstRepository = createRepository(factory, 'reload');
    const offline = new StaticConnectivity(false);
    const firstClock = new FakeClock(0);
    const firstTransport = new ScriptedTransport();
    const firstEngine = engineWith(firstRepository, firstTransport, offline, firstClock);
    const queued = await firstEngine.enqueue(
      createCustomer,
      { clientId: 'local-1', name: 'Ada' },
      { scope: 'pool-a' },
    );
    expect(await firstEngine.replay('pool-a')).toMatchObject({ outcome: 'offline' });
    await firstRepository.close();

    const retryRepository = createRepository(factory, 'reload');
    const retryClock = new FakeClock(0);
    const lostResponse = new ScriptedTransport().fail('network', 'response lost after commit');
    const retryEngine = engineWith(
      retryRepository,
      lostResponse,
      new StaticConnectivity(true),
      retryClock,
      [0.5],
    );
    expect(await retryEngine.replay('pool-a')).toMatchObject({ retried: 1 });
    expect(await retryRepository.get(queued.id)).toMatchObject({
      attempts: 1,
      nextAttemptAt: 500,
    });
    await retryRepository.close();

    const finalRepository = createRepository(factory, 'reload');
    const finalClock = new FakeClock(500);
    const success = new ScriptedTransport().respond(201, {
      id: 'server-42',
      clientId: 'local-1',
      name: 'Ada',
    });
    const finalEngine = engineWith(
      finalRepository,
      success,
      new StaticConnectivity(true),
      finalClock,
    );
    expect(await finalEngine.replay('pool-a')).toMatchObject({ succeeded: 1 });
    expect(lostResponse.calls[0]?.request.headers?.['Idempotency-Key']).toBe(queued.id);
    expect(success.calls[0]?.request.headers?.['Idempotency-Key']).toBe(queued.id);
    expect(success.calls[0]?.context.attempt).toBe(2);
    expect(await finalRepository.listReceipts('pool-a')).toHaveLength(1);
    await finalRepository.close();
  });
});

const createCustomer = defineOfflineOperation<
  { readonly clientId: string; readonly name: string },
  { readonly id: string; readonly clientId: string; readonly name: string }
>({
  kind: 'customers.create',
  version: 1,
  request: (input) => ({ method: 'POST', url: '/customers', body: { ...input } }),
  parseResult: (response) =>
    response.body as { readonly id: string; readonly clientId: string; readonly name: string },
  retryPolicy: { initialDelayMs: 1_000, jitter: 'full' },
});

function createRepository(factory: IDBFactory, databaseName: string) {
  return new IndexedDbOperationRepository({ databaseName, indexedDB: factory });
}

function engineWith(
  repository: IndexedDbOperationRepository,
  transport: ScriptedTransport,
  connectivity: StaticConnectivity,
  clock: FakeClock,
  random: readonly number[] = [0],
) {
  return new ReplayEngine(
    createOperationRegistry(createCustomer),
    {
      repository,
      transport,
      connectivity,
      clock,
      scheduler: new FakeScheduler(clock),
      uuid: new DeterministicUuidGenerator(),
      random: new SequenceRandomSource(random),
      lock: new InMemoryCoordinationLock(),
      events: new RecordingEventSink(),
    },
    { coordinationKey: 'reload-test' },
  );
}

function storedOperation(overrides: Partial<StoredOperation> = {}): StoredOperation {
  return {
    id: 'operation-1',
    kind: 'customers.create',
    version: 1,
    scope: 'pool-a',
    lane: 'default',
    input: { clientId: 'local-1', name: 'Ada' },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    createdAt: 1,
    updatedAt: 1,
    claimOwner: null,
    claimExpiresAt: null,
    lastFailure: null,
    ...overrides,
    dependencies: overrides.dependencies ?? [],
    produces: overrides.produces ?? [],
  };
}

function failure(code: string) {
  return {
    category: 'network' as const,
    code,
    failedAt: 10,
    message: code,
  };
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function createLegacyV1(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(INDEXED_DB_STORES.operations, { keyPath: 'id' });
      request.result.createObjectStore(INDEXED_DB_STORES.receipts, { keyPath: 'operationId' });
      request.result.createObjectStore(INDEXED_DB_STORES.references, {
        keyPath: ['scope', 'key'],
      });
      request.result.createObjectStore(INDEXED_DB_STORES.attachments, { keyPath: 'id' });
      request.result.createObjectStore(INDEXED_DB_STORES.metadata, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** Keeps the IndexedDB suite reachable from Angular's primary test root. */
export const indexedDbRepositorySuiteRegistered = true;
