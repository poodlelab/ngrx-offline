import { defineOfflineOperation } from '@poodlelab/ngrx-offline/core';
import { EngineTestHarness } from '@poodlelab/ngrx-offline/testing';
import { describe, expect, it } from 'vitest';
import {
  OfflineOperationSummary,
  offlineOutboxFeature,
  offlineOutboxInternalActions,
} from './lib/outbox-state';

const queueSize = 1_000;

const bulkCreate = defineOfflineOperation<{ readonly index: number }, { readonly id: string }>({
  kind: 'performance.bulk-create',
  version: 1,
  request: (input) => ({ method: 'POST', url: '/bulk', body: input }),
  parseResult: (response) => response.body as { readonly id: string },
});

describe('performance regression budgets', () => {
  it('enqueues and drains a 1,000-operation queue within the conservative CI budget', async () => {
    const harness = new EngineTestHarness([bulkCreate], {
      engine: { maximumConcurrentLanes: 8, maximumOperationsPerRun: queueSize + 1 },
    });
    for (let index = 0; index < queueSize; index += 1) {
      harness.transport.respond(201, { id: `server-${index}` });
    }

    const startedAt = performance.now();
    await Promise.all(
      Array.from({ length: queueSize }, (_, index) =>
        harness.engine.enqueue(
          bulkCreate,
          { index },
          { scope: 'performance-pool', lane: `lane-${index % 8}` },
        ),
      ),
    );
    const replay = await harness.engine.replay('performance-pool');
    const durationMs = performance.now() - startedAt;

    expect(replay).toMatchObject({
      outcome: 'drained',
      attempted: queueSize,
      succeeded: queueSize,
    });
    expect(await harness.repository.listReceipts('performance-pool')).toHaveLength(queueSize);
    expect(durationMs).toBeLessThan(10_000);
  });

  it('hydrates the payload-free DevTools projection for 5,000 operations within budget', () => {
    const operations = Array.from({ length: 5_000 }, (_, index): OfflineOperationSummary => ({
      id: `operation-${index}`,
      kind: 'performance.bulk-create',
      version: 1,
      scope: `pool-${index % 4}`,
      lane: `lane-${index % 8}`,
      status: index % 20 === 0 ? 'blocked' : 'pending',
      attempts: index % 3,
      nextAttemptAt: null,
      createdAt: index,
      updatedAt: index,
      failureCode: index % 20 === 0 ? 'conflict' : null,
      failureStatus: index % 20 === 0 ? 409 : null,
    }));

    const startedAt = performance.now();
    const state = offlineOutboxFeature.reducer(
      undefined,
      offlineOutboxInternalActions.hydrated({ scope: 'pool-0', operations }),
    );
    const durationMs = performance.now() - startedAt;

    expect(Object.keys(state.operations)).toHaveLength(5_000);
    expect(state.blockedCount).toBe(250);
    expect(state.pendingCount).toBe(4_750);
    expect(durationMs).toBeLessThan(1_500);
  });
});
