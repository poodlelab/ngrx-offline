/**
 * Angular and NgRx integration for durable offline mutations.
 *
 * @packageDocumentation
 */

export {
  collectOfflineReferences,
  defineOfflineCreate,
  defineOfflineOperation,
  isOfflineRef,
  offlineRef,
  resolvedRef,
} from '@poodlelab/ngrx-offline/core';
export type * from '@poodlelab/ngrx-offline/core';
export * from './lib/angular-http-transport';
export * from './lib/mutation-actions';
export * from './lib/offline-worker-bridge';
export type { OfflineOutboxConfig } from './lib/outbox-config';
export {
  OfflineOutboxActions,
  offlineOutboxFeature,
  selectOfflineBlockedCount,
  selectOfflineCountsByScope,
  selectOfflineCountsForScope,
  selectOfflineHydrated,
  selectOfflineOperationById,
  selectOfflineOperations,
  selectOfflineOperationsForScope,
  selectOfflinePendingCount,
  selectOfflineStorageHealth,
  selectOfflineSyncing,
} from './lib/outbox-state';
export type {
  OfflineOperationSummary,
  OfflineOutboxState,
  OfflineScopeCounts,
  OfflineStorageHealth,
} from './lib/outbox-state';
export * from './lib/provide-offline-outbox';
