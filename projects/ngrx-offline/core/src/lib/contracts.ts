/**
 * A JSON-compatible primitive.
 *
 * @alpha
 */
export type JsonPrimitive = boolean | null | number | string;

/**
 * A value that can be persisted safely as an operation input or result.
 *
 * @alpha
 */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Supported mutation methods for the initial HTTP transport contract.
 *
 * @alpha
 */
export type HttpMethod = 'DELETE' | 'PATCH' | 'POST' | 'PUT';

/**
 * Framework-independent request description built immediately before execution.
 *
 * @alpha
 */
export interface HttpRequestDescriptor {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: JsonValue;
  readonly responseType?: 'blob' | 'json' | 'none' | 'text';
  readonly credentials?: 'include' | 'omit' | 'same-origin';
  readonly timeoutMs?: number;
}

/**
 * Transport response before an operation definition parses its result.
 *
 * @alpha
 */
export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/**
 * Immutable context supplied to the transport.
 *
 * @alpha
 */
export interface TransportContext {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly scope: string;
  readonly attempt: number;
}

/**
 * Executes a framework-independent request descriptor.
 *
 * @alpha
 */
export interface OperationTransport {
  execute(request: HttpRequestDescriptor, context: TransportContext): Promise<TransportResponse>;
}

/**
 * Categories that a transport can report without exposing its implementation.
 *
 * @alpha
 */
export type TransportErrorCategory = 'network' | 'timeout';

/**
 * Normalized execution failure passed to failure classification.
 *
 * @alpha
 */
export type ExecutionFailure =
  | {
      readonly category: TransportErrorCategory;
      readonly message: string;
    }
  | {
      readonly category: 'http';
      readonly message: string;
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly category: 'request';
      readonly message: string;
    }
  | {
      readonly category: 'response';
      readonly message: string;
      readonly status?: number;
    };

/**
 * The durable action selected for an execution failure.
 *
 * @alpha
 */
export type FailureDecision =
  | { readonly type: 'retry'; readonly delayMs?: number }
  | { readonly type: 'block'; readonly code: string; readonly detail?: JsonValue }
  | { readonly type: 'pause-scope'; readonly code: string };

/**
 * Context supplied to a configured failure classifier.
 *
 * @alpha
 */
export interface FailureClassificationContext {
  readonly attempt: number;
  readonly kind: string;
  readonly now: number;
  readonly operationId: string;
  readonly scope: string;
}

/**
 * Converts an execution failure into a retry, block, or scope pause.
 *
 * @alpha
 */
export type FailureClassifier = (
  failure: ExecutionFailure,
  context: FailureClassificationContext,
) => FailureDecision;

/**
 * Retry settings applied after the failure classifier chooses retry.
 *
 * @alpha
 */
export interface RetryPolicy {
  readonly initialDelayMs?: number;
  readonly maximumDelayMs?: number;
  readonly multiplier?: number;
  readonly jitter?: 'full' | 'none';
  readonly maximumAttempts?: number;
}

/**
 * Symbolic reference resolved from an earlier successful operation.
 *
 * @alpha
 */
export interface ResolvedReference {
  readonly key: string;
  readonly value: number | string;
}

/** Explicit unresolved relationship captured in durable operation input. @alpha */
export interface OfflineReference {
  readonly type: 'offline-reference';
  readonly key: string;
}

/**
 * Context available while building a replay request.
 *
 * @alpha
 */
export interface RequestBuildContext {
  readonly operationId: string;
  readonly scope: string;
  readonly attempt: number;
  /** Resolves only references declared by this operation in its immutable scope. */
  resolve(reference: OfflineReference): number | string;
}

/** One pure, forward-only persisted-input migration. @alpha */
export interface OperationInputMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(input: JsonValue): JsonValue;
}

/**
 * Values supplied to a definition after a successful parsed response.
 *
 * @alpha
 */
export interface MutationSuccess<Input, Result> {
  readonly input: Input;
  readonly result: Result;
}

/**
 * A worker-safe definition for one durable operation kind.
 *
 * @alpha
 */
export interface OfflineOperationDefinition<Input, Result> {
  readonly kind: string;
  readonly version: number;
  request(input: Input, context: RequestBuildContext): HttpRequestDescriptor;
  lane?(input: Input): string;
  dependencies?(input: Input): readonly OfflineReference[];
  producesKeys?(input: Input): readonly string[];
  parseResult?(response: TransportResponse): Result;
  produces?(success: MutationSuccess<Input, Result>): readonly ResolvedReference[];
  readonly retryPolicy?: RetryPolicy;
  readonly migrations?: readonly OperationInputMigration[];
}

/**
 * Type-erased definition used for heterogeneous operation registries.
 *
 * @alpha
 */
export type AnyOfflineOperationDefinition = OfflineOperationDefinition<unknown, unknown>;

/**
 * Current durable operation states.
 *
 * @alpha
 */
export type StoredOperationStatus = 'blocked' | 'executing' | 'pending';

/**
 * Sanitized failure persisted with an operation.
 *
 * @alpha
 */
export interface StoredFailure {
  readonly category: ExecutionFailure['category'];
  readonly code: string;
  readonly failedAt: number;
  readonly message: string;
  readonly status?: number;
  readonly detail?: JsonValue;
}

/**
 * A durable claimed-operation lease.
 *
 * @alpha
 */
export interface OperationClaim {
  readonly owner: string;
  readonly claimedAt: number;
  readonly expiresAt: number;
}

/**
 * One durable operation instance.
 *
 * @alpha
 */
export interface StoredOperation {
  readonly id: string;
  readonly kind: string;
  readonly version: number;
  readonly scope: string;
  readonly lane: string;
  readonly dependencies: readonly string[];
  readonly produces: readonly string[];
  readonly input: JsonValue;
  readonly status: StoredOperationStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly claimOwner: string | null;
  readonly claimExpiresAt: number | null;
  readonly lastFailure: StoredFailure | null;
}

/**
 * A pending retry that releases an executing claim.
 *
 * @alpha
 */
export interface StoredRetry {
  readonly attempt: number;
  readonly failure: StoredFailure;
  readonly nextAttemptAt: number;
  readonly updatedAt: number;
}

/**
 * Durable success receipt written before the operation is removed.
 *
 * @alpha
 */
export interface StoredReceipt {
  readonly operationId: string;
  readonly kind: string;
  readonly version: number;
  readonly scope: string;
  readonly input: JsonValue;
  readonly result: JsonValue;
  readonly producedReferences: readonly ResolvedReference[];
  readonly completedAt: number;
}

/**
 * Scope-isolated durable mapping produced by a completed operation.
 *
 * @alpha
 */
export interface StoredReference extends ResolvedReference {
  readonly scope: string;
  readonly producerOperationId: string;
  readonly resolvedAt: number;
}

/**
 * Atomic completion values passed to the repository.
 *
 * @alpha
 */
export interface OperationCompletion {
  readonly operationId: string;
  readonly receipt: StoredReceipt;
  readonly references: readonly StoredReference[];
}

/**
 * Eligibility query for deterministic lane-head selection.
 *
 * @alpha
 */
export interface EligibilityQuery {
  readonly scope: string;
  readonly now: number;
  readonly limit: number;
}

/**
 * Result of cancellation or explicit discard.
 *
 * @alpha
 */
export type RemovalResult = 'executing' | 'not-found' | 'removed';

/**
 * Durable scope-pause metadata.
 *
 * @alpha
 */
export interface ScopePause {
  readonly scope: string;
  readonly code: string;
  readonly pausedAt: number;
}

/** Payload-free queue counts for one immutable scope. @alpha */
export interface ScopeOperationCounts {
  readonly scope: string;
  readonly pending: number;
  readonly blocked: number;
}

/** Atomic replacement values after a successful input migration. @alpha */
export interface OperationMigrationUpdate {
  readonly id: string;
  readonly expectedVersion: number;
  readonly version: number;
  readonly input: JsonValue;
  readonly lane: string;
  readonly dependencies: readonly string[];
  readonly produces: readonly string[];
  readonly updatedAt: number;
}

/** Cross-context lease stored in shared durable metadata. @alpha */
export interface CoordinationLease {
  readonly key: string;
  readonly owner: string;
  readonly expiresAt: number;
}

/**
 * Persistence port used by the replay engine.
 *
 * @alpha
 */
export interface OperationRepository {
  enqueue(operation: StoredOperation): Promise<void>;
  get(id: string): Promise<StoredOperation | undefined>;
  listOperations(scope?: string): Promise<readonly StoredOperation[]>;
  listEligible(query: EligibilityQuery): Promise<readonly StoredOperation[]>;
  claim(id: string, claim: OperationClaim): Promise<StoredOperation | undefined>;
  renewClaim(id: string, owner: string, expiresAt: number, updatedAt: number): Promise<boolean>;
  migrateOperation(update: OperationMigrationUpdate): Promise<StoredOperation | undefined>;
  scheduleRetry(id: string, retry: StoredRetry): Promise<void>;
  releaseClaim(id: string, failure: StoredFailure, updatedAt: number): Promise<void>;
  block(id: string, failure: StoredFailure, updatedAt: number): Promise<void>;
  complete(completion: OperationCompletion): Promise<void>;
  cancel(id: string): Promise<RemovalResult>;
  discard(id: string): Promise<RemovalResult>;
  retryNow(id: string, updatedAt: number): Promise<boolean>;
  recoverExpiredClaims(now: number, scope?: string): Promise<readonly string[]>;
  pauseScope(pause: ScopePause): Promise<void>;
  resumeScope(scope: string): Promise<boolean>;
  getScopePause(scope: string): Promise<ScopePause | undefined>;
  listReceipts(scope: string): Promise<readonly StoredReceipt[]>;
  listReferences(scope: string): Promise<readonly StoredReference[]>;
  resolveReferences(scope: string, keys: readonly string[]): Promise<readonly StoredReference[]>;
  countOperationsByScope(): Promise<readonly ScopeOperationCounts[]>;
  deleteScope(scope: string): Promise<void>;
  acquireCoordinationLease(lease: CoordinationLease, now: number): Promise<boolean>;
  renewCoordinationLease(lease: CoordinationLease): Promise<boolean>;
  releaseCoordinationLease(key: string, owner: string): Promise<boolean>;
  acknowledgeReceipt(operationId: string): Promise<boolean>;
}

/**
 * Mutual-exclusion port shared by pages and workers.
 *
 * @alpha
 */
export interface CoordinationLock {
  runExclusive<T>(key: string, work: () => Promise<T>): Promise<T>;
}

/**
 * Injected source of epoch-millisecond time.
 *
 * @alpha
 */
export interface Clock {
  now(): number;
}

/**
 * Injected UUID source.
 *
 * @alpha
 */
export interface UuidGenerator {
  generate(): string;
}

/**
 * Injected random source returning values in the half-open range `[0, 1)`.
 *
 * @alpha
 */
export interface RandomSource {
  next(): number;
}

/**
 * Connectivity hint used to avoid knowingly futile attempts.
 *
 * @alpha
 */
export interface Connectivity {
  isOnline(): boolean;
}

/**
 * Handle returned by a scheduler.
 *
 * @alpha
 */
export interface ScheduledTask {
  cancel(): void;
}

/**
 * Absolute-time scheduler used for deterministic retry wakeups.
 *
 * @alpha
 */
export interface Scheduler {
  schedule(at: number, task: () => Promise<void> | void): ScheduledTask;
}

/**
 * Structured log levels.
 *
 * @alpha
 */
export type LogLevel = 'debug' | 'error' | 'info' | 'warn';

/**
 * Redacted structured log record.
 *
 * @alpha
 */
export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly context?: Readonly<Record<string, JsonPrimitive>>;
}

/**
 * Optional structured logger port.
 *
 * @alpha
 */
export interface OfflineLogger {
  log(record: LogRecord): void;
}

/**
 * Structured state transitions emitted by the engine.
 *
 * @alpha
 */
export type EngineTransition =
  | {
      readonly type: 'queued';
      readonly at: number;
      readonly operationId: string;
      readonly kind: string;
      readonly scope: string;
    }
  | {
      readonly type: 'execution-started';
      readonly at: number;
      readonly operationId: string;
      readonly kind: string;
      readonly scope: string;
      readonly attempt: number;
    }
  | {
      readonly type: 'retry-scheduled';
      readonly at: number;
      readonly operationId: string;
      readonly kind: string;
      readonly scope: string;
      readonly attempt: number;
      readonly nextAttemptAt: number;
      readonly failure: StoredFailure;
    }
  | {
      readonly type: 'blocked';
      readonly at: number;
      readonly operationId: string;
      readonly kind: string;
      readonly scope: string;
      readonly attempt: number;
      readonly failure: StoredFailure;
    }
  | {
      readonly type: 'succeeded';
      readonly at: number;
      readonly operationId: string;
      readonly kind: string;
      readonly scope: string;
      readonly attempt: number;
    }
  | {
      readonly type: 'scope-paused';
      readonly at: number;
      readonly operationId: string;
      readonly scope: string;
      readonly code: string;
    }
  | { readonly type: 'scope-resumed'; readonly at: number; readonly scope: string }
  | {
      readonly type: 'cancelled' | 'discarded';
      readonly at: number;
      readonly operationId: string;
    }
  | {
      readonly type: 'removal-rejected';
      readonly at: number;
      readonly operationId: string;
      readonly command: 'cancel' | 'discard';
      readonly reason: 'executing';
    }
  | {
      readonly type: 'dependencies-unresolved';
      readonly at: number;
      readonly operationId: string;
      readonly kind: string;
      readonly scope: string;
      readonly missingKeys: readonly string[];
    }
  | {
      readonly type: 'operation-migrated';
      readonly at: number;
      readonly operationId: string;
      readonly kind: string;
      readonly scope: string;
      readonly fromVersion: number;
      readonly toVersion: number;
    }
  | {
      readonly type: 'claims-recovered';
      readonly at: number;
      readonly scope: string;
      readonly operationIds: readonly string[];
    };

/**
 * Receives engine transitions after their corresponding durable changes.
 *
 * @alpha
 */
export interface EngineEventSink {
  emit(event: EngineTransition): Promise<void> | void;
}

/**
 * Options captured while creating a durable operation.
 *
 * @alpha
 */
export interface EnqueueOptions {
  readonly scope: string;
  readonly lane?: string;
}

/**
 * Replay-engine construction settings.
 *
 * @alpha
 */
export interface ReplayEngineOptions {
  readonly coordinationKey: string;
  readonly claimDurationMs?: number;
  readonly maximumOperationsPerRun?: number;
  readonly maximumConcurrentLanes?: number;
  readonly claimRenewalIntervalMs?: number;
}

/**
 * Dependencies required by the framework-independent replay engine.
 *
 * @alpha
 */
export interface ReplayEngineDependencies {
  readonly repository: OperationRepository;
  readonly transport: OperationTransport;
  readonly lock: CoordinationLock;
  readonly clock: Clock;
  readonly uuid: UuidGenerator;
  readonly random: RandomSource;
  readonly connectivity: Connectivity;
  readonly scheduler: Scheduler;
  readonly events: EngineEventSink;
  readonly logger?: OfflineLogger;
  readonly classifyFailure?: FailureClassifier;
}

/**
 * Summary returned after one replay drain.
 *
 * @alpha
 */
export interface ReplayResult {
  readonly scope: string;
  readonly outcome: 'drained' | 'limit-reached' | 'offline' | 'scope-paused';
  readonly attempted: number;
  readonly succeeded: number;
  readonly retried: number;
  readonly blocked: number;
  readonly recoveredClaims: number;
}
