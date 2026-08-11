import { describe, expect, it, vi } from 'vitest';
import { StoredOperation, defineOfflineOperation } from '@poodlelab/ngrx-offline/core';
import {
  DeterministicUuidGenerator,
  FakeClock,
  FakeScheduler,
  InMemoryOperationRepository,
  ScriptedTransport,
  SequenceRandomSource,
  StaticConnectivity,
} from '@poodlelab/ngrx-offline/testing';
import { FetchOperationTransport } from './fetch-operation-transport';
import { WorkerOutboxExecutor, WorkerReplayNotifier } from './worker-outbox-executor';

const definition = defineOfflineOperation<{ readonly label: string }, { readonly id: number }>({
  kind: 'worker.item.create',
  version: 1,
  request: (input) => ({ method: 'POST', url: '/items', body: input }),
  parseResult: (response) => response.body as { readonly id: number },
});

export function workerOutboxExecutorTests(): void {
  describe('service-worker execution', () => {
    it('leaves work untouched when worker credentials are unavailable', async () => {
      const repository = new InMemoryOperationRepository();
      repository.seedOperation(operation());
      const transport = new ScriptedTransport().respond(201, { id: 10 });
      const notifications = new RecordingNotifier();
      const executor = createExecutor(repository, transport, notifications, false);

      await expect(executor.sync('workspace')).resolves.toEqual({
        status: 'deferred',
        reason: 'credentials-unavailable',
      });
      expect(await repository.get('operation-1')).toBeDefined();
      expect(transport.calls).toHaveLength(0);
      expect(notifications.events[0]).toMatchObject({ status: 'deferred', scope: 'workspace' });
    });

    it('recovers a terminated worker claim and commits a durable receipt', async () => {
      const repository = new InMemoryOperationRepository();
      repository.seedOperation({
        ...operation(),
        status: 'executing',
        attempts: 1,
        claimOwner: 'terminated-worker',
        claimExpiresAt: 50,
      });
      const transport = new ScriptedTransport().respond(201, { id: 42 });
      const executor = createExecutor(repository, transport, new RecordingNotifier(), true, 100);

      const result = await executor.sync('workspace');

      expect(result).toMatchObject({ status: 'completed', replay: { recoveredClaims: 1 } });
      expect(await repository.get('operation-1')).toBeUndefined();
      expect(await repository.listReceipts('workspace')).toEqual([
        expect.objectContaining({ operationId: 'operation-1', result: { id: 42 } }),
      ]);
    });

    it('serializes foreground-equivalent worker executors through the shared lease', async () => {
      const repository = new InMemoryOperationRepository();
      repository.seedOperation(operation());
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const transport = new ScriptedTransport().enqueue({
        type: 'handler',
        handle: async () => {
          await gate;
          return { status: 201, headers: {}, body: { id: 7 } };
        },
      });
      const first = createExecutor(repository, transport, new RecordingNotifier(), true, 0, 1);
      const second = createExecutor(repository, transport, new RecordingNotifier(), true, 0, 100);

      const firstReplay = first.sync('workspace');
      await vi.waitFor(() => expect(transport.calls).toHaveLength(1));
      const secondReplay = second.sync('workspace');
      release();
      await Promise.all([firstReplay, secondReplay]);

      expect(transport.calls).toHaveLength(1);
      expect(await repository.listReceipts('workspace')).toHaveLength(1);
    });

    it('enhances and executes a JSON fetch request without Angular dependencies', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(JSON.stringify({ id: 9 }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const transport = new FetchOperationTransport({
        fetch,
        enhanceRequest: (request) => ({
          ...request,
          url: `https://api.example.test${request.url}`,
          headers: { ...request.headers, Authorization: 'Bearer ephemeral' },
        }),
      });

      const response = await transport.execute(
        { method: 'POST', url: '/items', body: { label: 'Inspection' } },
        {
          operationId: 'op',
          idempotencyKey: 'op',
          kind: definition.kind,
          scope: 'workspace',
          attempt: 1,
        },
      );

      expect(response).toMatchObject({ status: 201, body: { id: 9 } });
      expect(fetch).toHaveBeenCalledWith(
        'https://api.example.test/items',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ label: 'Inspection' }) }),
      );
    });
  });
}

class RecordingNotifier implements WorkerReplayNotifier {
  readonly events: unknown[] = [];

  notify(event: unknown): void {
    this.events.push(event);
  }
}

function createExecutor(
  repository: InMemoryOperationRepository,
  transport: ScriptedTransport,
  notifier: WorkerReplayNotifier,
  credentialsAvailable: boolean,
  timestamp = 0,
  uuidStart = 1,
): WorkerOutboxExecutor {
  const clock = new FakeClock(timestamp);
  return new WorkerOutboxExecutor({
    databaseName: 'unused',
    definitions: [definition],
    transport,
    repository,
    notifier,
    canReplay: () => credentialsAvailable,
    clock,
    scheduler: new FakeScheduler(clock),
    uuid: new DeterministicUuidGenerator(uuidStart),
    random: new SequenceRandomSource(),
    connectivity: new StaticConnectivity(),
  });
}

function operation(): StoredOperation {
  return {
    id: 'operation-1',
    kind: definition.kind,
    version: definition.version,
    scope: 'workspace',
    lane: 'default',
    dependencies: [],
    produces: [],
    input: { label: 'Inspection' },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    createdAt: 1,
    updatedAt: 1,
    claimOwner: null,
    claimExpiresAt: null,
    lastFailure: null,
  };
}
