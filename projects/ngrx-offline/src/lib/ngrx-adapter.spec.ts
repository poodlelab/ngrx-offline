import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideEffects } from '@ngrx/effects';
import { Action, ScannedActionsSubject, Store, provideStore } from '@ngrx/store';
import { StoredOperation, defineOfflineOperation } from '@poodlelab/ngrx-offline/core';
import { IndexedDbRepositoryError } from '@poodlelab/ngrx-offline/indexeddb';
import {
  InMemoryOperationRepository,
  ScriptedTransport,
  StaticConnectivity,
} from '@poodlelab/ngrx-offline/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { filter, firstValueFrom, take } from 'rxjs';
import { AngularHttpTransport, OFFLINE_HTTP_SCOPE } from './angular-http-transport';
import { createOfflineMutation } from './mutation-actions';
import { OfflineOutboxRuntime } from './outbox-runtime';
import { provideOfflineOutbox } from './provide-offline-outbox';
import {
  OfflineOutboxActions,
  selectOfflineCountsByScope,
  selectOfflineOperations,
  selectOfflinePendingCount,
  selectOfflineStorageHealth,
} from './outbox-state';

const createCustomerDefinition = defineOfflineOperation<
  { readonly clientId: string; readonly name: string },
  { readonly id: string; readonly clientId: string; readonly name: string }
>({
  kind: 'showcase.customer-create',
  version: 1,
  request: (input) => ({ method: 'POST', url: '/customers', body: { ...input } }),
  parseResult: (response) =>
    response.body as { readonly id: string; readonly clientId: string; readonly name: string },
});

const createCustomer = createOfflineMutation(createCustomerDefinition, { source: 'Customers' });

describe('foreground NgRx adapter', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('uses a concise default action source when none is configured', () => {
    const mutation = createOfflineMutation(createCustomerDefinition);

    expect(mutation.requested.type).toBe('[Offline] showcase.customer-create Requested');
    expect(mutation.enqueueFailed.type).toBe('[Offline] showcase.customer-create Enqueue Failed');
  });

  it('emits queued only after persistence commits and keeps payloads out of feature state', async () => {
    const repository = new DeferredEnqueueRepository();
    const actions: Action[] = [];
    configureOutbox(repository);
    const store = TestBed.inject(Store);
    const scanned = TestBed.inject(ScannedActionsSubject);
    const subscription = scanned.subscribe((action) => actions.push(action));
    const queued = nextAction(scanned, createCustomer.queued.type);

    store.dispatch(
      createCustomer.requested({ input: { clientId: 'local-1', name: 'Ada Services' } }),
    );
    await repository.enqueueStarted;

    expect(actions.some((action) => action.type === createCustomer.queued.type)).toBe(false);
    expect(await repository.listOperations('pool-a')).toEqual([]);

    repository.commitEnqueue();
    const queuedAction = await queued;
    expect(queuedAction).toMatchObject({
      input: { clientId: 'local-1', name: 'Ada Services' },
      scope: 'pool-a',
    });
    expect(await repository.listOperations('pool-a')).toHaveLength(1);
    expect(
      await firstValueFrom(
        store.select(selectOfflinePendingCount).pipe(filter((count) => count === 1)),
      ),
    ).toBe(1);

    const summaries = await firstValueFrom(store.select(selectOfflineOperations).pipe(take(1)));
    expect(Object.values(summaries)[0]).not.toHaveProperty('input');
    expect(JSON.stringify(summaries)).not.toContain('Ada Services');
    subscription.unsubscribe();
  });

  it('automatically replays online writes without delaying later durable enqueues', async () => {
    const repository = new InMemoryOperationRepository();
    let releaseFirstRequest!: () => void;
    let announceFirstRequest!: () => void;
    const firstRequestGate = new Promise<void>((resolve) => (releaseFirstRequest = resolve));
    const firstRequestStarted = new Promise<void>((resolve) => (announceFirstRequest = resolve));
    const transport = new ScriptedTransport()
      .enqueue({
        type: 'handler',
        handle: async () => {
          announceFirstRequest();
          await firstRequestGate;
          return {
            status: 201,
            headers: {},
            body: { id: 'server-1', clientId: 'local-1', name: 'Ada Services' },
          };
        },
      })
      .respond(201, { id: 'server-2', clientId: 'local-2', name: 'Grace Services' });
    configureOutbox(repository, {
      connectivity: new StaticConnectivity(true),
      transport,
    });
    const store = TestBed.inject(Store);
    const scanned = TestBed.inject(ScannedActionsSubject);
    const secondQueued = firstValueFrom(
      scanned.pipe(
        filter(
          (action) =>
            action.type === createCustomer.queued.type &&
            (action as Action & { readonly input?: { readonly clientId?: string } }).input
              ?.clientId === 'local-2',
        ),
        take(1),
      ),
    );
    const secondSucceeded = firstValueFrom(
      scanned.pipe(
        filter(
          (action) =>
            action.type === createCustomer.succeeded.type &&
            (action as Action & { readonly input?: { readonly clientId?: string } }).input
              ?.clientId === 'local-2',
        ),
        take(1),
      ),
    );

    store.dispatch(
      createCustomer.requested({ input: { clientId: 'local-1', name: 'Ada Services' } }),
    );
    store.dispatch(
      createCustomer.requested({ input: { clientId: 'local-2', name: 'Grace Services' } }),
    );

    await firstRequestStarted;
    await secondQueued;
    expect(await repository.listOperations('pool-a')).toHaveLength(2);

    releaseFirstRequest();
    await secondSucceeded;
    expect(transport.calls).toHaveLength(2);
    expect(await repository.listOperations('pool-a')).toEqual([]);
  });

  it('emits enqueueFailed without queued or optimistic lifecycle when storage rejects', async () => {
    const repository = new FailingEnqueueRepository();
    configureOutbox(repository);
    const store = TestBed.inject(Store);
    const scanned = TestBed.inject(ScannedActionsSubject);
    const actions: Action[] = [];
    const subscription = scanned.subscribe((action) => actions.push(action));
    const failed = nextAction(scanned, createCustomer.enqueueFailed.type);

    store.dispatch(
      createCustomer.requested({ input: { clientId: 'local-1', name: 'Ada Services' } }),
    );
    expect(await failed).toMatchObject({ error: { code: 'quota_exceeded' } });
    expect(actions.some((action) => action.type === createCustomer.queued.type)).toBe(false);
    expect(await repository.listOperations()).toEqual([]);
    expect(
      await firstValueFrom(store.select(selectOfflineStorageHealth).pipe(take(1))),
    ).toMatchObject({ status: 'error', code: 'quota_exceeded' });
    subscription.unsubscribe();
  });

  it('restores operations idempotently and acknowledges receipts only after dispatch', async () => {
    const repository = new InMemoryOperationRepository();
    const pending = operationRecord('pending-operation');
    const completed = operationRecord('completed-operation');
    await repository.enqueue(pending);
    await repository.enqueue(completed);
    await repository.claim(completed.id, { owner: 'old-page', claimedAt: 1, expiresAt: 2 });
    await repository.complete({
      operationId: completed.id,
      receipt: {
        operationId: completed.id,
        kind: completed.kind,
        version: completed.version,
        scope: completed.scope,
        input: completed.input,
        result: { id: 'server-1', clientId: 'local-2', name: 'Grace' },
        producedReferences: [],
        completedAt: 2,
      },
      references: [],
    });
    configureOutbox(repository);
    const scanned = TestBed.inject(ScannedActionsSubject);
    const restored: Action[] = [];
    const succeeded: Action[] = [];
    const subscription = scanned.subscribe((action) => {
      if (action.type === createCustomer.restored.type) restored.push(action);
      if (action.type === createCustomer.succeeded.type) succeeded.push(action);
    });
    const runtime = TestBed.inject(OfflineOutboxRuntime);

    await runtime.restore('pool-a', true);
    await runtime.restore('pool-a', true);

    expect(restored).toHaveLength(2);
    expect(succeeded).toHaveLength(1);
    expect(await repository.listReceipts('pool-a')).toEqual([]);
    expect(
      await firstValueFrom(TestBed.inject(Store).select(selectOfflinePendingCount).pipe(take(1))),
    ).toBe(1);
    subscription.unsubscribe();
  });

  it('exposes counts for inactive scopes and prompts before deleting logout data', async () => {
    const repository = new InMemoryOperationRepository();
    await repository.enqueue(operationRecord('pool-a-operation'));
    await repository.enqueue({
      ...operationRecord('pool-b-operation'),
      scope: 'pool-b',
      status: 'blocked',
    });
    configureOutbox(repository, { logoutPolicy: 'prompt' });
    const runtime = TestBed.inject(OfflineOutboxRuntime);
    const actions = TestBed.inject(ScannedActionsSubject);
    const confirmation = nextAction(actions, OfflineOutboxActions.logoutConfirmationRequired.type);
    await runtime.restore('pool-a', false);

    expect(
      await firstValueFrom(TestBed.inject(Store).select(selectOfflineCountsByScope).pipe(take(1))),
    ).toEqual({
      'pool-a': { pending: 1, blocked: 0 },
      'pool-b': { pending: 0, blocked: 1 },
    });
    await runtime.logoutScope('pool-a');
    await expect(confirmation).resolves.toMatchObject({ scope: 'pool-a', pending: 1, blocked: 0 });
    expect(await repository.get('pool-a-operation')).toBeDefined();
    expect((await repository.getScopePause('pool-a'))?.code).toBe('logout_confirmation_required');

    await runtime.logoutScope('pool-a', true);
    expect(await repository.get('pool-a-operation')).toBeUndefined();
    expect(await repository.get('pool-b-operation')).toBeDefined();
  });
});

describe('AngularHttpTransport', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('preserves interceptors, resolves current auth per execution, and exposes Retry-After', async () => {
    let token = 'token-one';
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(
          withInterceptors([
            (request, next) => {
              const scope = request.context.get(OFFLINE_HTTP_SCOPE);
              return next(
                request.clone({
                  setHeaders: { Authorization: `Bearer ${token}:${scope ?? 'none'}` },
                }),
              );
            },
          ]),
        ),
        provideHttpClientTesting(),
        AngularHttpTransport,
      ],
    });
    const transport = TestBed.inject(AngularHttpTransport);
    const controller = TestBed.inject(HttpTestingController);

    const first = transport.execute(
      {
        method: 'POST',
        url: '/customers',
        headers: { 'Idempotency-Key': 'operation-1' },
        body: { name: 'Ada' },
      },
      transportContext('operation-1'),
    );
    const firstRequest = controller.expectOne('/customers');
    expect(firstRequest.request.headers.get('Authorization')).toBe('Bearer token-one:pool-a');
    expect(firstRequest.request.headers.get('Idempotency-Key')).toBe('operation-1');
    firstRequest.flush({ id: 1 });
    await expect(first).resolves.toMatchObject({ status: 200, body: { id: 1 } });

    token = 'token-two';
    const second = transport.execute(
      { method: 'POST', url: '/customers' },
      transportContext('operation-2'),
    );
    const secondRequest = controller.expectOne('/customers');
    expect(secondRequest.request.headers.get('Authorization')).toBe('Bearer token-two:pool-a');
    secondRequest.flush(
      { code: 'busy' },
      { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '3' } },
    );
    await expect(second).resolves.toMatchObject({
      status: 429,
      headers: expect.objectContaining({ 'Retry-After': '3' }),
    });
    controller.verify();
  });

  it('turns configured operation timeouts into retryable transport errors', async () => {
    vi.useFakeTimers();
    try {
      TestBed.configureTestingModule({
        providers: [provideHttpClient(), provideHttpClientTesting(), AngularHttpTransport],
      });
      const transport = TestBed.inject(AngularHttpTransport);
      const controller = TestBed.inject(HttpTestingController);
      const result = transport.execute(
        { method: 'POST', url: '/slow', timeoutMs: 100 },
        transportContext('operation-timeout'),
      );
      const guardedResult = result.catch((error: unknown) => error);
      controller.expectOne('/slow');
      await vi.advanceTimersByTimeAsync(100);
      expect(await guardedResult).toMatchObject({
        category: 'timeout',
      });
      controller.verify({ ignoreCancelled: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

class DeferredEnqueueRepository extends InMemoryOperationRepository {
  private release!: () => void;
  private announceStarted!: () => void;
  private readonly gate = new Promise<void>((resolve) => (this.release = resolve));
  readonly enqueueStarted = new Promise<void>((resolve) => (this.announceStarted = resolve));

  override async enqueue(operation: StoredOperation): Promise<void> {
    this.announceStarted();
    await this.gate;
    await super.enqueue(operation);
  }

  commitEnqueue(): void {
    this.release();
  }
}

class FailingEnqueueRepository extends InMemoryOperationRepository {
  override async enqueue(): Promise<void> {
    throw new IndexedDbRepositoryError('quota_exceeded', 'The browser quota is full.');
  }
}

function configureOutbox(
  repository: InMemoryOperationRepository,
  overrides: {
    readonly logoutPolicy?: 'discard' | 'preserve' | 'prompt';
    readonly connectivity?: StaticConnectivity;
    readonly transport?: ScriptedTransport;
  } = {},
): void {
  TestBed.configureTestingModule({
    providers: [
      provideStore(),
      provideEffects(),
      provideOfflineOutbox(() => ({
        databaseName: 'ngrx-offline-test',
        mutations: [createCustomer],
        scope: () => 'pool-a',
        repository,
        transport: new ScriptedTransport(),
        connectivity: new StaticConnectivity(false),
        restoreOnStartup: false,
        ...overrides,
      })),
    ],
  });
}

function nextAction(actions: ScannedActionsSubject, type: string): Promise<Action> {
  return firstValueFrom(
    actions.pipe(
      filter((action) => action.type === type),
      take(1),
    ),
  );
}

function transportContext(operationId: string) {
  return {
    operationId,
    idempotencyKey: operationId,
    kind: 'customers.create',
    scope: 'pool-a',
    attempt: 1,
  };
}

function operationRecord(id: string): StoredOperation {
  return {
    id,
    kind: createCustomerDefinition.kind,
    version: createCustomerDefinition.version,
    scope: 'pool-a',
    lane: 'default',
    dependencies: [],
    produces: [],
    input: { clientId: id === 'pending-operation' ? 'local-1' : 'local-2', name: 'Grace' },
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
