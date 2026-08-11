import {
  Clock,
  Connectivity,
  CoordinationLock,
  EngineEventSink,
  EngineTransition,
  HttpRequestDescriptor,
  JsonPrimitive,
  LogRecord,
  OfflineLogger,
  OfflineTransportError,
  OperationTransport,
  RandomSource,
  ScheduledTask,
  Scheduler,
  TransportContext,
  TransportResponse,
  UuidGenerator,
} from '@poodlelab/ngrx-offline/core';

/**
 * Manually controlled epoch-millisecond clock.
 *
 * @alpha
 */
export class FakeClock implements Clock {
  constructor(private timestamp = 0) {}

  now(): number {
    return this.timestamp;
  }

  set(timestamp: number): void {
    if (!Number.isFinite(timestamp)) {
      throw new Error('Fake clock time must be finite.');
    }
    this.timestamp = timestamp;
  }

  advanceBy(durationMs: number): void {
    this.set(this.timestamp + durationMs);
  }
}

interface PendingTask {
  readonly id: number;
  readonly at: number;
  readonly task: () => Promise<void> | void;
  cancelled: boolean;
}

/**
 * Absolute-time scheduler advanced explicitly by a test.
 *
 * @alpha
 */
export class FakeScheduler implements Scheduler {
  private readonly tasks: PendingTask[] = [];
  private nextId = 1;

  constructor(readonly clock: FakeClock) {}

  schedule(at: number, task: () => Promise<void> | void): ScheduledTask {
    const pending: PendingTask = { id: this.nextId, at, task, cancelled: false };
    this.nextId += 1;
    this.tasks.push(pending);
    return { cancel: () => (pending.cancelled = true) };
  }

  /**
   * Advances time and runs every task due at or before the new instant.
   *
   * @alpha
   */
  async advanceBy(durationMs: number): Promise<void> {
    this.clock.advanceBy(durationMs);
    await this.runDue();
  }

  /**
   * Runs due tasks in time then insertion order, including newly scheduled due tasks.
   *
   * @alpha
   */
  async runDue(): Promise<void> {
    for (;;) {
      const next = this.tasks
        .filter((task) => !task.cancelled && task.at <= this.clock.now())
        .sort((left, right) => (left.at === right.at ? left.id - right.id : left.at - right.at))[0];
      if (next === undefined) {
        return;
      }
      next.cancelled = true;
      await next.task();
    }
  }

  pendingTimes(): readonly number[] {
    return this.tasks
      .filter((task) => !task.cancelled)
      .map((task) => task.at)
      .sort((left, right) => left - right);
  }
}

/**
 * UUID source with stable RFC 4122-shaped values.
 *
 * @alpha
 */
export class DeterministicUuidGenerator implements UuidGenerator {
  private counter: number;

  constructor(start = 1) {
    this.counter = start;
  }

  generate(): string {
    const suffix = this.counter.toString(16).padStart(12, '0');
    this.counter += 1;
    return `00000000-0000-4000-8000-${suffix}`;
  }
}

/**
 * Random source that consumes a known sequence and then repeats its last sample.
 *
 * @alpha
 */
export class SequenceRandomSource implements RandomSource {
  private index = 0;

  constructor(private readonly values: readonly number[] = [0]) {}

  next(): number {
    const fallback = this.values.at(-1) ?? 0;
    const value = this.values[this.index] ?? fallback;
    this.index += 1;
    return value;
  }
}

/**
 * Mutable connectivity hint for online/offline tests.
 *
 * @alpha
 */
export class StaticConnectivity implements Connectivity {
  constructor(public online = true) {}

  isOnline(): boolean {
    return this.online;
  }
}

/**
 * Promise-based coordination lock that serializes work by key.
 *
 * @alpha
 */
export class InMemoryCoordinationLock implements CoordinationLock {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}

/**
 * One recorded transport invocation.
 *
 * @alpha
 */
export interface ScriptedTransportCall {
  readonly request: HttpRequestDescriptor;
  readonly context: TransportContext;
}

/**
 * A response, thrown error, or custom async handler consumed by the scripted transport.
 *
 * @alpha
 */
export type ScriptedTransportStep =
  | { readonly type: 'response'; readonly response: TransportResponse }
  | { readonly type: 'error'; readonly error: unknown }
  | {
      readonly type: 'handler';
      readonly handle: (
        call: ScriptedTransportCall,
      ) => Promise<TransportResponse> | TransportResponse;
    };

/**
 * FIFO transport script supporting success, failure, and deferred race scenarios.
 *
 * @alpha
 */
export class ScriptedTransport implements OperationTransport {
  readonly calls: ScriptedTransportCall[] = [];
  private readonly steps: ScriptedTransportStep[] = [];

  enqueue(...steps: readonly ScriptedTransportStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  respond(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): this {
    return this.enqueue({ type: 'response', response: { status, body, headers } });
  }

  fail(category: 'network' | 'timeout', message = `${category} failure`): this {
    return this.enqueue({ type: 'error', error: new OfflineTransportError(category, message) });
  }

  async execute(
    request: HttpRequestDescriptor,
    context: TransportContext,
  ): Promise<TransportResponse> {
    const call = {
      request: { ...request, headers: { ...(request.headers ?? {}) } },
      context: { ...context },
    };
    this.calls.push(call);
    const step = this.steps.shift();
    if (step === undefined) {
      throw new OfflineTransportError('network', 'The scripted transport has no next step.');
    }
    if (step.type === 'error') {
      throw step.error;
    }
    if (step.type === 'handler') {
      return step.handle(call);
    }
    return step.response;
  }
}

/**
 * Event sink retaining transitions in exact emission order.
 *
 * @alpha
 */
export class RecordingEventSink implements EngineEventSink {
  readonly events: EngineTransition[] = [];

  emit(event: EngineTransition): void {
    this.events.push(event);
  }
}

/**
 * Logger retaining redacted structured records for assertions.
 *
 * @alpha
 */
export class RecordingLogger implements OfflineLogger {
  readonly records: LogRecord[] = [];

  log(record: LogRecord): void {
    this.records.push({
      ...record,
      ...(record.context === undefined ? {} : { context: cloneContext(record.context) }),
    });
  }
}

function cloneContext(
  context: Readonly<Record<string, JsonPrimitive>>,
): Readonly<Record<string, JsonPrimitive>> {
  return { ...context };
}
