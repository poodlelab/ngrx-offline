import { StoredOperation } from '@poodlelab/ngrx-offline/core';
import {
  createActionGroup,
  createFeature,
  createReducer,
  createSelector,
  emptyProps,
  on,
  props,
} from '@ngrx/store';
import type { Action, ActionReducer, MemoizedSelector } from '@ngrx/store';

/**
 * Payload-free queue metadata safe to expose through NgRx and Redux DevTools.
 *
 * @alpha
 */
export interface OfflineOperationSummary {
  readonly id: string;
  readonly kind: string;
  readonly version: number;
  readonly scope: string;
  readonly lane: string;
  readonly status: 'blocked' | 'executing' | 'pending';
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly failureCode: string | null;
  readonly failureStatus: number | null;
}

/**
 * Browser persistence health exposed without raw exceptions or payloads.
 *
 * @alpha
 */
export type OfflineStorageHealth =
  | { readonly status: 'available' }
  | { readonly status: 'error'; readonly code: string; readonly message: string };

/**
 * Small reactive outbox projection; full operation data remains in IndexedDB.
 *
 * @alpha
 */
export interface OfflineOutboxState {
  readonly hydrated: boolean;
  readonly syncing: boolean;
  readonly activeScope: string | null;
  readonly pendingCount: number;
  readonly blockedCount: number;
  readonly operations: Readonly<Record<string, OfflineOperationSummary>>;
  readonly storageHealth: OfflineStorageHealth;
}

/** Selector shape exposed by the offline outbox feature. @alpha */
export type OfflineOutboxSelector<Result> = MemoizedSelector<
  Record<string, unknown>,
  Result,
  (featureState: OfflineOutboxState) => Result
>;

/** Stable public shape returned by the NgRx feature factory. @alpha */
export interface OfflineOutboxFeature {
  readonly name: 'ngrxOfflineOutbox';
  readonly reducer: ActionReducer<OfflineOutboxState, Action<string>>;
  readonly selectNgrxOfflineOutboxState: OfflineOutboxSelector<OfflineOutboxState>;
  readonly selectHydrated: OfflineOutboxSelector<boolean>;
  readonly selectSyncing: OfflineOutboxSelector<boolean>;
  readonly selectActiveScope: OfflineOutboxSelector<string | null>;
  readonly selectPendingCount: OfflineOutboxSelector<number>;
  readonly selectBlockedCount: OfflineOutboxSelector<number>;
  readonly selectOperations: OfflineOutboxSelector<
    Readonly<Record<string, OfflineOperationSummary>>
  >;
  readonly selectStorageHealth: OfflineOutboxSelector<OfflineStorageHealth>;
}

/** Payload-free pending and blocked counts grouped by immutable scope. @alpha */
export interface OfflineScopeCounts {
  readonly pending: number;
  readonly blocked: number;
}

/** Public foreground synchronization and queue-management commands. @alpha */
export const OfflineOutboxActions = createActionGroup({
  source: 'NgRx Offline Outbox',
  events: {
    'Sync Now': emptyProps(),
    Retry: props<{ readonly operationId: string }>(),
    Cancel: props<{ readonly operationId: string }>(),
    Discard: props<{ readonly operationId: string }>(),
    'Pause Scope': props<{ readonly scope: string }>(),
    'Resume Scope': props<{ readonly scope: string }>(),
    'Restore Optimistic State': emptyProps(),
    'Logout Scope': props<{ readonly scope: string; readonly confirmed?: boolean }>(),
    'Logout Confirmation Required': props<{
      readonly scope: string;
      readonly pending: number;
      readonly blocked: number;
    }>(),
  },
});

export const offlineOutboxInternalActions = createActionGroup({
  source: 'NgRx Offline Internal',
  events: {
    Hydrated: props<{
      readonly scope: string;
      readonly operations: readonly OfflineOperationSummary[];
    }>(),
    'Summary Upserted': props<{ readonly operation: OfflineOperationSummary }>(),
    'Summary Removed': props<{ readonly operationId: string }>(),
    'Syncing Changed': props<{ readonly syncing: boolean }>(),
    'Storage Available': emptyProps(),
    'Storage Failed': props<{ readonly code: string; readonly message: string }>(),
  },
});

const initialState: OfflineOutboxState = {
  hydrated: false,
  syncing: false,
  activeScope: null,
  pendingCount: 0,
  blockedCount: 0,
  operations: {},
  storageHealth: { status: 'available' },
};

/** NgRx feature registered by `provideOfflineOutbox`. @alpha */
export const offlineOutboxFeature: OfflineOutboxFeature = createFeature({
  name: 'ngrxOfflineOutbox',
  reducer: createReducer(
    initialState,
    on(offlineOutboxInternalActions.hydrated, (state, { scope, operations }) =>
      withCounts({
        ...state,
        hydrated: true,
        activeScope: scope,
        operations: Object.fromEntries(operations.map((operation) => [operation.id, operation])),
        storageHealth: { status: 'available' },
      }),
    ),
    on(offlineOutboxInternalActions.summaryUpserted, (state, { operation }) =>
      withCounts({
        ...state,
        operations: { ...state.operations, [operation.id]: operation },
      }),
    ),
    on(offlineOutboxInternalActions.summaryRemoved, (state, { operationId }) => {
      const operations = { ...state.operations };
      delete operations[operationId];
      return withCounts({ ...state, operations });
    }),
    on(offlineOutboxInternalActions.syncingChanged, (state, { syncing }) => ({
      ...state,
      syncing,
    })),
    on(offlineOutboxInternalActions.storageAvailable, (state) => ({
      ...state,
      storageHealth: { status: 'available' },
    })),
    on(offlineOutboxInternalActions.storageFailed, (state, { code, message }) => ({
      ...state,
      storageHealth: { status: 'error', code, message },
    })),
  ),
});

/** Selects whether durable state has been restored. @alpha */
export const selectOfflineHydrated = offlineOutboxFeature.selectHydrated;
/** Selects whether foreground replay is active. @alpha */
export const selectOfflineSyncing = offlineOutboxFeature.selectSyncing;
/** Selects the pending and executing operation count. @alpha */
export const selectOfflinePendingCount = offlineOutboxFeature.selectPendingCount;
/** Selects the blocked operation count. @alpha */
export const selectOfflineBlockedCount = offlineOutboxFeature.selectBlockedCount;
/** Selects payload-free operation summaries by ID. @alpha */
export const selectOfflineOperations = offlineOutboxFeature.selectOperations;
/** Selects payload-free queue counts for every persisted scope. @alpha */
export const selectOfflineCountsByScope = createSelector(selectOfflineOperations, (operations) => {
  const result: Record<string, OfflineScopeCounts> = {};
  for (const operation of Object.values(operations)) {
    const count = result[operation.scope] ?? { pending: 0, blocked: 0 };
    result[operation.scope] =
      operation.status === 'blocked'
        ? { ...count, blocked: count.blocked + 1 }
        : { ...count, pending: count.pending + 1 };
  }
  return result as Readonly<Record<string, OfflineScopeCounts>>;
});
/** Creates a selector for payload-free counts in one scope. @alpha */
export const selectOfflineCountsForScope = (scope: string) =>
  createSelector(
    selectOfflineCountsByScope,
    (counts) => counts[scope] ?? { pending: 0, blocked: 0 },
  );
/** Selects browser storage health. @alpha */
export const selectOfflineStorageHealth = offlineOutboxFeature.selectStorageHealth;

/** Creates a selector for one payload-free operation summary. @alpha */
export const selectOfflineOperationById = (operationId: string) =>
  createSelector(selectOfflineOperations, (operations) => operations[operationId]);

/** Creates a selector for summaries in one operation scope. @alpha */
export const selectOfflineOperationsForScope = (scope: string) =>
  createSelector(selectOfflineOperations, (operations) =>
    Object.values(operations).filter((operation) => operation.scope === scope),
  );

export function toOperationSummary(operation: StoredOperation): OfflineOperationSummary {
  return {
    id: operation.id,
    kind: operation.kind,
    version: operation.version,
    scope: operation.scope,
    lane: operation.lane,
    status: operation.status,
    attempts: operation.attempts,
    nextAttemptAt: operation.nextAttemptAt,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    failureCode: operation.lastFailure?.code ?? null,
    failureStatus: operation.lastFailure?.status ?? null,
  };
}

function withCounts(state: OfflineOutboxState): OfflineOutboxState {
  const operations = Object.values(state.operations);
  return {
    ...state,
    pendingCount: operations.filter((operation) => operation.status !== 'blocked').length,
    blockedCount: operations.filter((operation) => operation.status === 'blocked').length,
  };
}
