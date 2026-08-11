import {
  AnyOfflineOperationDefinition,
  OfflineOperationDefinition,
  StoredFailure,
} from '@poodlelab/ngrx-offline/core';
import { Action, ActionCreator, Creator, createAction, props } from '@ngrx/store';

/**
 * Sanitized enqueue failure exposed to application reducers.
 *
 * @alpha
 */
export interface OfflineEnqueueFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * Typed NgRx action creator used by an offline mutation binding.
 *
 * @alpha
 */
export type OfflineActionCreator<Props extends object> = ActionCreator<
  string,
  (props: Props) => Props & Action<string>
>;

/**
 * Typed lifecycle actions bound to a worker-safe operation definition.
 *
 * @alpha
 */
export interface OfflineMutationBinding<Input, Result> {
  readonly definition: OfflineOperationDefinition<Input, Result>;
  readonly requested: OfflineActionCreator<{ readonly input: Input }>;
  readonly enqueueFailed: OfflineActionCreator<{
    readonly input: Input;
    readonly error: OfflineEnqueueFailure;
  }>;
  readonly queued: OfflineActionCreator<{
    readonly operationId: string;
    readonly input: Input;
    readonly scope: string;
  }>;
  readonly restored: OfflineActionCreator<{
    readonly operationId: string;
    readonly input: Input;
    readonly scope: string;
    readonly status: 'blocked' | 'pending';
  }>;
  readonly executionStarted: OfflineActionCreator<{
    readonly operationId: string;
    readonly attempt: number;
  }>;
  readonly retryScheduled: OfflineActionCreator<{
    readonly operationId: string;
    readonly attempt: number;
    readonly nextAttemptAt: number;
    readonly failure: StoredFailure;
  }>;
  readonly succeeded: OfflineActionCreator<{
    readonly operationId: string;
    readonly input: Input;
    readonly result: Result;
    readonly scope: string;
  }>;
  readonly blocked: OfflineActionCreator<{
    readonly operationId: string;
    readonly input: Input;
    readonly scope: string;
    readonly failure: StoredFailure;
  }>;
  readonly cancelled: OfflineActionCreator<{ readonly operationId: string }>;
}

/**
 * Type-erased mutation binding accepted by the provider registry.
 *
 * @alpha
 */
export interface AnyOfflineMutationBinding {
  readonly definition: AnyOfflineOperationDefinition;
  readonly requested: ActionCreator<string, Creator>;
  readonly enqueueFailed: ActionCreator<string, Creator>;
  readonly queued: ActionCreator<string, Creator>;
  readonly restored: ActionCreator<string, Creator>;
  readonly executionStarted: ActionCreator<string, Creator>;
  readonly retryScheduled: ActionCreator<string, Creator>;
  readonly succeeded: ActionCreator<string, Creator>;
  readonly blocked: ActionCreator<string, Creator>;
  readonly cancelled: ActionCreator<string, Creator>;
}

/**
 * Options controlling the observable NgRx action source.
 *
 * @alpha
 */
export interface CreateOfflineMutationOptions {
  readonly source?: string;
}

/**
 * Creates typed requested, durable, execution, and reconciliation actions.
 *
 * @alpha
 */
export function createOfflineMutation<Input, Result>(
  definition: OfflineOperationDefinition<Input, Result>,
  options: CreateOfflineMutationOptions = {},
): OfflineMutationBinding<Input, Result> {
  const source = options.source ?? 'Offline';
  const prefix = `${definition.kind}`;
  return {
    definition,
    requested: createAction(`[${source}] ${prefix} Requested`, props<{ readonly input: Input }>()),
    enqueueFailed: createAction(
      `[${source}] ${prefix} Enqueue Failed`,
      props<{ readonly input: Input; readonly error: OfflineEnqueueFailure }>(),
    ),
    queued: createAction(
      `[${source}] ${prefix} Queued`,
      props<{ readonly operationId: string; readonly input: Input; readonly scope: string }>(),
    ),
    restored: createAction(
      `[${source}] ${prefix} Restored`,
      props<{
        readonly operationId: string;
        readonly input: Input;
        readonly scope: string;
        readonly status: 'blocked' | 'pending';
      }>(),
    ),
    executionStarted: createAction(
      `[${source}] ${prefix} Execution Started`,
      props<{ readonly operationId: string; readonly attempt: number }>(),
    ),
    retryScheduled: createAction(
      `[${source}] ${prefix} Retry Scheduled`,
      props<{
        readonly operationId: string;
        readonly attempt: number;
        readonly nextAttemptAt: number;
        readonly failure: StoredFailure;
      }>(),
    ),
    succeeded: createAction(
      `[${source}] ${prefix} Succeeded`,
      props<{
        readonly operationId: string;
        readonly input: Input;
        readonly result: Result;
        readonly scope: string;
      }>(),
    ),
    blocked: createAction(
      `[${source}] ${prefix} Blocked`,
      props<{
        readonly operationId: string;
        readonly input: Input;
        readonly scope: string;
        readonly failure: StoredFailure;
      }>(),
    ),
    cancelled: createAction(
      `[${source}] ${prefix} Cancelled`,
      props<{ readonly operationId: string }>(),
    ),
  };
}
