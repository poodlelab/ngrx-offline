import {
  AnyOfflineOperationDefinition,
  FailureClassifier,
  OperationRegistry,
  ReplayEngine,
  ReplayEngineOptions,
  createOperationRegistry,
} from '@poodlelab/ngrx-offline/core';
import {
  DeterministicUuidGenerator,
  FakeClock,
  FakeScheduler,
  InMemoryCoordinationLock,
  RecordingEventSink,
  RecordingLogger,
  ScriptedTransport,
  SequenceRandomSource,
  StaticConnectivity,
} from './fakes';
import { InMemoryOperationRepository } from './in-memory-operation-repository';

/**
 * Optional deterministic values used to construct an engine test harness.
 *
 * @alpha
 */
export interface EngineTestHarnessOptions {
  readonly now?: number;
  readonly random?: readonly number[];
  readonly uuidStart?: number;
  readonly engine?: Partial<ReplayEngineOptions>;
  readonly classifyFailure?: FailureClassifier;
}

/**
 * Ready-to-drive Phase 2 engine with all framework-independent in-memory ports.
 *
 * @alpha
 */
export class EngineTestHarness {
  readonly repository = new InMemoryOperationRepository();
  readonly clock: FakeClock;
  readonly scheduler: FakeScheduler;
  readonly uuid: DeterministicUuidGenerator;
  readonly random: SequenceRandomSource;
  readonly connectivity = new StaticConnectivity();
  readonly lock = new InMemoryCoordinationLock();
  readonly transport = new ScriptedTransport();
  readonly events = new RecordingEventSink();
  readonly logger = new RecordingLogger();
  readonly registry: OperationRegistry;
  readonly engine: ReplayEngine;

  constructor(
    definitions: readonly AnyOfflineOperationDefinition[],
    options: EngineTestHarnessOptions = {},
  ) {
    this.clock = new FakeClock(options.now ?? 0);
    this.scheduler = new FakeScheduler(this.clock);
    this.uuid = new DeterministicUuidGenerator(options.uuidStart ?? 1);
    this.random = new SequenceRandomSource(options.random ?? [0]);
    this.registry = createOperationRegistry(...definitions);
    this.engine = new ReplayEngine(
      this.registry,
      {
        repository: this.repository,
        transport: this.transport,
        lock: this.lock,
        clock: this.clock,
        uuid: this.uuid,
        random: this.random,
        connectivity: this.connectivity,
        scheduler: this.scheduler,
        events: this.events,
        logger: this.logger,
        ...(options.classifyFailure === undefined
          ? {}
          : { classifyFailure: options.classifyFailure }),
      },
      {
        coordinationKey: options.engine?.coordinationKey ?? 'ngrx-offline-test',
        ...(options.engine?.claimDurationMs === undefined
          ? {}
          : { claimDurationMs: options.engine.claimDurationMs }),
        ...(options.engine?.maximumOperationsPerRun === undefined
          ? {}
          : { maximumOperationsPerRun: options.engine.maximumOperationsPerRun }),
        ...(options.engine?.maximumConcurrentLanes === undefined
          ? {}
          : { maximumConcurrentLanes: options.engine.maximumConcurrentLanes }),
        ...(options.engine?.claimRenewalIntervalMs === undefined
          ? {}
          : { claimRenewalIntervalMs: options.engine.claimRenewalIntervalMs }),
      },
    );
  }
}
