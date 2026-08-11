import {
  EngineTransition,
  EnqueueOptions,
  ExecutionFailure,
  FailureDecision,
  HttpMethod,
  HttpRequestDescriptor,
  JsonValue,
  OfflineReference,
  OfflineOperationDefinition,
  ReplayEngineDependencies,
  ReplayEngineOptions,
  ReplayResult,
  ResolvedReference,
  StoredFailure,
  StoredOperation,
  StoredReceipt,
  TransportResponse,
} from './contracts';
import { OfflineConfigurationError, OfflineTransportError } from './errors';
import { calculateRetryDelay, classifyDefaultFailure } from './failure-policy';
import { cloneJsonValue } from './json';
import { OperationRegistry } from './operation-registry';

const HTTP_METHODS: readonly HttpMethod[] = ['DELETE', 'PATCH', 'POST', 'PUT'];

/**
 * Deterministic, framework-independent durable operation replay engine.
 *
 * @alpha
 */
export class ReplayEngine {
  private readonly owner: string;
  private readonly claimDurationMs: number;
  private readonly maximumOperationsPerRun: number;
  private readonly maximumConcurrentLanes: number;
  private readonly claimRenewalIntervalMs: number;
  private lastEnqueueOrder = Number.MIN_SAFE_INTEGER;

  constructor(
    private readonly registry: OperationRegistry,
    private readonly dependencies: ReplayEngineDependencies,
    private readonly options: ReplayEngineOptions,
  ) {
    if (options.coordinationKey.trim() === '') {
      throw new OfflineConfigurationError(
        'invalid_coordination_key',
        'The replay coordination key cannot be empty.',
      );
    }
    this.claimDurationMs = positiveInteger(options.claimDurationMs, 30_000);
    this.maximumOperationsPerRun = positiveInteger(options.maximumOperationsPerRun, 100);
    this.maximumConcurrentLanes = positiveInteger(options.maximumConcurrentLanes, 1);
    this.claimRenewalIntervalMs = positiveInteger(
      options.claimRenewalIntervalMs,
      Math.max(1, Math.floor(this.claimDurationMs / 2)),
    );
    if (this.claimRenewalIntervalMs >= this.claimDurationMs) {
      throw new OfflineConfigurationError(
        'invalid_claim_renewal_interval',
        'The claim renewal interval must be shorter than the claim duration.',
      );
    }
    this.owner = dependencies.uuid.generate();
  }

  /**
   * Validates and durably enqueues an operation without attempting transport work.
   *
   * @alpha
   */
  async enqueue<Input, Result>(
    definition: OfflineOperationDefinition<Input, Result>,
    input: Input,
    options: EnqueueOptions,
  ): Promise<StoredOperation> {
    this.registry.assertRegistered(definition);
    const now = this.dependencies.clock.now();
    const storedInput = cloneJsonValue(input, '$.input');
    const derivedLane = options.lane ?? definition.lane?.(input) ?? 'default';
    const lane = requireIdentifier(derivedLane, 'lane');
    const scope = requireIdentifier(options.scope, 'scope');
    const existing = await this.dependencies.repository.listOperations(scope);
    const newestPersisted = existing.reduce(
      (latest, operation) => Math.max(latest, operation.createdAt),
      Number.MIN_SAFE_INTEGER,
    );
    const createdAt = Math.max(now, newestPersisted + 1, this.lastEnqueueOrder + 1);
    this.lastEnqueueOrder = createdAt;
    const dependencies = validateReferenceKeys(
      definition.dependencies?.(input).map((reference) => reference.key) ?? [],
      'dependency',
    );
    const produces = validateReferenceKeys(definition.producesKeys?.(input) ?? [], 'produced');
    const operation: StoredOperation = {
      id: this.dependencies.uuid.generate(),
      kind: definition.kind,
      version: definition.version,
      scope,
      lane,
      dependencies,
      produces,
      input: storedInput,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      createdAt,
      updatedAt: createdAt,
      claimOwner: null,
      claimExpiresAt: null,
      lastFailure: null,
    };
    await this.dependencies.repository.enqueue(operation);
    await this.emit({
      type: 'queued',
      at: now,
      operationId: operation.id,
      kind: operation.kind,
      scope,
    });
    return operation;
  }

  /**
   * Replays one scope until drained, paused, blocked, retrying, or run-limited.
   *
   * @alpha
   */
  async replay(scopeValue: string): Promise<ReplayResult> {
    const scope = requireIdentifier(scopeValue, 'scope');
    if (!this.dependencies.connectivity.isOnline()) {
      return this.result(scope, 'offline');
    }
    if ((await this.dependencies.repository.getScopePause(scope)) !== undefined) {
      return this.result(scope, 'scope-paused');
    }

    return this.dependencies.lock.runExclusive(
      `${this.options.coordinationKey}:${scope}`,
      async () => {
        if (!this.dependencies.connectivity.isOnline()) {
          return this.result(scope, 'offline');
        }
        if ((await this.dependencies.repository.getScopePause(scope)) !== undefined) {
          return this.result(scope, 'scope-paused');
        }

        const recovered = await this.dependencies.repository.recoverExpiredClaims(
          this.dependencies.clock.now(),
          scope,
        );
        if (recovered.length > 0) {
          await this.emit({
            type: 'claims-recovered',
            at: this.dependencies.clock.now(),
            scope,
            operationIds: recovered,
          });
        }

        let attempted = 0;
        let succeeded = 0;
        let retried = 0;
        let blocked = 0;

        while (attempted < this.maximumOperationsPerRun) {
          if (!this.dependencies.connectivity.isOnline()) {
            return {
              scope,
              outcome: 'offline',
              attempted,
              succeeded,
              retried,
              blocked,
              recoveredClaims: recovered.length,
            };
          }

          const operations = await this.dependencies.repository.listEligible({
            scope,
            now: this.dependencies.clock.now(),
            limit: this.maximumOperationsPerRun,
          });
          if (operations.length === 0) {
            return {
              scope,
              outcome: 'drained',
              attempted,
              succeeded,
              retried,
              blocked,
              recoveredClaims: recovered.length,
            };
          }

          const prepared = await Promise.all(
            operations.map((operation) => this.prepare(operation)),
          );
          blocked += prepared.filter((item) => item.type === 'blocked').length;
          const ready = prepared.filter(
            (item): item is Extract<PreparedOperation, { type: 'ready' }> => item.type === 'ready',
          );
          if (ready.length === 0) {
            if (prepared.some((item) => item.type === 'blocked')) {
              continue;
            }
            return {
              scope,
              outcome: 'drained',
              attempted,
              succeeded,
              retried,
              blocked,
              recoveredClaims: recovered.length,
            };
          }

          const claimed = (
            await Promise.all(
              ready
                .slice(
                  0,
                  Math.min(this.maximumConcurrentLanes, this.maximumOperationsPerRun - attempted),
                )
                .map(async (item) => {
                  const claimTime = this.dependencies.clock.now();
                  const operation = await this.dependencies.repository.claim(item.operation.id, {
                    owner: this.owner,
                    claimedAt: claimTime,
                    expiresAt: claimTime + this.claimDurationMs,
                  });
                  if (operation === undefined) return undefined;
                  await this.emit({
                    type: 'execution-started',
                    at: claimTime,
                    operationId: operation.id,
                    kind: operation.kind,
                    scope: operation.scope,
                    attempt: operation.attempts,
                  });
                  return { ...item, operation };
                }),
            )
          ).filter(
            (item): item is Extract<PreparedOperation, { type: 'ready' }> => item !== undefined,
          );

          attempted += claimed.length;
          const outcomes = await Promise.all(
            claimed.map((item) => this.execute(item.operation, item.definition, item.references)),
          );
          succeeded += outcomes.filter((outcome) => outcome === 'succeeded').length;
          retried += outcomes.filter((outcome) => outcome === 'retried').length;
          blocked += outcomes.filter((outcome) => outcome === 'blocked').length;
          if (outcomes.some((outcome) => outcome === 'paused')) {
            return {
              scope,
              outcome: 'scope-paused',
              attempted,
              succeeded,
              retried,
              blocked,
              recoveredClaims: recovered.length,
            };
          }
        }

        return {
          scope,
          outcome: attempted >= this.maximumOperationsPerRun ? 'limit-reached' : 'drained',
          attempted,
          succeeded,
          retried,
          blocked,
          recoveredClaims: recovered.length,
        };
      },
    );
  }

  private async prepare(operationValue: StoredOperation): Promise<PreparedOperation> {
    let operation = operationValue;
    const definition = this.registry.get(operation.kind);
    if (definition === undefined) {
      await this.blockDefinition(operation);
      return { type: 'blocked' };
    }
    if (operation.version !== definition.version) {
      const migrated = await this.migrate(operation, definition);
      if (migrated === undefined) return { type: 'blocked' };
      operation = migrated;
    }

    const references = await this.dependencies.repository.resolveReferences(
      operation.scope,
      operation.dependencies,
    );
    const resolved = new Map(references.map((reference) => [reference.key, reference.value]));
    const missingKeys = operation.dependencies.filter((key) => !resolved.has(key));
    if (missingKeys.length === 0) {
      return { type: 'ready', operation, definition, references: resolved };
    }

    const scopeOperations = await this.dependencies.repository.listOperations(operation.scope);
    const producers = missingKeys.map((key) => ({
      key,
      operation: scopeOperations.find((candidate) => candidate.produces.includes(key)),
    }));
    const failed = producers.filter((item) => item.operation?.status === 'blocked');
    const absent = producers.filter((item) => item.operation === undefined);
    if (failed.length > 0 || absent.length > 0) {
      const now = this.dependencies.clock.now();
      const failure: StoredFailure = {
        category: 'request',
        code: failed.length > 0 ? 'dependency_failed' : 'missing_dependency',
        failedAt: now,
        message:
          failed.length > 0
            ? 'A referenced producer operation is blocked.'
            : 'No operation or resolved mapping provides a required reference.',
        detail: { missingKeys },
      };
      await this.dependencies.repository.block(operation.id, failure, now);
      await this.emitBlocked(operation, failure, operation.attempts);
      return { type: 'blocked' };
    }
    await this.emit({
      type: 'dependencies-unresolved',
      at: this.dependencies.clock.now(),
      operationId: operation.id,
      kind: operation.kind,
      scope: operation.scope,
      missingKeys,
    });
    return { type: 'waiting' };
  }

  private async migrate(
    operation: StoredOperation,
    definition: NonNullable<ReturnType<OperationRegistry['get']>>,
  ): Promise<StoredOperation | undefined> {
    if (operation.version > definition.version) {
      await this.blockDefinition(operation, definition.version);
      return undefined;
    }
    let version = operation.version;
    let input = operation.input;
    try {
      while (version < definition.version) {
        const migration = definition.migrations?.find(
          (candidate) => candidate.fromVersion === version,
        );
        if (migration === undefined) {
          await this.blockDefinition(operation, definition.version);
          return undefined;
        }
        input = cloneJsonValue(migration.migrate(input), '$.migratedInput');
        version = migration.toVersion;
      }
      const typedInput = input as unknown;
      const lane = requireIdentifier(definition.lane?.(typedInput) ?? operation.lane, 'lane');
      const dependencies = validateReferenceKeys(
        definition.dependencies?.(typedInput).map((reference) => reference.key) ?? [],
        'dependency',
      );
      const produces = validateReferenceKeys(
        definition.producesKeys?.(typedInput) ?? [],
        'produced',
      );
      const migrated = await this.dependencies.repository.migrateOperation({
        id: operation.id,
        expectedVersion: operation.version,
        version,
        input,
        lane,
        dependencies,
        produces,
        updatedAt: this.dependencies.clock.now(),
      });
      if (migrated !== undefined) {
        await this.emit({
          type: 'operation-migrated',
          at: migrated.updatedAt,
          operationId: migrated.id,
          kind: migrated.kind,
          scope: migrated.scope,
          fromVersion: operation.version,
          toVersion: migrated.version,
        });
      }
      return migrated;
    } catch (error) {
      const failure: StoredFailure = {
        category: 'request',
        code: 'operation_migration_failed',
        failedAt: this.dependencies.clock.now(),
        message: safeMessage(error, 'The persisted operation input migration failed.'),
      };
      await this.dependencies.repository.block(operation.id, failure, failure.failedAt);
      await this.emitBlocked(operation, failure, operation.attempts);
      return undefined;
    }
  }

  private async blockDefinition(
    operation: StoredOperation,
    currentVersion?: number,
  ): Promise<void> {
    const failure = this.definitionFailure(operation, currentVersion);
    await this.dependencies.repository.block(operation.id, failure, failure.failedAt);
    await this.emitBlocked(operation, failure, operation.attempts);
  }

  /**
   * Resumes a durably paused scope.
   *
   * @alpha
   */
  async resumeScope(scopeValue: string): Promise<boolean> {
    const scope = requireIdentifier(scopeValue, 'scope');
    const resumed = await this.dependencies.repository.resumeScope(scope);
    if (resumed) {
      await this.emit({ type: 'scope-resumed', at: this.dependencies.clock.now(), scope });
    }
    return resumed;
  }

  /**
   * Removes a pending operation; an executing operation is deliberately not interrupted.
   *
   * @alpha
   */
  cancel(operationId: string): Promise<'executing' | 'not-found' | 'removed'> {
    return this.remove(operationId, 'cancel');
  }

  /**
   * Explicitly removes a pending or blocked operation.
   *
   * @alpha
   */
  discard(operationId: string): Promise<'executing' | 'not-found' | 'removed'> {
    return this.remove(operationId, 'discard');
  }

  private async execute(
    operation: StoredOperation,
    definition: NonNullable<ReturnType<OperationRegistry['get']>>,
    resolvedReferences: ReadonlyMap<string, number | string>,
  ): Promise<'blocked' | 'paused' | 'retried' | 'succeeded'> {
    const renewal = this.scheduleClaimRenewal(operation);
    try {
      return await this.executeClaimed(operation, definition, resolvedReferences);
    } finally {
      renewal.cancel();
    }
  }

  private async executeClaimed(
    operation: StoredOperation,
    definition: NonNullable<ReturnType<OperationRegistry['get']>>,
    resolvedReferences: ReadonlyMap<string, number | string>,
  ): Promise<'blocked' | 'paused' | 'retried' | 'succeeded'> {
    let request: HttpRequestDescriptor;
    try {
      request = withIdempotencyKey(
        definition.request(operation.input, {
          operationId: operation.id,
          scope: operation.scope,
          attempt: operation.attempts,
          resolve: (reference: OfflineReference) => {
            if (!operation.dependencies.includes(reference.key)) {
              throw new OfflineConfigurationError(
                'undeclared_offline_reference',
                `Reference "${reference.key}" was not declared as an operation dependency.`,
              );
            }
            const value = resolvedReferences.get(reference.key);
            if (value === undefined) {
              throw new OfflineConfigurationError(
                'unresolved_offline_reference',
                `Reference "${reference.key}" is unresolved in scope "${operation.scope}".`,
              );
            }
            return value;
          },
        }),
        operation.id,
      );
    } catch (error) {
      return this.handleFailure(
        operation,
        {
          category: 'request',
          message: safeMessage(error, 'The operation request could not be built.'),
        },
        definition.retryPolicy,
      );
    }

    let response: TransportResponse;
    try {
      response = await this.dependencies.transport.execute(request, {
        operationId: operation.id,
        idempotencyKey: operation.id,
        kind: operation.kind,
        scope: operation.scope,
        attempt: operation.attempts,
      });
    } catch (error) {
      const category = error instanceof OfflineTransportError ? error.category : 'network';
      return this.handleFailure(
        operation,
        { category, message: safeMessage(error, 'The transport failed.') },
        definition.retryPolicy,
      );
    }

    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      return this.handleFailure(
        operation,
        { category: 'response', message: 'The transport returned an invalid HTTP status.' },
        definition.retryPolicy,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return this.handleFailure(
        operation,
        {
          category: 'http',
          message: `The server returned HTTP ${response.status}.`,
          status: response.status,
          headers: response.headers,
        },
        definition.retryPolicy,
      );
    }

    let result: JsonValue;
    let references: readonly ResolvedReference[];
    try {
      const parsed =
        definition.parseResult === undefined ? response.body : definition.parseResult(response);
      result = cloneJsonValue(parsed, '$.result');
      references = validateReferences(
        definition.produces?.({ input: operation.input, result }) ?? [],
      );
      const actualKeys = references.map((reference) => reference.key).sort();
      const declaredKeys = [...operation.produces].sort();
      if (
        (definition.producesKeys !== undefined && actualKeys.length !== declaredKeys.length) ||
        (definition.producesKeys !== undefined &&
          actualKeys.some((key, index) => key !== declaredKeys[index]))
      ) {
        throw new OfflineConfigurationError(
          'produced_reference_mismatch',
          'Produced reference keys do not match the keys declared when the operation was queued.',
        );
      }
    } catch (error) {
      return this.handleFailure(
        operation,
        {
          category: 'response',
          message: safeMessage(error, 'The operation response could not be parsed.'),
          status: response.status,
        },
        definition.retryPolicy,
      );
    }

    const completedAt = this.dependencies.clock.now();
    const receipt: StoredReceipt = {
      operationId: operation.id,
      kind: operation.kind,
      version: operation.version,
      scope: operation.scope,
      input: operation.input,
      result,
      producedReferences: references,
      completedAt,
    };
    await this.dependencies.repository.complete({
      operationId: operation.id,
      receipt,
      references: references.map((reference) => ({
        ...reference,
        scope: operation.scope,
        producerOperationId: operation.id,
        resolvedAt: completedAt,
      })),
    });
    await this.emit({
      type: 'succeeded',
      at: completedAt,
      operationId: operation.id,
      kind: operation.kind,
      scope: operation.scope,
      attempt: operation.attempts,
    });
    return 'succeeded';
  }

  private scheduleClaimRenewal(operation: StoredOperation) {
    let cancelled = false;
    let scheduled: ReturnType<typeof this.dependencies.scheduler.schedule>;
    const scheduledTask = async () => {
      if (cancelled) return;
      const now = this.dependencies.clock.now();
      const renewed = await this.dependencies.repository.renewClaim(
        operation.id,
        this.owner,
        now + this.claimDurationMs,
        now,
      );
      if (renewed && !cancelled) {
        scheduled = this.dependencies.scheduler.schedule(
          now + this.claimRenewalIntervalMs,
          scheduledTask,
        );
      }
    };
    scheduled = this.dependencies.scheduler.schedule(
      this.dependencies.clock.now() + this.claimRenewalIntervalMs,
      scheduledTask,
    );
    return {
      cancel: () => {
        cancelled = true;
        scheduled.cancel();
      },
    };
  }

  private async handleFailure(
    operation: StoredOperation,
    failure: ExecutionFailure,
    retryPolicy: NonNullable<ReturnType<OperationRegistry['get']>>['retryPolicy'],
  ): Promise<'blocked' | 'paused' | 'retried'> {
    const now = this.dependencies.clock.now();
    let decision: FailureDecision;
    try {
      decision = (this.dependencies.classifyFailure ?? classifyDefaultFailure)(failure, {
        attempt: operation.attempts,
        kind: operation.kind,
        now,
        operationId: operation.id,
        scope: operation.scope,
      });
    } catch (error) {
      decision = { type: 'block', code: 'failure_classifier_error' };
      this.log('error', 'Failure classifier threw.', {
        operationId: operation.id,
        error: safeMessage(error, 'Unknown classifier error.'),
      });
    }

    if (
      decision.type === 'retry' &&
      retryPolicy?.maximumAttempts !== undefined &&
      operation.attempts >= retryPolicy.maximumAttempts
    ) {
      decision = { type: 'block', code: 'maximum_attempts_reached' };
    }

    const storedFailure = toStoredFailure(failure, decision, now);
    if (decision.type === 'pause-scope') {
      await this.dependencies.repository.releaseClaim(operation.id, storedFailure, now);
      await this.dependencies.repository.pauseScope({
        scope: operation.scope,
        code: decision.code,
        pausedAt: now,
      });
      await this.emit({
        type: 'scope-paused',
        at: now,
        operationId: operation.id,
        scope: operation.scope,
        code: decision.code,
      });
      return 'paused';
    }

    if (decision.type === 'block') {
      await this.dependencies.repository.block(operation.id, storedFailure, now);
      await this.emitBlocked(operation, storedFailure, operation.attempts);
      return 'blocked';
    }

    const classifiedDelay = decision.delayMs;
    const delay =
      classifiedDelay !== undefined && Number.isFinite(classifiedDelay)
        ? Math.max(0, classifiedDelay)
        : calculateRetryDelay(retryPolicy, operation.attempts, this.dependencies.random);
    const nextAttemptAt = now + Math.max(0, Math.round(delay));
    await this.dependencies.repository.scheduleRetry(operation.id, {
      attempt: operation.attempts,
      failure: storedFailure,
      nextAttemptAt,
      updatedAt: now,
    });
    await this.emit({
      type: 'retry-scheduled',
      at: now,
      operationId: operation.id,
      kind: operation.kind,
      scope: operation.scope,
      attempt: operation.attempts,
      nextAttemptAt,
      failure: storedFailure,
    });
    this.dependencies.scheduler.schedule(nextAttemptAt, async () => {
      try {
        await this.replay(operation.scope);
      } catch (error) {
        this.log('error', 'Scheduled replay failed.', {
          operationId: operation.id,
          error: safeMessage(error, 'Unknown replay error.'),
        });
      }
    });
    return 'retried';
  }

  private async remove(operationId: string, command: 'cancel' | 'discard') {
    const result = await this.dependencies.repository[command](operationId);
    const at = this.dependencies.clock.now();
    if (result === 'removed') {
      await this.emit({
        type: command === 'cancel' ? 'cancelled' : 'discarded',
        at,
        operationId,
      });
    } else if (result === 'executing') {
      await this.emit({
        type: 'removal-rejected',
        at,
        operationId,
        command,
        reason: 'executing',
      });
    }
    return result;
  }

  private definitionFailure(operation: StoredOperation, currentVersion?: number): StoredFailure {
    const missing = currentVersion === undefined;
    return {
      category: 'request',
      code: missing ? 'unknown_operation_definition' : 'missing_operation_migration',
      failedAt: this.dependencies.clock.now(),
      message: missing
        ? `No definition is registered for operation kind "${operation.kind}".`
        : `Stored version ${operation.version} cannot run with registered version ${currentVersion}.`,
    };
  }

  private emitBlocked(operation: StoredOperation, failure: StoredFailure, attempt: number) {
    return this.emit({
      type: 'blocked',
      at: failure.failedAt,
      operationId: operation.id,
      kind: operation.kind,
      scope: operation.scope,
      attempt,
      failure,
    });
  }

  private async emit(event: EngineTransition): Promise<void> {
    try {
      await this.dependencies.events.emit(event);
    } catch (error) {
      this.log('error', 'Engine event sink threw after a durable transition.', {
        transition: event.type,
        error: safeMessage(error, 'Unknown event sink error.'),
      });
    }
  }

  private log(
    level: 'debug' | 'error' | 'info' | 'warn',
    message: string,
    context: Readonly<Record<string, boolean | null | number | string>>,
  ): void {
    this.dependencies.logger?.log({ level, message, context });
  }

  private result(scope: string, outcome: ReplayResult['outcome']): ReplayResult {
    return {
      scope,
      outcome,
      attempted: 0,
      succeeded: 0,
      retried: 0,
      blocked: 0,
      recoveredClaims: 0,
    };
  }
}

type PreparedOperation =
  | { readonly type: 'blocked' | 'waiting' }
  | {
      readonly type: 'ready';
      readonly operation: StoredOperation;
      readonly definition: NonNullable<ReturnType<OperationRegistry['get']>>;
      readonly references: ReadonlyMap<string, number | string>;
    };

function withIdempotencyKey(
  request: HttpRequestDescriptor,
  operationId: string,
): HttpRequestDescriptor {
  if (!HTTP_METHODS.includes(request.method)) {
    throw new OfflineConfigurationError(
      'invalid_http_method',
      'The request method is not supported.',
    );
  }
  if (typeof request.url !== 'string' || request.url.trim() === '') {
    throw new OfflineConfigurationError('invalid_request_url', 'The request URL cannot be empty.');
  }
  if (
    request.timeoutMs !== undefined &&
    (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)
  ) {
    throw new OfflineConfigurationError(
      'invalid_request_timeout',
      'The request timeout must be positive.',
    );
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (typeof value !== 'string') {
      throw new OfflineConfigurationError(
        'invalid_request_header',
        `Request header "${name}" must be a string.`,
      );
    }
    if (name.toLowerCase() !== 'idempotency-key') {
      headers[name] = value;
    }
  }
  headers['Idempotency-Key'] = operationId;

  return {
    ...request,
    ...(request.body === undefined ? {} : { body: cloneJsonValue(request.body, '$.request.body') }),
    headers,
  };
}

function validateReferences(
  references: readonly ResolvedReference[],
): readonly ResolvedReference[] {
  const keys = new Set<string>();
  return references.map((reference, index) => {
    const key = requireIdentifier(reference.key, `reference[${index}].key`);
    if (keys.has(key)) {
      throw new OfflineConfigurationError(
        'duplicate_reference_key',
        `Produced reference key "${key}" occurs more than once.`,
      );
    }
    keys.add(key);
    if (
      (typeof reference.value !== 'string' && typeof reference.value !== 'number') ||
      (typeof reference.value === 'number' && !Number.isFinite(reference.value))
    ) {
      throw new OfflineConfigurationError(
        'invalid_reference_value',
        `Produced reference "${key}" must be a finite number or string.`,
      );
    }
    return { key, value: reference.value };
  });
}

function validateReferenceKeys(keys: readonly string[], name: string): readonly string[] {
  const unique = new Set<string>();
  for (const [index, keyValue] of keys.entries()) {
    const key = requireIdentifier(keyValue, `${name}[${index}]`);
    if (unique.has(key)) {
      throw new OfflineConfigurationError(
        `duplicate_${name}_reference`,
        `The ${name} reference key "${key}" occurs more than once.`,
      );
    }
    unique.add(key);
  }
  return [...unique];
}

function toStoredFailure(
  failure: ExecutionFailure,
  decision: FailureDecision,
  failedAt: number,
): StoredFailure {
  const code = decision.type === 'retry' ? failure.category : decision.code;
  return {
    category: failure.category,
    code,
    failedAt,
    message: failure.message,
    ...('status' in failure && failure.status !== undefined ? { status: failure.status } : {}),
    ...(decision.type === 'block' && decision.detail !== undefined
      ? { detail: cloneJsonValue(decision.detail, '$.failure.detail') }
      : {}),
  };
}

function requireIdentifier(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OfflineConfigurationError(
      `invalid_${name.replaceAll('.', '_')}`,
      `The ${name} cannot be empty.`,
    );
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback;
}
