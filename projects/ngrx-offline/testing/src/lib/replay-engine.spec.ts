import {
  OfflineInputError,
  OperationRegistry,
  StoredOperation,
  calculateRetryDelay,
  defineOfflineOperation,
} from '@poodlelab/ngrx-offline/core';
import { describe, expect, it } from 'vitest';
import { EngineTestHarness } from './engine-test-harness';
import { SequenceRandomSource } from './fakes';

interface CreateCustomerInput {
  readonly clientId: string;
  readonly name: string;
}

interface CustomerResult {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
}

const createCustomer = defineOfflineOperation<CreateCustomerInput, CustomerResult>({
  kind: 'showcase.customer-create',
  version: 1,
  request: (input) => ({
    method: 'POST',
    url: '/customers',
    body: { clientId: input.clientId, name: input.name },
  }),
  parseResult: (response) => response.body as CustomerResult,
  produces: ({ input, result }) => [{ key: `customer:${input.clientId}`, value: result.id }],
  retryPolicy: {
    initialDelayMs: 1_000,
    maximumDelayMs: 10_000,
    multiplier: 2,
    jitter: 'full',
    maximumAttempts: 4,
  },
});

describe('ReplayEngine', () => {
  it('executes the Customer create flow FIFO and persists receipts before success events', async () => {
    const harness = new EngineTestHarness([createCustomer]);
    harness.transport.respond(201, { id: 'srv-1', clientId: 'local-1', name: 'Ada' });
    harness.transport.respond(201, { id: 'srv-2', clientId: 'local-2', name: 'Grace' });

    const first = await harness.engine.enqueue(
      createCustomer,
      { clientId: 'local-1', name: 'Ada' },
      { scope: 'pool-a' },
    );
    const second = await harness.engine.enqueue(
      createCustomer,
      { clientId: 'local-2', name: 'Grace' },
      { scope: 'pool-a' },
    );
    const replay = await harness.engine.replay('pool-a');

    expect(replay).toMatchObject({ outcome: 'drained', attempted: 2, succeeded: 2 });
    expect(harness.transport.calls.map((call) => call.context.operationId)).toEqual([
      first.id,
      second.id,
    ]);
    expect(harness.transport.calls[0]?.request.headers).toMatchObject({
      'Idempotency-Key': first.id,
    });
    expect(harness.events.events.map((event) => event.type)).toEqual([
      'queued',
      'queued',
      'execution-started',
      'succeeded',
      'execution-started',
      'succeeded',
    ]);

    const receipts = await harness.repository.listReceipts('pool-a');
    expect(receipts[0]).toMatchObject({
      operationId: first.id,
      result: { id: 'srv-1' },
      producedReferences: [{ key: 'customer:local-1', value: 'srv-1' }],
    });
    expect(await harness.repository.listOperations()).toEqual([]);
  });

  it('persists retry attempts and uses deterministic full jitter', async () => {
    const harness = new EngineTestHarness([createCustomer], { random: [0.5] });
    harness.transport.fail('network').respond(201, {
      id: 'srv-1',
      clientId: 'local-1',
      name: 'Ada',
    });
    const operation = await harness.engine.enqueue(
      createCustomer,
      { clientId: 'local-1', name: 'Ada' },
      { scope: 'pool-a' },
    );

    const firstRun = await harness.engine.replay('pool-a');
    const pending = await harness.repository.get(operation.id);
    expect(firstRun).toMatchObject({ retried: 1, attempted: 1 });
    expect(pending).toMatchObject({ attempts: 1, nextAttemptAt: 500, status: 'pending' });
    expect(harness.scheduler.pendingTimes()).toEqual([500]);

    await harness.scheduler.advanceBy(500);

    expect(harness.transport.calls.map((call) => call.context.attempt)).toEqual([1, 2]);
    expect(await harness.repository.get(operation.id)).toBeUndefined();
    expect(await harness.repository.listReceipts('pool-a')).toHaveLength(1);
  });

  it('blocks a permanent failure and preserves FIFO behind the blocked lane head', async () => {
    const harness = new EngineTestHarness([createCustomer]);
    harness.transport.respond(422, { code: 'invalid' }).respond(201, {
      id: 'not-sent',
      clientId: 'local-2',
      name: 'Grace',
    });
    const first = await harness.engine.enqueue(
      createCustomer,
      { clientId: 'local-1', name: 'Ada' },
      { scope: 'pool-a' },
    );
    await harness.engine.enqueue(
      createCustomer,
      { clientId: 'local-2', name: 'Grace' },
      { scope: 'pool-a' },
    );

    const result = await harness.engine.replay('pool-a');

    expect(result.blocked).toBe(1);
    expect(harness.transport.calls).toHaveLength(1);
    expect(await harness.repository.get(first.id)).toMatchObject({
      status: 'blocked',
      lastFailure: { code: 'permanent_failure', status: 422 },
    });

    expect(await harness.engine.discard(first.id)).toBe('removed');
    expect(await harness.engine.replay('pool-a')).toMatchObject({ succeeded: 1 });
    expect(harness.transport.calls).toHaveLength(2);
  });

  it('pauses an authenticated scope and resumes the same durable operation', async () => {
    const harness = new EngineTestHarness([createCustomer]);
    harness.transport.respond(401, null).respond(201, {
      id: 'srv-1',
      clientId: 'local-1',
      name: 'Ada',
    });
    const operation = await harness.engine.enqueue(
      createCustomer,
      { clientId: 'local-1', name: 'Ada' },
      { scope: 'pool-a' },
    );

    expect(await harness.engine.replay('pool-a')).toMatchObject({ outcome: 'scope-paused' });
    expect(await harness.repository.get(operation.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
    });
    expect(await harness.engine.replay('pool-a')).toMatchObject({
      outcome: 'scope-paused',
      attempted: 0,
    });

    expect(await harness.engine.resumeScope('pool-a')).toBe(true);
    expect(await harness.engine.replay('pool-a')).toMatchObject({ succeeded: 1 });
    expect(harness.transport.calls.map((call) => call.context.attempt)).toEqual([1, 2]);
  });

  it('cancels pending work without sending it', async () => {
    const harness = new EngineTestHarness([createCustomer]);
    const operation = await harness.engine.enqueue(
      createCustomer,
      { clientId: 'local-1', name: 'Ada' },
      { scope: 'pool-a' },
    );

    expect(await harness.engine.cancel(operation.id)).toBe('removed');
    expect(await harness.engine.replay('pool-a')).toMatchObject({ attempted: 0 });
    expect(harness.transport.calls).toEqual([]);
  });

  it('rejects cancellation after send and still records the server success', async () => {
    const harness = new EngineTestHarness([createCustomer]);
    let resolveResponse!: (response: {
      status: number;
      headers: Readonly<Record<string, string>>;
      body: unknown;
    }) => void;
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => (announceStarted = resolve));
    const deferred = new Promise<{
      status: number;
      headers: Readonly<Record<string, string>>;
      body: unknown;
    }>((resolve) => (resolveResponse = resolve));
    harness.transport.enqueue({
      type: 'handler',
      handle: () => {
        announceStarted();
        return deferred;
      },
    });
    const operation = await harness.engine.enqueue(
      createCustomer,
      { clientId: 'local-1', name: 'Ada' },
      { scope: 'pool-a' },
    );

    const replay = harness.engine.replay('pool-a');
    await started;
    expect(await harness.engine.cancel(operation.id)).toBe('executing');
    resolveResponse({
      status: 201,
      headers: {},
      body: { id: 'srv-1', clientId: 'local-1', name: 'Ada' },
    });
    await replay;

    expect(await harness.repository.listReceipts('pool-a')).toHaveLength(1);
    expect(harness.events.events.at(-2)?.type).toBe('removal-rejected');
    expect(harness.events.events.at(-1)?.type).toBe('succeeded');
  });

  it('recovers an expired claim and retries it with the persisted attempt count', async () => {
    const harness = new EngineTestHarness([createCustomer], {
      engine: { claimDurationMs: 100 },
    });
    harness.transport.respond(201, {
      id: 'srv-1',
      clientId: 'local-1',
      name: 'Ada',
    });
    const operation = await harness.engine.enqueue(
      createCustomer,
      { clientId: 'local-1', name: 'Ada' },
      { scope: 'pool-a' },
    );
    await harness.repository.claim(operation.id, {
      owner: 'dead-owner',
      claimedAt: 0,
      expiresAt: 100,
    });
    harness.clock.set(101);

    const result = await harness.engine.replay('pool-a');

    expect(result).toMatchObject({ recoveredClaims: 1, succeeded: 1 });
    expect(harness.transport.calls[0]?.context.attempt).toBe(2);
    expect(harness.events.events.some((event) => event.type === 'claims-recovered')).toBe(true);
  });

  it('replays only the requested data-pool scope', async () => {
    const harness = new EngineTestHarness([createCustomer]);
    harness.transport.respond(201, { id: 'srv-a', clientId: 'a', name: 'Ada' });
    const poolA = await harness.engine.enqueue(
      createCustomer,
      { clientId: 'a', name: 'Ada' },
      { scope: 'pool-a' },
    );
    const poolB = await harness.engine.enqueue(
      createCustomer,
      { clientId: 'b', name: 'Grace' },
      { scope: 'pool-b' },
    );

    await harness.engine.replay('pool-a');

    expect(harness.transport.calls[0]?.context.operationId).toBe(poolA.id);
    expect(await harness.repository.get(poolB.id)).toMatchObject({ status: 'pending' });
    expect(await harness.repository.listReceipts('pool-b')).toEqual([]);
  });

  it('delivers durable receipts at least once until explicit acknowledgement', async () => {
    const harness = new EngineTestHarness([createCustomer]);
    harness.transport.respond(201, { id: 'srv-1', clientId: 'a', name: 'Ada' });
    const operation = await harness.engine.enqueue(
      createCustomer,
      { clientId: 'a', name: 'Ada' },
      { scope: 'pool-a' },
    );
    await harness.engine.replay('pool-a');

    expect(await harness.repository.listReceipts('pool-a')).toHaveLength(1);
    expect(await harness.repository.listReceipts('pool-a')).toHaveLength(1);
    expect(await harness.repository.acknowledgeReceipt(operation.id)).toBe(true);
    expect(await harness.repository.listReceipts('pool-a')).toEqual([]);
  });

  it.each([
    ['unknown_operation_definition', 'missing.kind', 1, []],
    ['missing_operation_migration', createCustomer.kind, 0, [createCustomer]],
  ])('blocks %s without sending', async (code, kind, version, definitions) => {
    const harness = new EngineTestHarness(definitions);
    const operation = storedOperation({ kind, version });
    harness.repository.seedOperation(operation);

    await harness.engine.replay(operation.scope);

    expect(await harness.repository.get(operation.id)).toMatchObject({
      status: 'blocked',
      lastFailure: { code },
    });
    expect(harness.transport.calls).toEqual([]);
  });

  it('rejects non-JSON input before touching the repository', async () => {
    const harness = new EngineTestHarness([createCustomer]);
    const invalid = { clientId: 'local-1', name: 'Ada', createdAt: new Date() };

    await expect(
      harness.engine.enqueue(createCustomer, invalid, { scope: 'pool-a' }),
    ).rejects.toBeInstanceOf(OfflineInputError);
    expect(await harness.repository.listOperations()).toEqual([]);
  });
});

describe('Phase 2 deterministic contracts', () => {
  it('rejects duplicate globally unique operation kinds', () => {
    expect(() => new OperationRegistry([createCustomer, createCustomer])).toThrow(
      /registered more than once/,
    );
  });

  it('rejects invalid persisted definition versions', () => {
    expect(
      () =>
        new OperationRegistry([
          defineOfflineOperation({
            kind: 'showcase.invalid-version',
            version: 0,
            request: () => ({ method: 'POST', url: '/invalid' }),
          }),
        ]),
    ).toThrow(/positive safe-integer version/);
  });

  it('keeps retry jitter inside its exact deterministic boundaries', () => {
    const policy = { initialDelayMs: 1_000, maximumDelayMs: 10_000, multiplier: 2 };
    expect(calculateRetryDelay(policy, 1, new SequenceRandomSource([0]))).toBe(0);
    expect(calculateRetryDelay(policy, 1, new SequenceRandomSource([0.999]))).toBe(999);
    expect(calculateRetryDelay(policy, 5, new SequenceRandomSource([0.5]))).toBe(5_000);
  });
});

function storedOperation(overrides: Partial<StoredOperation>): StoredOperation {
  return {
    id: '00000000-0000-4000-8000-000000009999',
    kind: 'showcase.customer-create',
    version: 1,
    scope: 'pool-a',
    lane: 'default',
    input: { clientId: 'local-1', name: 'Ada' },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    createdAt: 0,
    updatedAt: 0,
    claimOwner: null,
    claimExpiresAt: null,
    lastFailure: null,
    ...overrides,
    dependencies: overrides.dependencies ?? [],
    produces: overrides.produces ?? [],
  };
}

/** Keeps the secondary-entry-point suite reachable from Angular's primary test root. */
export const phase2CoreSuiteRegistered = true;
