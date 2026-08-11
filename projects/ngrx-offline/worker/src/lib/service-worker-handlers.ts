import {
  OfflineWorkerSyncRequest,
  isOfflineWorkerSyncRequest,
  scopeFromOfflineWorkerSyncTag,
} from '@poodlelab/ngrx-offline/core';
import { WorkerOutboxExecutor } from './worker-outbox-executor';

/** Minimal extendable event shared by message and Background Sync handlers. @alpha */
export interface WorkerExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** Minimal service-worker message event used by the portable handler. @alpha */
export interface WorkerMessageEventLike extends WorkerExtendableEventLike {
  readonly data: unknown;
}

/** Minimal Background Sync event used by the portable handler. @alpha */
export interface WorkerSyncEventLike extends WorkerExtendableEventLike {
  readonly tag: string;
}

/** Minimal service-worker global event target used by the portable handler. @alpha */
export interface OfflineWorkerGlobalScopeLike {
  addEventListener(type: string, listener: EventListener): void;
}

/** Service-worker event integration options. @alpha */
export interface RegisterOfflineWorkerHandlersOptions {
  readonly scope: OfflineWorkerGlobalScopeLike;
  readonly executor: WorkerOutboxExecutor;
  /** Captures application-specific ephemeral data before an explicit replay. */
  readonly prepareRequest?: (request: OfflineWorkerSyncRequest) => void | Promise<void>;
}

/** Registers explicit-message and Background Sync replay handlers. @alpha */
export function registerOfflineWorkerHandlers(options: RegisterOfflineWorkerHandlersOptions): void {
  options.scope.addEventListener('message', (event) => {
    const message = event as unknown as WorkerMessageEventLike;
    if (!isOfflineWorkerSyncRequest(message.data)) return;
    message.waitUntil(runExplicitRequest(options, message.data));
  });
  options.scope.addEventListener('sync', (event) => {
    const sync = event as unknown as WorkerSyncEventLike;
    const scope = scopeFromOfflineWorkerSyncTag(sync.tag);
    if (scope === undefined) return;
    sync.waitUntil(options.executor.sync(scope));
  });
}

async function runExplicitRequest(
  options: RegisterOfflineWorkerHandlersOptions,
  request: OfflineWorkerSyncRequest,
): Promise<void> {
  await options.prepareRequest?.(request);
  await options.executor.sync(request.scope);
}
