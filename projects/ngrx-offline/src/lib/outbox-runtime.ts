import {
  EngineEventSink,
  EngineTransition,
  HttpRequestDescriptor,
  OperationRepository,
  OperationTransport,
  ReplayEngine,
  StoredOperation,
  StoredReceipt,
  TransportContext,
  TransportResponse,
  createOperationRegistry,
} from '@poodlelab/ngrx-offline/core';
import { Action, Store } from '@ngrx/store';
import { DestroyRef, Injectable, InjectionToken, inject } from '@angular/core';
import { Observable, Subscription } from 'rxjs';
import {
  BrowserCoordinationLock,
  IndexedDbOperationRepository,
  normalizeIndexedDbError,
} from '@poodlelab/ngrx-offline/indexeddb';
import { AngularHttpTransport } from './angular-http-transport';
import {
  BrowserClock,
  BrowserConnectivity,
  BrowserRandomSource,
  BrowserScheduler,
  BrowserUuidGenerator,
} from './browser-adapters';
import { AnyOfflineMutationBinding, OfflineEnqueueFailure } from './mutation-actions';
import {
  OfflineOutboxActions,
  offlineOutboxInternalActions,
  toOperationSummary,
} from './outbox-state';
import {
  OFFLINE_OPERATION_REPOSITORY,
  OFFLINE_OUTBOX_CONFIG,
  OfflineOutboxConfig,
} from './outbox-config';

export const OFFLINE_REPLAY_ENGINE = new InjectionToken<ReplayEngine>('OFFLINE_REPLAY_ENGINE');

@Injectable()
export class OutboxConnectivity {
  private readonly config = inject(OFFLINE_OUTBOX_CONFIG);
  private readonly browser = inject(BrowserConnectivity);
  private readonly subscription: Subscription | undefined;
  private online: boolean;

  readonly changes: Observable<boolean>;

  constructor() {
    const source = this.config.connectivity$ ?? this.browser.changes;
    this.online = this.config.connectivity?.isOnline() ?? this.browser.isOnline();
    this.changes = source;
    this.subscription = source.subscribe((online) => (this.online = online));
    inject(DestroyRef).onDestroy(() => this.subscription?.unsubscribe());
  }

  isOnline(): boolean {
    return this.config.connectivity?.isOnline() ?? this.online;
  }
}

@Injectable()
export class NgRxEngineEventSink implements EngineEventSink {
  private readonly config = inject(OFFLINE_OUTBOX_CONFIG);
  private readonly repository = inject(OFFLINE_OPERATION_REPOSITORY);
  private readonly store = inject(Store);

  async emit(event: EngineTransition): Promise<void> {
    switch (event.type) {
      case 'queued':
        await this.withOperation(event.operationId, (binding, operation) => {
          this.dispatch(
            binding.queued({
              operationId: operation.id,
              input: operation.input,
              scope: operation.scope,
            }),
          );
          this.upsert(operation);
        });
        return;
      case 'execution-started':
        await this.withOperation(event.operationId, (binding, operation) => {
          this.dispatch(
            binding.executionStarted({
              operationId: event.operationId,
              attempt: event.attempt,
            }),
          );
          this.upsert(operation);
        });
        return;
      case 'retry-scheduled':
        await this.withOperation(event.operationId, (binding, operation) => {
          this.dispatch(
            binding.retryScheduled({
              operationId: event.operationId,
              attempt: event.attempt,
              nextAttemptAt: event.nextAttemptAt,
              failure: event.failure,
            }),
          );
          this.upsert(operation);
        });
        return;
      case 'blocked':
        await this.withOperation(event.operationId, (binding, operation) => {
          this.dispatch(
            binding.blocked({
              operationId: event.operationId,
              input: operation.input,
              scope: operation.scope,
              failure: event.failure,
            }),
          );
          this.upsert(operation);
        });
        return;
      case 'succeeded': {
        const receipt = (await this.repository.listReceipts(event.scope)).find(
          (candidate) => candidate.operationId === event.operationId,
        );
        if (receipt !== undefined && this.dispatchReceipt(receipt)) {
          await this.repository.acknowledgeReceipt(receipt.operationId);
        }
        this.store.dispatch(
          offlineOutboxInternalActions.summaryRemoved({ operationId: event.operationId }),
        );
        return;
      }
      case 'cancelled':
      case 'discarded':
        this.store.dispatch(
          offlineOutboxInternalActions.summaryRemoved({ operationId: event.operationId }),
        );
        return;
      case 'scope-paused':
        await this.refreshOperation(event.operationId);
        return;
      case 'scope-resumed':
      case 'removal-rejected':
      case 'claims-recovered':
      case 'dependencies-unresolved':
      case 'operation-migrated':
        return;
    }
  }

  dispatchReceipt(receipt: StoredReceipt): boolean {
    const binding = this.binding(receipt.kind);
    if (binding === undefined) {
      return false;
    }
    this.dispatch(
      binding.succeeded({
        operationId: receipt.operationId,
        input: receipt.input,
        result: receipt.result,
        scope: receipt.scope,
      }),
    );
    return true;
  }

  private async withOperation(
    operationId: string,
    work: (binding: AnyOfflineMutationBinding, operation: StoredOperation) => void,
  ): Promise<void> {
    const operation = await this.repository.get(operationId);
    const binding = operation === undefined ? undefined : this.binding(operation.kind);
    if (operation !== undefined && binding !== undefined) {
      work(binding, operation);
    }
  }

  private async refreshOperation(operationId: string): Promise<void> {
    const operation = await this.repository.get(operationId);
    if (operation !== undefined) {
      this.upsert(operation);
    }
  }

  private upsert(operation: StoredOperation): void {
    this.store.dispatch(
      offlineOutboxInternalActions.summaryUpserted({ operation: toOperationSummary(operation) }),
    );
  }

  private binding(kind: string): AnyOfflineMutationBinding | undefined {
    return this.config.mutations.find((binding) => binding.definition.kind === kind);
  }

  private dispatch(action: object): void {
    this.store.dispatch(action as Action);
  }
}

@Injectable()
export class OfflineOutboxRuntime {
  private readonly config = inject(OFFLINE_OUTBOX_CONFIG);
  private readonly repository = inject(OFFLINE_OPERATION_REPOSITORY);
  private readonly engine = inject(OFFLINE_REPLAY_ENGINE);
  private readonly eventSink = inject(NgRxEngineEventSink);
  private readonly store = inject(Store);
  private readonly clock = inject(BrowserClock);
  private readonly online = inject(OutboxConnectivity);
  private readonly activeSyncs = new Map<string, Promise<void>>();
  private readonly syncRequestedAgain = new Set<string>();
  private activeSyncCount = 0;

  isRequested(action: Action): boolean {
    return this.config.mutations.some((binding) => binding.requested.type === action.type);
  }

  async enqueueRequested(action: Action): Promise<void> {
    const binding = this.config.mutations.find(
      (candidate) => candidate.requested.type === action.type,
    );
    if (binding === undefined) {
      return;
    }
    const input = (action as Action & { readonly input: unknown }).input;
    const scope = this.currentScope();
    try {
      await this.engine.enqueue(binding.definition, input, { scope });
      this.store.dispatch(offlineOutboxInternalActions.storageAvailable());
      if (this.online.isOnline()) {
        void this.sync(scope);
      }
    } catch (error) {
      const failure = sanitizeEnqueueFailure(error);
      this.store.dispatch(binding.enqueueFailed({ input, error: failure }) as Action);
      this.store.dispatch(offlineOutboxInternalActions.storageFailed(failure));
    }
  }

  async initialize(): Promise<void> {
    if (this.config.restoreOnStartup !== false) {
      await this.restore(this.currentScope(), true);
    }
    if (this.online.isOnline()) {
      await this.sync(this.currentScope());
    }
  }

  async restore(scope = this.currentScope(), includeLifecycle = true): Promise<void> {
    try {
      const operations = await this.repository.listOperations();
      const scopedOperations = operations.filter((operation) => operation.scope === scope);
      if (includeLifecycle) {
        for (const operation of scopedOperations) {
          const binding = this.binding(operation.kind);
          if (
            binding !== undefined &&
            (operation.status === 'pending' || operation.status === 'blocked')
          ) {
            this.store.dispatch(
              binding.restored({
                operationId: operation.id,
                input: operation.input,
                scope: operation.scope,
                status: operation.status,
              }) as Action,
            );
          }
        }
      }
      this.store.dispatch(
        offlineOutboxInternalActions.hydrated({
          scope,
          operations: operations.map(toOperationSummary),
        }),
      );
      for (const receipt of await this.repository.listReceipts(scope)) {
        if (this.eventSink.dispatchReceipt(receipt)) {
          await this.repository.acknowledgeReceipt(receipt.operationId);
        }
      }
      this.store.dispatch(offlineOutboxInternalActions.storageAvailable());
    } catch (error) {
      this.store.dispatch(
        offlineOutboxInternalActions.storageFailed(sanitizeEnqueueFailure(error)),
      );
    }
  }

  sync(scope = this.currentScope()): Promise<void> {
    const activeSync = this.activeSyncs.get(scope);
    if (activeSync !== undefined) {
      this.syncRequestedAgain.add(scope);
      return activeSync;
    }

    const sync = this.runSync(scope);
    this.activeSyncs.set(scope, sync);
    void sync.then(
      () => this.completeSync(scope, sync),
      () => this.completeSync(scope, sync),
    );
    return sync;
  }

  private completeSync(scope: string, sync: Promise<void>): void {
    if (this.activeSyncs.get(scope) !== sync) {
      return;
    }
    this.activeSyncs.delete(scope);
    if (this.syncRequestedAgain.delete(scope) && this.online.isOnline()) {
      void this.sync(scope);
    }
  }

  private async runSync(scope: string): Promise<void> {
    this.activeSyncCount += 1;
    if (this.activeSyncCount === 1) {
      this.store.dispatch(offlineOutboxInternalActions.syncingChanged({ syncing: true }));
    }
    try {
      do {
        this.syncRequestedAgain.delete(scope);
        await this.engine.replay(scope);
        await this.restore(scope, false);
      } while (this.syncRequestedAgain.delete(scope) && this.online.isOnline());
    } catch (error) {
      this.store.dispatch(
        offlineOutboxInternalActions.storageFailed(sanitizeEnqueueFailure(error)),
      );
    } finally {
      this.activeSyncCount -= 1;
      if (this.activeSyncCount === 0) {
        this.store.dispatch(offlineOutboxInternalActions.syncingChanged({ syncing: false }));
      }
    }
  }

  async retry(operationId: string): Promise<void> {
    const operation = await this.repository.get(operationId);
    if (
      operation !== undefined &&
      (await this.repository.retryNow(operationId, this.clock.now()))
    ) {
      await this.refresh(operationId);
      await this.sync(operation.scope);
    }
  }

  async cancel(operationId: string): Promise<void> {
    const operation = await this.repository.get(operationId);
    const result = await this.engine.cancel(operationId);
    if (result === 'removed' && operation !== undefined) {
      const binding = this.binding(operation.kind);
      if (binding !== undefined) {
        this.store.dispatch(binding.cancelled({ operationId }) as Action);
      }
    }
  }

  async discard(operationId: string): Promise<void> {
    await this.engine.discard(operationId);
  }

  async pauseScope(scope: string): Promise<void> {
    await this.repository.pauseScope({ scope, code: 'manual_pause', pausedAt: this.clock.now() });
  }

  async resumeScope(scope: string): Promise<void> {
    await this.engine.resumeScope(scope);
    await this.sync(scope);
  }

  async logoutScope(scope: string, confirmed = false): Promise<void> {
    const policy = this.config.logoutPolicy ?? 'preserve';
    if (policy === 'preserve') {
      await this.repository.pauseScope({
        scope,
        code: 'inactive_scope',
        pausedAt: this.clock.now(),
      });
      return;
    }
    const count = (await this.repository.countOperationsByScope()).find(
      (candidate) => candidate.scope === scope,
    ) ?? { scope, pending: 0, blocked: 0 };
    if (policy === 'prompt' && !confirmed && count.pending + count.blocked > 0) {
      await this.repository.pauseScope({
        scope,
        code: 'logout_confirmation_required',
        pausedAt: this.clock.now(),
      });
      this.store.dispatch(
        OfflineOutboxActions.logoutConfirmationRequired({
          scope,
          pending: count.pending,
          blocked: count.blocked,
        }),
      );
      return;
    }
    await this.repository.deleteScope(scope);
    await this.restore(this.currentScope(), false);
  }

  currentScope(): string {
    const scope = this.config.scope();
    if (scope.trim() === '') {
      throw new Error('The active offline scope cannot be empty.');
    }
    return scope;
  }

  private async refresh(operationId: string): Promise<void> {
    const operation = await this.repository.get(operationId);
    if (operation !== undefined) {
      this.store.dispatch(
        offlineOutboxInternalActions.summaryUpserted({ operation: toOperationSummary(operation) }),
      );
    }
  }

  private binding(kind: string): AnyOfflineMutationBinding | undefined {
    return this.config.mutations.find((binding) => binding.definition.kind === kind);
  }
}

export function createRepository(
  config: OfflineOutboxConfig,
  destroyRef: DestroyRef,
): OperationRepository {
  const repository =
    config.repository ??
    new IndexedDbOperationRepository({
      databaseName: config.databaseName,
      ...(config.indexedDB === undefined ? {} : { indexedDB: config.indexedDB }),
    });
  if (repository instanceof IndexedDbOperationRepository) {
    destroyRef.onDestroy(() => void repository.close());
  }
  return repository;
}

export function createReplayEngine(): ReplayEngine {
  const config = inject(OFFLINE_OUTBOX_CONFIG);
  const timeoutMs = config.operationTimeoutMs;
  const transport = config.transport ?? inject(AngularHttpTransport);
  return new ReplayEngine(
    createOperationRegistry(...config.mutations.map((binding) => binding.definition)),
    {
      repository: inject(OFFLINE_OPERATION_REPOSITORY),
      transport:
        timeoutMs === undefined ? transport : new DefaultTimeoutTransport(transport, timeoutMs),
      lock: new BrowserCoordinationLock({
        repository: inject(OFFLINE_OPERATION_REPOSITORY),
        clock: inject(BrowserClock),
        uuid: inject(BrowserUuidGenerator),
        scheduler: inject(BrowserScheduler),
      }),
      clock: inject(BrowserClock),
      uuid: inject(BrowserUuidGenerator),
      random: inject(BrowserRandomSource),
      connectivity: inject(OutboxConnectivity),
      scheduler: inject(BrowserScheduler),
      events: inject(NgRxEngineEventSink),
      ...(config.classifyFailure === undefined ? {} : { classifyFailure: config.classifyFailure }),
    },
    {
      coordinationKey: config.coordinationKey ?? `ngrx-offline:${config.databaseName}`,
      ...(config.claimDurationMs === undefined ? {} : { claimDurationMs: config.claimDurationMs }),
      ...(config.maximumOperationsPerRun === undefined
        ? {}
        : { maximumOperationsPerRun: config.maximumOperationsPerRun }),
      ...(config.maximumConcurrentLanes === undefined
        ? {}
        : { maximumConcurrentLanes: config.maximumConcurrentLanes }),
      ...(config.claimRenewalIntervalMs === undefined
        ? {}
        : { claimRenewalIntervalMs: config.claimRenewalIntervalMs }),
    },
  );
}

function sanitizeEnqueueFailure(error: unknown): OfflineEnqueueFailure {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return {
      code: error.code,
      message:
        error instanceof Error ? error.message : 'The offline operation could not be queued.',
    };
  }
  const normalized = normalizeIndexedDbError(error, 'persisting an offline operation');
  return { code: normalized.code, message: normalized.message };
}

class DefaultTimeoutTransport implements OperationTransport {
  constructor(
    private readonly transport: OperationTransport,
    private readonly timeoutMs: number,
  ) {}

  execute(request: HttpRequestDescriptor, context: TransportContext): Promise<TransportResponse> {
    return this.transport.execute(
      request.timeoutMs === undefined ? { ...request, timeoutMs: this.timeoutMs } : request,
      context,
    );
  }
}
