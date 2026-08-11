import {
  AnyOfflineOperationDefinition,
  Clock,
  Connectivity,
  EngineEventSink,
  FailureClassifier,
  OfflineWorkerSyncEvent,
  OperationRepository,
  OperationTransport,
  RandomSource,
  ReplayEngine,
  ReplayResult,
  Scheduler,
  UuidGenerator,
  createOperationRegistry,
} from '@poodlelab/ngrx-offline/core';
import {
  BrowserCoordinationLock,
  IndexedDbOperationRepository,
} from '@poodlelab/ngrx-offline/indexeddb';
import {
  NoopWorkerEventSink,
  WorkerClock,
  WorkerConnectivity,
  WorkerRandomSource,
  WorkerScheduler,
  WorkerUuidGenerator,
} from './worker-adapters';

/** Worker replay capability check, typically backed by cookie or ephemeral credentials. @alpha */
export type WorkerReplayGate = (scope: string) => boolean | Promise<boolean>;

/** Sink for structured worker replay outcomes. @alpha */
export interface WorkerReplayNotifier {
  notify(event: OfflineWorkerSyncEvent): Promise<void> | void;
}

/** Construction settings for an optional worker outbox executor. @alpha */
export interface WorkerOutboxExecutorOptions {
  readonly databaseName: string;
  readonly definitions: readonly AnyOfflineOperationDefinition[];
  readonly transport: OperationTransport;
  readonly coordinationKey?: string;
  readonly indexedDB?: IDBFactory;
  readonly repository?: OperationRepository;
  readonly clock?: Clock;
  readonly uuid?: UuidGenerator;
  readonly random?: RandomSource;
  readonly scheduler?: Scheduler;
  readonly connectivity?: Connectivity;
  readonly events?: EngineEventSink;
  readonly notifier?: WorkerReplayNotifier;
  readonly canReplay?: WorkerReplayGate;
  readonly classifyFailure?: FailureClassifier;
  readonly claimDurationMs?: number;
  readonly claimRenewalIntervalMs?: number;
  readonly maximumConcurrentLanes?: number;
  readonly maximumOperationsPerRun?: number;
}

/** Result of one gated worker replay request. @alpha */
export type WorkerExecutionResult =
  | { readonly status: 'completed'; readonly replay: ReplayResult }
  | { readonly status: 'deferred'; readonly reason: 'credentials-unavailable' };

/**
 * Replays the same IndexedDB outbox as the foreground runtime under the same
 * cross-context lock. Every success is committed as a durable receipt first.
 *
 * @alpha
 */
export class WorkerOutboxExecutor {
  private readonly engine: ReplayEngine;
  private readonly ownedRepository: IndexedDbOperationRepository | undefined;

  constructor(private readonly options: WorkerOutboxExecutorOptions) {
    const clock = options.clock ?? new WorkerClock();
    const uuid = options.uuid ?? new WorkerUuidGenerator();
    const scheduler = options.scheduler ?? new WorkerScheduler();
    const repository =
      options.repository ??
      new IndexedDbOperationRepository({
        databaseName: options.databaseName,
        ...(options.indexedDB === undefined ? {} : { indexedDB: options.indexedDB }),
      });
    this.ownedRepository =
      repository instanceof IndexedDbOperationRepository ? repository : undefined;
    this.engine = new ReplayEngine(
      createOperationRegistry(...options.definitions),
      {
        repository,
        transport: options.transport,
        lock: new BrowserCoordinationLock({ repository, clock, uuid, scheduler }),
        clock,
        uuid,
        scheduler,
        random: options.random ?? new WorkerRandomSource(),
        connectivity: options.connectivity ?? new WorkerConnectivity(),
        events: options.events ?? new NoopWorkerEventSink(),
        ...(options.classifyFailure === undefined
          ? {}
          : { classifyFailure: options.classifyFailure }),
      },
      {
        coordinationKey: options.coordinationKey ?? `ngrx-offline:${options.databaseName}`,
        ...(options.claimDurationMs === undefined
          ? {}
          : { claimDurationMs: options.claimDurationMs }),
        ...(options.claimRenewalIntervalMs === undefined
          ? {}
          : { claimRenewalIntervalMs: options.claimRenewalIntervalMs }),
        ...(options.maximumConcurrentLanes === undefined
          ? {}
          : { maximumConcurrentLanes: options.maximumConcurrentLanes }),
        ...(options.maximumOperationsPerRun === undefined
          ? {}
          : { maximumOperationsPerRun: options.maximumOperationsPerRun }),
      },
    );
  }

  async sync(scope: string): Promise<WorkerExecutionResult> {
    if (this.options.canReplay !== undefined && !(await this.options.canReplay(scope))) {
      const event: OfflineWorkerSyncEvent = {
        type: 'ngrx-offline:sync-event',
        scope,
        status: 'deferred',
        reason: 'credentials-unavailable',
      };
      await this.notify(event);
      return { status: 'deferred', reason: 'credentials-unavailable' };
    }
    try {
      const replay = await this.engine.replay(scope);
      await this.notify({ type: 'ngrx-offline:sync-event', scope, status: 'completed', replay });
      return { status: 'completed', replay };
    } catch (error) {
      await this.notify({ type: 'ngrx-offline:sync-event', scope, status: 'failed' });
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.ownedRepository?.close();
  }

  private async notify(event: OfflineWorkerSyncEvent): Promise<void> {
    try {
      await this.options.notifier?.notify(event);
    } catch {
      // Client notifications are advisory; durable receipts remain authoritative.
    }
  }
}
