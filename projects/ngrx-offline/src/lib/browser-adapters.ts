import {
  Clock,
  Connectivity,
  CoordinationLock,
  RandomSource,
  ScheduledTask,
  Scheduler,
  UuidGenerator,
} from '@poodlelab/ngrx-offline/core';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

/**
 * Browser epoch clock.
 *
 * @alpha
 */
@Injectable()
export class BrowserClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * Cryptographically strong browser UUID source.
 *
 * @alpha
 */
@Injectable()
export class BrowserUuidGenerator implements UuidGenerator {
  generate(): string {
    return crypto.randomUUID();
  }
}

/**
 * Browser random source backed by cryptographic random integers.
 *
 * @alpha
 */
@Injectable()
export class BrowserRandomSource implements RandomSource {
  next(): number {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return (value[0] ?? 0) / 0x1_0000_0000;
  }
}

/**
 * Browser timer scheduler with cancellable wakeups.
 *
 * @alpha
 */
@Injectable()
export class BrowserScheduler implements Scheduler {
  private readonly timers = new Set<ReturnType<typeof globalThis.setTimeout>>();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      for (const timer of this.timers) {
        globalThis.clearTimeout(timer);
      }
      this.timers.clear();
    });
  }

  schedule(at: number, task: () => Promise<void> | void): ScheduledTask {
    const timer = globalThis.setTimeout(
      () => {
        this.timers.delete(timer);
        void task();
      },
      Math.max(0, at - Date.now()),
    );
    this.timers.add(timer);
    return {
      cancel: () => {
        globalThis.clearTimeout(timer);
        this.timers.delete(timer);
      },
    };
  }
}

/**
 * Foreground-only keyed mutex. Cross-tab Web Locks coordination arrives in Phase 4.
 *
 * @alpha
 */
@Injectable()
export class ForegroundCoordinationLock implements CoordinationLock {
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
 * Online/offline browser hint whose listeners are removed with the injection context.
 *
 * @alpha
 */
@Injectable()
export class BrowserConnectivity implements Connectivity {
  private readonly onlineState = new BehaviorSubject<boolean>(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  readonly changes: Observable<boolean> = this.onlineState.asObservable();

  constructor() {
    const destroyRef = inject(DestroyRef);
    if (typeof globalThis.addEventListener === 'function') {
      const online = () => this.onlineState.next(true);
      const offline = () => this.onlineState.next(false);
      globalThis.addEventListener('online', online);
      globalThis.addEventListener('offline', offline);
      destroyRef.onDestroy(() => {
        globalThis.removeEventListener('online', online);
        globalThis.removeEventListener('offline', offline);
        this.onlineState.complete();
      });
    } else {
      destroyRef.onDestroy(() => this.onlineState.complete());
    }
  }

  isOnline(): boolean {
    return this.onlineState.value;
  }
}
