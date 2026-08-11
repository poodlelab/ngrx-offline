import {
  EligibilityQuery,
  CoordinationLease,
  JsonValue,
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

/**
 * Deterministic in-memory implementation of the durable repository contract.
 *
 * @alpha
 */
export class InMemoryOperationRepository implements OperationRepository {
  private readonly operations = new Map<string, StoredOperation>();
  private readonly receipts = new Map<string, StoredReceipt>();
  private readonly references = new Map<string, StoredReference>();
  private readonly pauses = new Map<string, ScopePause>();
  private readonly leases = new Map<string, CoordinationLease>();

  async enqueue(operation: StoredOperation): Promise<void> {
    if (this.operations.has(operation.id) || this.receipts.has(operation.id)) {
      throw new Error(`Operation "${operation.id}" already exists.`);
    }
    this.operations.set(operation.id, cloneOperation(operation));
  }

  async get(id: string): Promise<StoredOperation | undefined> {
    const operation = this.operations.get(id);
    return operation === undefined ? undefined : cloneOperation(operation);
  }

  async listOperations(scope?: string): Promise<readonly StoredOperation[]> {
    return this.sortedOperations(scope).map(cloneOperation);
  }

  async listEligible(query: EligibilityQuery): Promise<readonly StoredOperation[]> {
    const laneHeads = new Map<string, StoredOperation>();
    for (const operation of this.sortedOperations(query.scope)) {
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
      .slice(0, query.limit)
      .map(cloneOperation);
  }

  async claim(id: string, claim: OperationClaim): Promise<StoredOperation | undefined> {
    const operation = this.operations.get(id);
    if (operation === undefined || operation.status !== 'pending') {
      return undefined;
    }
    const claimed: StoredOperation = {
      ...operation,
      status: 'executing',
      attempts: operation.attempts + 1,
      updatedAt: claim.claimedAt,
      claimOwner: claim.owner,
      claimExpiresAt: claim.expiresAt,
    };
    this.operations.set(id, claimed);
    return cloneOperation(claimed);
  }

  async renewClaim(
    id: string,
    owner: string,
    expiresAt: number,
    updatedAt: number,
  ): Promise<boolean> {
    const operation = this.operations.get(id);
    if (operation?.status !== 'executing' || operation.claimOwner !== owner) return false;
    this.operations.set(id, { ...operation, claimExpiresAt: expiresAt, updatedAt });
    return true;
  }

  async migrateOperation(update: OperationMigrationUpdate): Promise<StoredOperation | undefined> {
    const operation = this.operations.get(update.id);
    if (operation === undefined || operation.version !== update.expectedVersion) return undefined;
    const migrated = cloneOperation({
      ...operation,
      version: update.version,
      input: update.input,
      lane: update.lane,
      dependencies: update.dependencies,
      produces: update.produces,
      updatedAt: update.updatedAt,
    });
    this.operations.set(update.id, migrated);
    return cloneOperation(migrated);
  }

  async scheduleRetry(id: string, retry: StoredRetry): Promise<void> {
    const operation = this.requiredExecuting(id);
    this.operations.set(id, {
      ...operation,
      status: 'pending',
      attempts: retry.attempt,
      nextAttemptAt: retry.nextAttemptAt,
      updatedAt: retry.updatedAt,
      claimOwner: null,
      claimExpiresAt: null,
      lastFailure: cloneFailure(retry.failure),
    });
  }

  async releaseClaim(id: string, failure: StoredFailure, updatedAt: number): Promise<void> {
    const operation = this.requiredExecuting(id);
    this.operations.set(id, {
      ...operation,
      status: 'pending',
      nextAttemptAt: null,
      updatedAt,
      claimOwner: null,
      claimExpiresAt: null,
      lastFailure: cloneFailure(failure),
    });
  }

  async block(id: string, failure: StoredFailure, updatedAt: number): Promise<void> {
    const operation = this.operations.get(id);
    if (operation === undefined) {
      throw new Error(`Operation "${id}" does not exist.`);
    }
    this.operations.set(id, {
      ...operation,
      status: 'blocked',
      nextAttemptAt: null,
      updatedAt,
      claimOwner: null,
      claimExpiresAt: null,
      lastFailure: cloneFailure(failure),
    });
  }

  async complete(completion: OperationCompletion): Promise<void> {
    this.requiredExecuting(completion.operationId);
    this.receipts.set(completion.operationId, cloneReceipt(completion.receipt));
    for (const reference of completion.references) {
      this.references.set(referenceIdentity(reference), { ...reference });
    }
    this.operations.delete(completion.operationId);
  }

  cancel(id: string): Promise<RemovalResult> {
    return this.remove(id);
  }

  discard(id: string): Promise<RemovalResult> {
    return this.remove(id);
  }

  async retryNow(id: string, updatedAt: number): Promise<boolean> {
    const operation = this.operations.get(id);
    if (operation === undefined || operation.status === 'executing') {
      return false;
    }
    this.operations.set(id, {
      ...operation,
      status: 'pending',
      nextAttemptAt: null,
      updatedAt,
      lastFailure: null,
    });
    return true;
  }

  async recoverExpiredClaims(now: number, scope?: string): Promise<readonly string[]> {
    const recovered: string[] = [];
    for (const operation of this.sortedOperations(scope)) {
      if (
        operation.status === 'executing' &&
        operation.claimExpiresAt !== null &&
        operation.claimExpiresAt <= now
      ) {
        this.operations.set(operation.id, {
          ...operation,
          status: 'pending',
          updatedAt: now,
          claimOwner: null,
          claimExpiresAt: null,
        });
        recovered.push(operation.id);
      }
    }
    return recovered;
  }

  async pauseScope(pause: ScopePause): Promise<void> {
    this.pauses.set(pause.scope, { ...pause });
  }

  async resumeScope(scope: string): Promise<boolean> {
    return this.pauses.delete(scope);
  }

  async getScopePause(scope: string): Promise<ScopePause | undefined> {
    const pause = this.pauses.get(scope);
    return pause === undefined ? undefined : { ...pause };
  }

  async listReceipts(scope: string): Promise<readonly StoredReceipt[]> {
    return [...this.receipts.values()]
      .filter((receipt) => receipt.scope === scope)
      .sort((left, right) =>
        left.completedAt === right.completedAt
          ? left.operationId.localeCompare(right.operationId)
          : left.completedAt - right.completedAt,
      )
      .map(cloneReceipt);
  }

  async listReferences(scope: string): Promise<readonly StoredReference[]> {
    return [...this.references.values()]
      .filter((reference) => reference.scope === scope)
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((reference) => ({ ...reference }));
  }

  async resolveReferences(
    scope: string,
    keys: readonly string[],
  ): Promise<readonly StoredReference[]> {
    return keys
      .map((key) => this.references.get(referenceIdentity({ scope, key } as StoredReference)))
      .filter((reference): reference is StoredReference => reference !== undefined)
      .map((reference) => ({ ...reference }));
  }

  async countOperationsByScope(): Promise<readonly ScopeOperationCounts[]> {
    const counts = new Map<string, { pending: number; blocked: number }>();
    for (const operation of this.operations.values()) {
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
    for (const [id, operation] of this.operations) {
      if (operation.scope === scope) this.operations.delete(id);
    }
    for (const [id, receipt] of this.receipts) {
      if (receipt.scope === scope) this.receipts.delete(id);
    }
    for (const [id, reference] of this.references) {
      if (reference.scope === scope) this.references.delete(id);
    }
    this.pauses.delete(scope);
  }

  async acquireCoordinationLease(lease: CoordinationLease, now: number): Promise<boolean> {
    const existing = this.leases.get(lease.key);
    if (existing !== undefined && existing.expiresAt > now && existing.owner !== lease.owner) {
      return false;
    }
    this.leases.set(lease.key, { ...lease });
    return true;
  }

  async renewCoordinationLease(lease: CoordinationLease): Promise<boolean> {
    if (this.leases.get(lease.key)?.owner !== lease.owner) return false;
    this.leases.set(lease.key, { ...lease });
    return true;
  }

  async releaseCoordinationLease(key: string, owner: string): Promise<boolean> {
    if (this.leases.get(key)?.owner !== owner) return false;
    return this.leases.delete(key);
  }

  async acknowledgeReceipt(operationId: string): Promise<boolean> {
    return this.receipts.delete(operationId);
  }

  /**
   * Seeds a durable state that would normally have survived an earlier process.
   *
   * @alpha
   */
  seedOperation(operation: StoredOperation): void {
    this.operations.set(operation.id, cloneOperation(operation));
  }

  private sortedOperations(scope?: string): StoredOperation[] {
    return [...this.operations.values()]
      .filter((operation) => scope === undefined || operation.scope === scope)
      .sort(compareOperations);
  }

  private requiredExecuting(id: string): StoredOperation {
    const operation = this.operations.get(id);
    if (operation === undefined || operation.status !== 'executing') {
      throw new Error(`Operation "${id}" is not executing.`);
    }
    return operation;
  }

  private async remove(id: string): Promise<RemovalResult> {
    const operation = this.operations.get(id);
    if (operation === undefined) {
      return 'not-found';
    }
    if (operation.status === 'executing') {
      return 'executing';
    }
    this.operations.delete(id);
    return 'removed';
  }
}

function referenceIdentity(reference: StoredReference): string {
  return `${reference.scope}\u0000${reference.key}`;
}

function compareOperations(left: StoredOperation, right: StoredOperation): number {
  return left.createdAt === right.createdAt
    ? left.id.localeCompare(right.id)
    : left.createdAt - right.createdAt;
}

function cloneOperation(operation: StoredOperation): StoredOperation {
  return {
    ...operation,
    dependencies: [...(operation.dependencies ?? [])],
    produces: [...(operation.produces ?? [])],
    input: cloneKnownJson(operation.input),
    lastFailure: operation.lastFailure === null ? null : cloneFailure(operation.lastFailure),
  };
}

function cloneFailure(failure: StoredFailure): StoredFailure {
  return {
    ...failure,
    ...(failure.detail === undefined ? {} : { detail: cloneKnownJson(failure.detail) }),
  };
}

function cloneReceipt(receipt: StoredReceipt): StoredReceipt {
  return {
    ...receipt,
    input: cloneKnownJson(receipt.input),
    result: cloneKnownJson(receipt.result),
    producedReferences: receipt.producedReferences.map((reference) => ({ ...reference })),
  };
}

function cloneKnownJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(cloneKnownJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneKnownJson(nested)]),
    );
  }
  return value;
}
