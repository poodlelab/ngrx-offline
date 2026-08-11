import {
  Clock,
  CoordinationLock,
  OperationRepository,
  ScheduledTask,
  Scheduler,
  UuidGenerator,
} from '@poodlelab/ngrx-offline/core';

/** Minimal Web Locks surface used for capability injection and tests. @alpha */
export interface WebLockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** Settings for cross-context replay coordination. @alpha */
export interface BrowserCoordinationLockOptions {
  readonly repository: OperationRepository;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly uuid: UuidGenerator;
  readonly webLocks?: WebLockManagerLike | null;
  readonly leaseDurationMs?: number;
  readonly pollIntervalMs?: number;
  readonly wait?: (durationMs: number) => Promise<void>;
}

/**
 * Uses the browser Web Locks API, falling back to a renewable transactional
 * IndexedDB lease shared by every page using the same repository database.
 *
 * @alpha
 */
export class BrowserCoordinationLock implements CoordinationLock {
  private readonly owner: string;
  private readonly leaseDurationMs: number;
  private readonly pollIntervalMs: number;
  private readonly webLocks: WebLockManagerLike | undefined;
  private readonly wait: (durationMs: number) => Promise<void>;

  constructor(private readonly options: BrowserCoordinationLockOptions) {
    this.owner = options.uuid.generate();
    this.leaseDurationMs = positive(options.leaseDurationMs, 10_000);
    this.pollIntervalMs = positive(options.pollIntervalMs, 50);
    this.webLocks = options.webLocks === null ? undefined : (options.webLocks ?? browserWebLocks());
    this.wait =
      options.wait ?? ((duration) => new Promise((resolve) => setTimeout(resolve, duration)));
  }

  async runExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.webLocks !== undefined) {
      return this.webLocks.request(key, work);
    }
    while (!(await this.acquire(key))) {
      await this.wait(this.pollIntervalMs);
    }
    const renewal = this.renew(key);
    try {
      return await work();
    } finally {
      renewal.cancel();
      await this.options.repository.releaseCoordinationLease(key, this.owner);
    }
  }

  private acquire(key: string): Promise<boolean> {
    const now = this.options.clock.now();
    return this.options.repository.acquireCoordinationLease(
      { key, owner: this.owner, expiresAt: now + this.leaseDurationMs },
      now,
    );
  }

  private renew(key: string): ScheduledTask {
    let current: ScheduledTask;
    let cancelled = false;
    const renewAt = () => this.options.clock.now() + Math.floor(this.leaseDurationMs / 2);
    const task = async () => {
      if (cancelled) return;
      const renewed = await this.options.repository.renewCoordinationLease({
        key,
        owner: this.owner,
        expiresAt: this.options.clock.now() + this.leaseDurationMs,
      });
      if (renewed && !cancelled) current = this.options.scheduler.schedule(renewAt(), task);
    };
    current = this.options.scheduler.schedule(renewAt(), task);
    return {
      cancel: () => {
        cancelled = true;
        current.cancel();
      },
    };
  }
}

function browserWebLocks(): WebLockManagerLike | undefined {
  if (typeof navigator === 'undefined' || navigator.locks === undefined) return undefined;
  return navigator.locks as WebLockManagerLike;
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
