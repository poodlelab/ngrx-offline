import { describe, expect, it } from 'vitest';
import {
  OfflineReference,
  ReplayEngine,
  createOperationRegistry,
  defineOfflineOperation,
  offlineRef,
  resolvedRef,
} from '@poodlelab/ngrx-offline/core';
import { BrowserCoordinationLock } from '@poodlelab/ngrx-offline/indexeddb';
import {
  DeterministicUuidGenerator,
  EngineTestHarness,
  FakeClock,
  FakeScheduler,
  InMemoryOperationRepository,
  RecordingEventSink,
  ScriptedTransport,
  SequenceRandomSource,
  StaticConnectivity,
} from '@poodlelab/ngrx-offline/testing';

interface CreateInput {
  readonly clientId: string;
  readonly name: string;
  readonly parent?: OfflineReference;
}

interface CreateResult {
  readonly id: number;
}

function createDefinition(kind: string, entity: string, path: string, parentField?: string) {
  return defineOfflineOperation<CreateInput, CreateResult>({
    kind,
    version: 1,
    lane: (input) => `chain:${input.clientId}`,
    dependencies: (input) => (input.parent === undefined ? [] : [input.parent]),
    producesKeys: (input) => [offlineRef(entity, input.clientId).key],
    request: (input, context) => ({
      method: 'POST',
      url: path,
      body: {
        clientId: input.clientId,
        name: input.name,
        ...(input.parent === undefined || parentField === undefined
          ? {}
          : { [parentField]: context.resolve(input.parent) }),
      },
    }),
    parseResult: (response) => response.body as CreateResult,
    produces: ({ input, result }) => [resolvedRef(offlineRef(entity, input.clientId), result.id)],
  });
}

const createCustomer = createDefinition('showcase.customer-create', 'customer', '/customers');
const createProject = createDefinition(
  'showcase.project-create',
  'project',
  '/projects',
  'customerId',
);
const createWorkOrder = createDefinition(
  'showcase.work-order-create',
  'work-order',
  '/work-orders',
  'projectId',
);
const createChecklist = createDefinition(
  'showcase.checklist-create',
  'checklist',
  '/checklist-entries',
  'workOrderId',
);

describe('relational replay', () => {
  it('synchronizes a four-level offline relationship chain with numeric server IDs', async () => {
    const harness = new EngineTestHarness([
      createCustomer,
      createProject,
      createWorkOrder,
      createChecklist,
    ]);
    const customer = offlineRef('customer', 'customer-local');
    const project = offlineRef('project', 'project-local');
    const workOrder = offlineRef('work-order', 'work-local');
    await harness.engine.enqueue(
      createCustomer,
      { clientId: 'customer-local', name: 'Ada Services' },
      { scope: 'workspace-a', lane: 'relationship-chain' },
    );
    await harness.engine.enqueue(
      createProject,
      { clientId: 'project-local', name: 'North Site', parent: customer },
      { scope: 'workspace-a', lane: 'relationship-chain' },
    );
    await harness.engine.enqueue(
      createWorkOrder,
      { clientId: 'work-local', name: 'Boiler inspection', parent: project },
      { scope: 'workspace-a', lane: 'relationship-chain' },
    );
    await harness.engine.enqueue(
      createChecklist,
      { clientId: 'check-local', name: 'Photograph serial', parent: workOrder },
      { scope: 'workspace-a', lane: 'relationship-chain' },
    );
    harness.transport.respond(201, { id: 101 });
    harness.transport.respond(201, { id: 202 });
    harness.transport.respond(201, { id: 303 });
    harness.transport.respond(201, { id: 404 });

    const result = await harness.engine.replay('workspace-a');

    expect(result.succeeded).toBe(4);
    expect(harness.transport.calls.map((call) => call.request.body)).toEqual([
      { clientId: 'customer-local', name: 'Ada Services' },
      { clientId: 'project-local', name: 'North Site', customerId: 101 },
      { clientId: 'work-local', name: 'Boiler inspection', projectId: 202 },
      { clientId: 'check-local', name: 'Photograph serial', workOrderId: 303 },
    ]);
    expect(await harness.repository.listReferences('workspace-a')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: customer.key, value: 101 }),
        expect.objectContaining({ key: project.key, value: 202 }),
        expect.objectContaining({ key: workOrder.key, value: 303 }),
      ]),
    );
  });

  it('never resolves a dependency from another scope and diagnoses the missing mapping', async () => {
    const harness = new EngineTestHarness([createCustomer, createProject]);
    const parent = offlineRef('customer', 'shared-client-id');
    await harness.engine.enqueue(
      createCustomer,
      { clientId: 'shared-client-id', name: 'Scope A' },
      { scope: 'workspace-a' },
    );
    harness.transport.respond(201, { id: 77 });
    await harness.engine.replay('workspace-a');
    const child = await harness.engine.enqueue(
      createProject,
      { clientId: 'project-b', name: 'Scope B project', parent },
      { scope: 'workspace-b' },
    );

    await harness.engine.replay('workspace-b');

    expect((await harness.repository.get(child.id))?.lastFailure?.code).toBe('missing_dependency');
    expect(harness.transport.calls).toHaveLength(1);
  });

  it('runs independent named lanes concurrently while preserving each lane head', async () => {
    const definition = defineOfflineOperation<{ id: string; lane: string }, { id: number }>({
      kind: 'showcase.concurrent',
      version: 1,
      lane: (input) => input.lane,
      request: (input) => ({ method: 'POST', url: `/items/${input.id}` }),
    });
    const harness = new EngineTestHarness([definition], {
      engine: { maximumConcurrentLanes: 2 },
    });
    await harness.engine.enqueue(definition, { id: 'a', lane: 'lane-a' }, { scope: 'pool' });
    await harness.engine.enqueue(definition, { id: 'b', lane: 'lane-b' }, { scope: 'pool' });
    let active = 0;
    let maximumActive = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const handler = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return { status: 201, headers: {}, body: { id: 1 } };
    };
    harness.transport.enqueue(
      { type: 'handler', handle: handler },
      { type: 'handler', handle: handler },
    );
    const replay = harness.engine.replay('pool');
    await eventually(() => harness.transport.calls.length === 2);
    release();
    await replay;
    expect(maximumActive).toBe(2);
  });

  it('chains and durably applies old input versions before transport', async () => {
    const current = defineOfflineOperation<{ label: string; enabled: boolean }, { id: number }>({
      kind: 'showcase.migrated',
      version: 3,
      migrations: [
        {
          fromVersion: 1,
          toVersion: 2,
          migrate: (input) => ({ label: (input as { name: string }).name }),
        },
        {
          fromVersion: 2,
          toVersion: 3,
          migrate: (input) => ({ ...(input as { label: string }), enabled: true }),
        },
      ],
      request: (input) => ({ method: 'POST', url: '/migrated', body: input }),
    });
    const harness = new EngineTestHarness([current]);
    harness.repository.seedOperation({
      id: 'old-operation',
      kind: current.kind,
      version: 1,
      scope: 'pool',
      lane: 'default',
      dependencies: [],
      produces: [],
      input: { name: 'legacy' },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      createdAt: 1,
      updatedAt: 1,
      claimOwner: null,
      claimExpiresAt: null,
      lastFailure: null,
    });
    harness.transport.respond(201, { id: 1 });

    await harness.engine.replay('pool');

    expect(harness.transport.calls[0]?.request.body).toEqual({ label: 'legacy', enabled: true });
    expect((await harness.repository.listReceipts('pool'))[0]).toMatchObject({
      version: 3,
      input: { label: 'legacy', enabled: true },
    });
    expect(harness.events.events).toContainEqual(
      expect.objectContaining({ type: 'operation-migrated', fromVersion: 1, toVersion: 3 }),
    );
  });
});

describe('cross-context coordination', () => {
  it('allows only one transport call when two tab engines replay the same scope', async () => {
    const repository = new InMemoryOperationRepository();
    const clock = new FakeClock(0);
    const scheduler = new FakeScheduler(clock);
    const transport = new ScriptedTransport();
    const definition = defineOfflineOperation<{ id: string }, { id: number }>({
      kind: 'showcase.single-owner',
      version: 1,
      request: () => ({ method: 'POST', url: '/single-owner' }),
    });
    const registry = createOperationRegistry(definition);
    let wakeSecond = (): void => undefined;
    const lockOptions = { repository, clock, scheduler, webLocks: null } as const;
    const firstLock = new BrowserCoordinationLock({
      ...lockOptions,
      uuid: new DeterministicUuidGenerator(100),
    });
    const secondLock = new BrowserCoordinationLock({
      ...lockOptions,
      uuid: new DeterministicUuidGenerator(200),
      wait: () => new Promise<void>((resolve) => (wakeSecond = resolve)),
    });
    const engine = (lock: BrowserCoordinationLock, uuidStart: number) =>
      new ReplayEngine(
        registry,
        {
          repository,
          transport,
          lock,
          clock,
          scheduler,
          uuid: new DeterministicUuidGenerator(uuidStart),
          random: new SequenceRandomSource(),
          connectivity: new StaticConnectivity(),
          events: new RecordingEventSink(),
        },
        { coordinationKey: 'two-tabs' },
      );
    const firstEngine = engine(firstLock, 300);
    const secondEngine = engine(secondLock, 400);
    await firstEngine.enqueue(definition, { id: 'one' }, { scope: 'workspace' });
    let releaseTransport = (): void => undefined;
    const transportGate = new Promise<void>((resolve) => (releaseTransport = resolve));
    transport.enqueue({
      type: 'handler',
      handle: async () => {
        await transportGate;
        return { status: 201, headers: {}, body: { id: 1 } };
      },
    });

    const firstReplay = firstEngine.replay('workspace');
    await eventually(() => transport.calls.length === 1);
    const secondReplay = secondEngine.replay('workspace');
    await Promise.resolve();
    expect(transport.calls).toHaveLength(1);
    releaseTransport();
    await firstReplay;
    wakeSecond();
    await secondReplay;
    expect(transport.calls).toHaveLength(1);
  });

  it('serializes two tabs through the IndexedDB lease fallback', async () => {
    const repository = new InMemoryOperationRepository();
    const clock = new FakeClock(1_000);
    const scheduler = new FakeScheduler(clock);
    let wakeSecond = (): void => undefined;
    const options = {
      repository,
      clock,
      scheduler,
      webLocks: null,
      wait: () => new Promise<void>((resolve) => (wakeSecond = resolve)),
    } as const;
    const firstLock = new BrowserCoordinationLock({
      ...options,
      uuid: new DeterministicUuidGenerator(1),
    });
    const secondLock = new BrowserCoordinationLock({
      ...options,
      uuid: new DeterministicUuidGenerator(2),
    });
    const order: string[] = [];
    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const first = firstLock.runExclusive('queue:scope', async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
    });
    await eventually(() => order.length === 1);
    const second = secondLock.runExclusive('queue:scope', async () => order.push('second'));
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await first;
    wakeSecond();
    await second;
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('renews a live operation claim and recovers it after an abandoned tab expires', async () => {
    const definition = defineOfflineOperation<{ id: string }, { id: number }>({
      kind: 'showcase.long-running',
      version: 1,
      request: () => ({ method: 'POST', url: '/long' }),
    });
    const harness = new EngineTestHarness([definition], {
      engine: { claimDurationMs: 100, claimRenewalIntervalMs: 40 },
    });
    const operation = await harness.engine.enqueue(definition, { id: 'a' }, { scope: 'pool' });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    harness.transport.enqueue({
      type: 'handler',
      handle: async () => {
        await gate;
        return { status: 201, headers: {}, body: { id: 1 } };
      },
    });
    const replay = harness.engine.replay('pool');
    await eventually(
      async () => (await harness.repository.get(operation.id))?.status === 'executing',
    );
    await eventually(() => harness.scheduler.pendingTimes().includes(40));
    await harness.scheduler.advanceBy(40);
    expect((await harness.repository.get(operation.id))?.claimExpiresAt).toBe(140);
    release();
    await replay;

    harness.repository.seedOperation({
      ...operation,
      id: 'abandoned',
      status: 'executing',
      claimOwner: 'closed-tab',
      claimExpiresAt: 120,
    });
    harness.clock.set(121);
    expect(await harness.repository.recoverExpiredClaims(121, 'pool')).toEqual(['abandoned']);
  });
});

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (await predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Condition was not reached.');
}
