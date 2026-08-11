import { Action } from '@ngrx/store';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { inject } from '@angular/core';
import { concatMap, distinctUntilChanged, filter, from, map, pairwise } from 'rxjs';
import { OfflineOutboxActions } from './outbox-state';
import { OfflineOutboxRuntime, OutboxConnectivity } from './outbox-runtime';

const enqueueRequested = createEffect(
  (actions$ = inject(Actions), runtime = inject(OfflineOutboxRuntime)) =>
    actions$.pipe(
      filter((action: Action) => runtime.isRequested(action)),
      concatMap((action) => from(runtime.enqueueRequested(action))),
    ),
  { functional: true, dispatch: false },
);

const syncNow = createEffect(
  (actions$ = inject(Actions), runtime = inject(OfflineOutboxRuntime)) =>
    actions$.pipe(
      ofType(OfflineOutboxActions.syncNow),
      concatMap(() => from(runtime.sync())),
    ),
  { functional: true, dispatch: false },
);

const retry = createEffect(
  (actions$ = inject(Actions), runtime = inject(OfflineOutboxRuntime)) =>
    actions$.pipe(
      ofType(OfflineOutboxActions.retry),
      concatMap(({ operationId }) => from(runtime.retry(operationId))),
    ),
  { functional: true, dispatch: false },
);

const cancel = createEffect(
  (actions$ = inject(Actions), runtime = inject(OfflineOutboxRuntime)) =>
    actions$.pipe(
      ofType(OfflineOutboxActions.cancel),
      concatMap(({ operationId }) => from(runtime.cancel(operationId))),
    ),
  { functional: true, dispatch: false },
);

const discard = createEffect(
  (actions$ = inject(Actions), runtime = inject(OfflineOutboxRuntime)) =>
    actions$.pipe(
      ofType(OfflineOutboxActions.discard),
      concatMap(({ operationId }) => from(runtime.discard(operationId))),
    ),
  { functional: true, dispatch: false },
);

const pauseScope = createEffect(
  (actions$ = inject(Actions), runtime = inject(OfflineOutboxRuntime)) =>
    actions$.pipe(
      ofType(OfflineOutboxActions.pauseScope),
      concatMap(({ scope }) => from(runtime.pauseScope(scope))),
    ),
  { functional: true, dispatch: false },
);

const resumeScope = createEffect(
  (actions$ = inject(Actions), runtime = inject(OfflineOutboxRuntime)) =>
    actions$.pipe(
      ofType(OfflineOutboxActions.resumeScope),
      concatMap(({ scope }) => from(runtime.resumeScope(scope))),
    ),
  { functional: true, dispatch: false },
);

const restoreOptimisticState = createEffect(
  (actions$ = inject(Actions), runtime = inject(OfflineOutboxRuntime)) =>
    actions$.pipe(
      ofType(OfflineOutboxActions.restoreOptimisticState),
      concatMap(() => from(runtime.restore(undefined, true))),
    ),
  { functional: true, dispatch: false },
);

const logoutScope = createEffect(
  (actions$ = inject(Actions), runtime = inject(OfflineOutboxRuntime)) =>
    actions$.pipe(
      ofType(OfflineOutboxActions.logoutScope),
      concatMap(({ scope, confirmed }) => from(runtime.logoutScope(scope, confirmed ?? false))),
    ),
  { functional: true, dispatch: false },
);

const reconnect = createEffect(
  (connectivity = inject(OutboxConnectivity)) =>
    connectivity.changes.pipe(
      distinctUntilChanged(),
      pairwise(),
      filter(([wasOnline, isOnline]) => !wasOnline && isOnline),
      map(() => OfflineOutboxActions.syncNow()),
    ),
  { functional: true },
);

export const offlineOutboxEffects = {
  enqueueRequested,
  syncNow,
  retry,
  cancel,
  discard,
  pauseScope,
  resumeScope,
  restoreOptimisticState,
  logoutScope,
  reconnect,
};
