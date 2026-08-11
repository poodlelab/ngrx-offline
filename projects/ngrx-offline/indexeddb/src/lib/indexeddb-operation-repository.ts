import {
  EligibilityQuery,
  CoordinationLease,
  OperationClaim,
  OperationCompletion,
  OperationRepository,
  OperationMigrationUpdate,
  RemovalResult,
  ScopePause,
  ScopeOperationCounts,
  StoredFailure,
  StoredOperation,
  StoredReceipt,
  StoredReference,
  StoredRetry,
} from '@poodlelab/ngrx-offline/core';
import { IndexedDbRepositoryError, normalizeIndexedDbError } from './indexeddb-errors';

/** Current production database schema version. @alpha */
export const INDEXED_DB_SCHEMA_VERSION = 3;

/** Stable production object-store names. @alpha */
export const INDEXED_DB_STORES = {
  operations: 'operations',
  receipts: 'receipts',
  references: 'references',
  attachments: 'attachments',
  metadata: 'metadata',
} as const;

/** Stable operation index names used by migrations and diagnostics. @alpha */
export const OPERATION_INDEXES = {
  scope: 'by_scope',
  eligibility: 'by_scope_status_nextAttemptAt',
  lane: 'by_scope_lane_createdAt',
  claim: 'by_status_claimExpiresAt',
  kindVersion: 'by_kind_version',
} as const;

interface MetadataRecord {
  readonly key: string;
  readonly value: unknown;
}

/**
 * Construction settings for the production IndexedDB repository.
 *
 * @alpha
 */
export interface IndexedDbOperationRepositoryOptions {
  readonly databaseName: string;
  readonly indexedDB?: IDBFactory;
}

/**
 * IndexedDB-backed durable operation repository with versioned schema migrations.
 *
 * @alpha
 */
export class IndexedDbOperationRepository implements OperationRepository {
  private readonly factory: IDBFactory;
  private databasePromise: Promise<IDBDatabase> | undefined;

  constructor(private readonly options: IndexedDbOperationRepositoryOptions) {
    if (options.databaseName.trim() === '') {
      throw new IndexedDbRepositoryError('unavailable', 'The IndexedDB database name is required.');
    }
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (factory === undefined) {
      throw new IndexedDbRepositoryError(
        'unavailable',
        'IndexedDB is unavailable in the current execution context.',
      );
    }
    this.factory = factory;
  }

  async enqueue(operation: StoredOperation): Promise<void> {
    await this.write(
      [INDEXED_DB_STORES.operations],
      'enqueuing an operation',
      async (transaction) => {
        await requestResult(transaction.objectStore(INDEXED_DB_STORES.operations).add(operation));
      },
    );
  }

  async get(id: string): Promise<StoredOperation | undefined> {
    return this.read('reading an operation', async (database) => {
      const transaction = database.transaction(INDEXED_DB_STORES.operations, 'readonly');
      const done = transactionDone(transaction);
      const result = await requestResult<StoredOperation | undefined>(
        transaction.objectStore(INDEXED_DB_STORES.operations).get(id),
      );
      await done;
      return result === undefined ? undefined : normalizeOperation(result);
    });
  }

  async listOperations(scope?: string): Promise<readonly StoredOperation[]> {
    return this.read('listing operations', async (database) => {
      const transaction = database.transaction(INDEXED_DB_STORES.operations, 'readonly');
      const done = transactionDone(transaction);
      const operations = await requestResult<StoredOperation[]>(
        transaction.objectStore(INDEXED_DB_STORES.operations).getAll(),
      );
      await done;
      return operations
        .map(normalizeOperation)
        .filter((operation) => scope === undefined || operation.scope === scope)
        .sort(compareOperations);
    });
  }

  async listEligible(query: EligibilityQuery): Promise<readonly StoredOperation[]> {
    const operations = await this.listOperations(query.scope);
    const laneHeads = new Map<string, StoredOperation>();
    for (const operation of operations) {
      if (!laneHeads.has(operation.lane)) {
        laneHeads.set(operation.lane, operation);
      }
    }
    return [...laneHeads.values()]
      .filter(
        (operation) =>
          operation.status === 'pending' &&
          (operation.nextAttemptAt === null || operation.nextAttemptAt <= query.now),
      )
      .sort(compareOperations)
      .slice(0, query.limit);
  }

  async claim(id: string, claim: OperationClaim): Promise<StoredOperation | undefined> {
    return this.mutateOperation(id, 'claiming an operation', (operation) => {
      if (operation.status !== 'pending') {
        return undefined;
      }
      return {
        ...operation,
        status: 'executing',
        attempts: operation.attempts + 1,
        updatedAt: claim.claimedAt,
        claimOwner: claim.owner,
        claimExpiresAt: claim.expiresAt,
      };
    });
  }

  async renewClaim(
    id: string,
    owner: string,
    expiresAt: number,
    updatedAt: number,
  ): Promise<boolean> {
    const renewed = await this.mutateOperation(id, 'renewing an operation claim', (operation) => {
      if (operation.status !== 'executing' || operation.claimOwner !== owner) return undefined;
      return { ...operation, claimExpiresAt: expiresAt, updatedAt };
    });
    return renewed !== undefined;
  }

  async migrateOperation(update: OperationMigrationUpdate): Promise<StoredOperation | undefined> {
    return this.mutateOperation(update.id, 'migrating an operation input', (operation) => {
      if (operation.version !== update.expectedVersion || operation.status !== 'pending') {
        return undefined;
      }
      return {
        ...operation,
        version: update.version,
        input: update.input,
        lane: update.lane,
        dependencies: update.dependencies,
        produces: update.produces,
        updatedAt: update.updatedAt,
      };
    });
  }

  async scheduleRetry(id: string, retry: StoredRetry): Promise<void> {
    await this.requireMutation(id, 'scheduling an operation retry', (operation) => ({
      ...requireExecuting(operation),
      status: 'pending',
      attempts: retry.attempt,
      nextAttemptAt: retry.nextAttemptAt,
      updatedAt: retry.updatedAt,
      claimOwner: null,
      claimExpiresAt: null,
      lastFailure: retry.failure,
    }));
  }

  async releaseClaim(id: string, failure: StoredFailure, updatedAt: number): Promise<void> {
    await this.requireMutation(id, 'releasing an operation claim', (operation) => ({
      ...requireExecuting(operation),
      status: 'pending',
      nextAttemptAt: null,
      updatedAt,
      claimOwner: null,
      claimExpiresAt: null,
      lastFailure: failure,
    }));
  }

  async block(id: string, failure: StoredFailure, updatedAt: number): Promise<void> {
    await this.requireMutation(id, 'blocking an operation', (operation) => ({
      ...operation,
      status: 'blocked',
      nextAttemptAt: null,
      updatedAt,
      claimOwner: null,
      claimExpiresAt: null,
      lastFailure: failure,
    }));
  }

  async complete(completion: OperationCompletion): Promise<void> {
    await this.write(
      [INDEXED_DB_STORES.operations, INDEXED_DB_STORES.receipts, INDEXED_DB_STORES.references],
      'completing an operation',
      async (transaction) => {
        const operations = transaction.objectStore(INDEXED_DB_STORES.operations);
        const operation = await requestResult<StoredOperation | undefined>(
          operations.get(completion.operationId),
        );
        requireExecuting(operation);
        await requestResult(
          transaction.objectStore(INDEXED_DB_STORES.receipts).put(completion.receipt),
        );
        const references = transaction.objectStore(INDEXED_DB_STORES.references);
        for (const reference of completion.references) {
          await requestResult(references.put(reference));
        }
        await requestResult(operations.delete(completion.operationId));
      },
    );
  }

  cancel(id: string): Promise<RemovalResult> {
    return this.remove(id, 'cancelling an operation');
  }

  discard(id: string): Promise<RemovalResult> {
    return this.remove(id, 'discarding an operation');
  }

  async retryNow(id: string, updatedAt: number): Promise<boolean> {
    const updated = await this.mutateOperation(id, 'retrying an operation', (operation) => {
      if (operation.status === 'executing') {
        return undefined;
      }
      return {
        ...operation,
        status: 'pending',
        nextAttemptAt: null,
        updatedAt,
        lastFailure: null,
      };
    });
    return updated !== undefined;
  }

  async recoverExpiredClaims(now: number, scope?: string): Promise<readonly string[]> {
    const recovered: string[] = [];
    await this.write(
      [INDEXED_DB_STORES.operations],
      'recovering expired operation claims',
      async (transaction) => {
        const store = transaction.objectStore(INDEXED_DB_STORES.operations);
        const operations = await requestResult<StoredOperation[]>(store.getAll());
        for (const operation of operations.map(normalizeOperation).sort(compareOperations)) {
          if (
            operation.status === 'executing' &&
            operation.claimExpiresAt !== null &&
            operation.claimExpiresAt <= now &&
            (scope === undefined || operation.scope === scope)
          ) {
            await requestResult(
              store.put({
                ...operation,
                status: 'pending',
                updatedAt: now,
                claimOwner: null,
                claimExpiresAt: null,
              }),
            );
            recovered.push(operation.id);
          }
        }
      },
    );
    return recovered;
  }

  async pauseScope(pause: ScopePause): Promise<void> {
    await this.putMetadata(`pause:${pause.scope}`, pause, 'pausing a scope');
  }

  async resumeScope(scope: string): Promise<boolean> {
    return this.write([INDEXED_DB_STORES.metadata], 'resuming a scope', async (transaction) => {
      const store = transaction.objectStore(INDEXED_DB_STORES.metadata);
      const key = `pause:${scope}`;
      const existing = await requestResult<MetadataRecord | undefined>(store.get(key));
      if (existing === undefined) {
        return false;
      }
      await requestResult(store.delete(key));
      return true;
    });
  }

  async getScopePause(scope: string): Promise<ScopePause | undefined> {
    const record = await this.getMetadata(`pause:${scope}`, 'reading a scope pause');
    return record?.value as ScopePause | undefined;
  }

  async listReceipts(scope: string): Promise<readonly StoredReceipt[]> {
    return this.listStore<StoredReceipt>(
      INDEXED_DB_STORES.receipts,
      'listing receipts',
      (receipt) => receipt.scope === scope,
    ).then((receipts) =>
      receipts.sort((left, right) =>
        left.completedAt === right.completedAt
          ? left.operationId.localeCompare(right.operationId)
          : left.completedAt - right.completedAt,
      ),
    );
  }

  async listReferences(scope: string): Promise<readonly StoredReference[]> {
    return this.listStore<StoredReference>(
      INDEXED_DB_STORES.references,
      'listing references',
      (reference) => reference.scope === scope,
    ).then((references) => references.sort((left, right) => left.key.localeCompare(right.key)));
  }

  async resolveReferences(
    scope: string,
    keys: readonly string[],
  ): Promise<readonly StoredReference[]> {
    if (keys.length === 0) return [];
    return this.read('resolving references', async (database) => {
      const transaction = database.transaction(INDEXED_DB_STORES.references, 'readonly');
      const done = transactionDone(transaction);
      const store = transaction.objectStore(INDEXED_DB_STORES.references);
      const values = await Promise.all(
        keys.map((key) => requestResult<StoredReference | undefined>(store.get([scope, key]))),
      );
      await done;
      return values.filter((value): value is StoredReference => value !== undefined);
    });
  }

  async countOperationsByScope(): Promise<readonly ScopeOperationCounts[]> {
    const operations = await this.listOperations();
    const counts = new Map<string, { pending: number; blocked: number }>();
    for (const operation of operations) {
      const count = counts.get(operation.scope) ?? { pending: 0, blocked: 0 };
      if (operation.status === 'blocked') count.blocked += 1;
      else count.pending += 1;
      counts.set(operation.scope, count);
    }
    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([scope, count]) => ({ scope, ...count }));
  }

  async deleteScope(scope: string): Promise<void> {
    await this.write(
      [
        INDEXED_DB_STORES.operations,
        INDEXED_DB_STORES.receipts,
        INDEXED_DB_STORES.references,
        INDEXED_DB_STORES.metadata,
      ],
      'deleting a scope',
      async (transaction) => {
        for (const name of [
          INDEXED_DB_STORES.operations,
          INDEXED_DB_STORES.receipts,
          INDEXED_DB_STORES.references,
        ]) {
          const store = transaction.objectStore(name);
          const values = await requestResult<{ scope?: string }[]>(store.getAll());
          const keys = await requestResult<IDBValidKey[]>(store.getAllKeys());
          for (let index = 0; index < values.length; index += 1) {
            if (values[index]?.scope === scope && keys[index] !== undefined) {
              await requestResult(store.delete(keys[index] as IDBValidKey));
            }
          }
        }
        await requestResult(
          transaction.objectStore(INDEXED_DB_STORES.metadata).delete(`pause:${scope}`),
        );
      },
    );
  }

  async acquireCoordinationLease(lease: CoordinationLease, now: number): Promise<boolean> {
    return this.write(
      [INDEXED_DB_STORES.metadata],
      'acquiring a coordination lease',
      async (tx) => {
        const store = tx.objectStore(INDEXED_DB_STORES.metadata);
        const key = `lease:${lease.key}`;
        const record = await requestResult<MetadataRecord | undefined>(store.get(key));
        const existing = record?.value as CoordinationLease | undefined;
        if (existing !== undefined && existing.expiresAt > now && existing.owner !== lease.owner) {
          return false;
        }
        await requestResult(store.put({ key, value: lease } satisfies MetadataRecord));
        return true;
      },
    );
  }

  async renewCoordinationLease(lease: CoordinationLease): Promise<boolean> {
    return this.write([INDEXED_DB_STORES.metadata], 'renewing a coordination lease', async (tx) => {
      const store = tx.objectStore(INDEXED_DB_STORES.metadata);
      const key = `lease:${lease.key}`;
      const record = await requestResult<MetadataRecord | undefined>(store.get(key));
      if ((record?.value as CoordinationLease | undefined)?.owner !== lease.owner) return false;
      await requestResult(store.put({ key, value: lease } satisfies MetadataRecord));
      return true;
    });
  }

  async releaseCoordinationLease(keyValue: string, owner: string): Promise<boolean> {
    return this.write(
      [INDEXED_DB_STORES.metadata],
      'releasing a coordination lease',
      async (tx) => {
        const store = tx.objectStore(INDEXED_DB_STORES.metadata);
        const key = `lease:${keyValue}`;
        const record = await requestResult<MetadataRecord | undefined>(store.get(key));
        if ((record?.value as CoordinationLease | undefined)?.owner !== owner) return false;
        await requestResult(store.delete(key));
        return true;
      },
    );
  }

  async acknowledgeReceipt(operationId: string): Promise<boolean> {
    return this.write(
      [INDEXED_DB_STORES.receipts],
      'acknowledging a receipt',
      async (transaction) => {
        const store = transaction.objectStore(INDEXED_DB_STORES.receipts);
        const receipt = await requestResult<StoredReceipt | undefined>(store.get(operationId));
        if (receipt === undefined) {
          return false;
        }
        await requestResult(store.delete(operationId));
        return true;
      },
    );
  }

  /**
   * Closes this repository's database connection.
   *
   * @alpha
   */
  async close(): Promise<void> {
    const promise = this.databasePromise;
    this.databasePromise = undefined;
    if (promise !== undefined) {
      (await promise).close();
    }
  }

  private async database(): Promise<IDBDatabase> {
    this.databasePromise ??= this.openDatabase();
    return this.databasePromise;
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let migrationError: IndexedDbRepositoryError | undefined;
      const request = this.factory.open(this.options.databaseName, INDEXED_DB_SCHEMA_VERSION);
      request.onupgradeneeded = (event) => {
        try {
          migrateSchema(
            request.result,
            request.transaction,
            (event as IDBVersionChangeEvent).oldVersion,
          );
        } catch (error) {
          migrationError = new IndexedDbRepositoryError(
            'migration_failed',
            `IndexedDB migration failed for "${this.options.databaseName}".`,
            { cause: error },
          );
          request.transaction?.abort();
        }
      };
      request.onblocked = () =>
        reject(
          new IndexedDbRepositoryError(
            'migration_failed',
            `IndexedDB migration for "${this.options.databaseName}" is blocked by another connection.`,
          ),
        );
      request.onerror = () =>
        reject(
          migrationError ??
            normalizeIndexedDbError(request.error, `opening "${this.options.databaseName}"`),
        );
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
    });
  }

  private async read<T>(action: string, work: (database: IDBDatabase) => Promise<T>): Promise<T> {
    try {
      return await work(await this.database());
    } catch (error) {
      throw normalizeIndexedDbError(error, action);
    }
  }

  private async write<T>(
    stores: readonly string[],
    action: string,
    work: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    return this.read(action, async (database) => {
      const transaction = database.transaction([...stores], 'readwrite');
      const done = transactionDone(transaction);
      const result = await work(transaction);
      await done;
      return result;
    });
  }

  private async mutateOperation(
    id: string,
    action: string,
    mutate: (operation: StoredOperation) => StoredOperation | undefined,
  ): Promise<StoredOperation | undefined> {
    return this.write([INDEXED_DB_STORES.operations], action, async (transaction) => {
      const store = transaction.objectStore(INDEXED_DB_STORES.operations);
      const raw = await requestResult<StoredOperation | undefined>(store.get(id));
      const operation = raw === undefined ? undefined : normalizeOperation(raw);
      if (operation === undefined) {
        return undefined;
      }
      const updated = mutate(operation);
      if (updated === undefined) {
        return undefined;
      }
      await requestResult(store.put(updated));
      return updated;
    });
  }

  private async requireMutation(
    id: string,
    action: string,
    mutate: (operation: StoredOperation) => StoredOperation,
  ): Promise<void> {
    const result = await this.mutateOperation(id, action, mutate);
    if (result === undefined) {
      throw new Error(`Operation "${id}" does not exist.`);
    }
  }

  private async remove(id: string, action: string): Promise<RemovalResult> {
    return this.write([INDEXED_DB_STORES.operations], action, async (transaction) => {
      const store = transaction.objectStore(INDEXED_DB_STORES.operations);
      const operation = await requestResult<StoredOperation | undefined>(store.get(id));
      if (operation === undefined) {
        return 'not-found';
      }
      if (operation.status === 'executing') {
        return 'executing';
      }
      await requestResult(store.delete(id));
      return 'removed';
    });
  }

  private async putMetadata(key: string, value: unknown, action: string): Promise<void> {
    await this.write([INDEXED_DB_STORES.metadata], action, async (transaction) => {
      await requestResult(
        transaction
          .objectStore(INDEXED_DB_STORES.metadata)
          .put({ key, value } satisfies MetadataRecord),
      );
    });
  }

  private async getMetadata(key: string, action: string): Promise<MetadataRecord | undefined> {
    return this.read(action, async (database) => {
      const transaction = database.transaction(INDEXED_DB_STORES.metadata, 'readonly');
      const done = transactionDone(transaction);
      const record = await requestResult<MetadataRecord | undefined>(
        transaction.objectStore(INDEXED_DB_STORES.metadata).get(key),
      );
      await done;
      return record;
    });
  }

  private async listStore<T>(
    storeName: string,
    action: string,
    predicate: (value: T) => boolean,
  ): Promise<T[]> {
    return this.read(action, async (database) => {
      const transaction = database.transaction(storeName, 'readonly');
      const done = transactionDone(transaction);
      const values = await requestResult<T[]>(transaction.objectStore(storeName).getAll());
      await done;
      return values.filter(predicate);
    });
  }
}

function migrateSchema(
  database: IDBDatabase,
  transaction: IDBTransaction | null,
  oldVersion: number,
): void {
  if (transaction === null) {
    throw new Error('IndexedDB did not provide a migration transaction.');
  }
  if (oldVersion < 1) {
    const operations = database.createObjectStore(INDEXED_DB_STORES.operations, { keyPath: 'id' });
    operations.createIndex(OPERATION_INDEXES.scope, 'scope');
    operations.createIndex(OPERATION_INDEXES.eligibility, ['scope', 'status', 'nextAttemptAt']);
    operations.createIndex(OPERATION_INDEXES.lane, ['scope', 'lane', 'createdAt']);
    operations.createIndex(OPERATION_INDEXES.claim, ['status', 'claimExpiresAt']);

    const receipts = database.createObjectStore(INDEXED_DB_STORES.receipts, {
      keyPath: 'operationId',
    });
    receipts.createIndex('by_scope_completedAt', ['scope', 'completedAt']);

    const references = database.createObjectStore(INDEXED_DB_STORES.references, {
      keyPath: ['scope', 'key'],
    });
    references.createIndex('by_scope', 'scope');

    database.createObjectStore(INDEXED_DB_STORES.attachments, { keyPath: 'id' });
    database.createObjectStore(INDEXED_DB_STORES.metadata, { keyPath: 'key' });
  }
  if (oldVersion < 2) {
    transaction
      .objectStore(INDEXED_DB_STORES.operations)
      .createIndex(OPERATION_INDEXES.kindVersion, ['kind', 'version']);
  }
  if (oldVersion < 3) {
    const request = transaction.objectStore(INDEXED_DB_STORES.operations).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) return;
      cursor.update(normalizeOperation(cursor.value as StoredOperation));
      cursor.continue();
    };
  }
  transaction.objectStore(INDEXED_DB_STORES.metadata).put({
    key: 'schemaVersion',
    value: INDEXED_DB_SCHEMA_VERSION,
  } satisfies MetadataRecord);
}

function requestResult<T = IDBValidKey>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  });
}

function requireExecuting(operation: StoredOperation | undefined): StoredOperation {
  if (operation === undefined || operation.status !== 'executing') {
    throw new Error('The operation is not executing.');
  }
  return operation;
}

function compareOperations(left: StoredOperation, right: StoredOperation): number {
  return left.createdAt === right.createdAt
    ? left.id.localeCompare(right.id)
    : left.createdAt - right.createdAt;
}

function normalizeOperation(operation: StoredOperation): StoredOperation {
  return {
    ...operation,
    lane: operation.lane || 'default',
    dependencies: [...(operation.dependencies ?? [])],
    produces: [...(operation.produces ?? [])],
  };
}
