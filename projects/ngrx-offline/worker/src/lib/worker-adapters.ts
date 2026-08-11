import {
  Clock,
  Connectivity,
  EngineEventSink,
  RandomSource,
  ScheduledTask,
  Scheduler,
  UuidGenerator,
} from '@poodlelab/ngrx-offline/core';

/** Epoch clock usable in pages and workers. @alpha */
export class WorkerClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** Cryptographically strong UUID source usable in pages and workers. @alpha */
export class WorkerUuidGenerator implements UuidGenerator {
  generate(): string {
    return globalThis.crypto.randomUUID();
  }
}

/** Cryptographically backed random source usable in pages and workers. @alpha */
export class WorkerRandomSource implements RandomSource {
  next(): number {
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    return (value[0] ?? 0) / 0x1_0000_0000;
  }
}

/** Cancellable timer scheduler usable in a service worker. @alpha */
export class WorkerScheduler implements Scheduler {
  schedule(at: number, task: () => Promise<void> | void): ScheduledTask {
    const timer = globalThis.setTimeout(() => void task(), Math.max(0, at - Date.now()));
    return { cancel: () => globalThis.clearTimeout(timer) };
  }
}

/** Best-effort online hint; correctness continues to come from transport results. @alpha */
export class WorkerConnectivity implements Connectivity {
  isOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine;
  }
}

/** Event sink for worker consumers that rely only on durable receipts and notifications. @alpha */
export class NoopWorkerEventSink implements EngineEventSink {
  emit(): void {
    // Durable repository state is the source of truth in a worker.
  }
}
