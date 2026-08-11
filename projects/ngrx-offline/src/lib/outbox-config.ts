import {
  Connectivity,
  FailureClassifier,
  OperationRepository,
  OperationTransport,
} from '@poodlelab/ngrx-offline/core';
import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import { AnyOfflineMutationBinding } from './mutation-actions';

/**
 * Foreground outbox configuration resolved in an Angular injection context.
 *
 * @alpha
 */
export interface OfflineOutboxConfig {
  readonly databaseName: string;
  readonly mutations: readonly AnyOfflineMutationBinding[];
  readonly scope: () => string;
  readonly transport?: OperationTransport;
  readonly repository?: OperationRepository;
  readonly indexedDB?: IDBFactory;
  readonly connectivity?: Connectivity;
  readonly connectivity$?: Observable<boolean>;
  readonly classifyFailure?: FailureClassifier;
  readonly coordinationKey?: string;
  readonly claimDurationMs?: number;
  readonly maximumOperationsPerRun?: number;
  readonly maximumConcurrentLanes?: number;
  readonly claimRenewalIntervalMs?: number;
  /** Policy applied by the `logoutScope` command. Defaults to `preserve`. */
  readonly logoutPolicy?: 'discard' | 'preserve' | 'prompt';
  readonly operationTimeoutMs?: number;
  readonly restoreOnStartup?: boolean;
}

export const OFFLINE_OUTBOX_CONFIG = new InjectionToken<OfflineOutboxConfig>(
  'OFFLINE_OUTBOX_CONFIG',
);

export const OFFLINE_OPERATION_REPOSITORY = new InjectionToken<OperationRepository>(
  'OFFLINE_OPERATION_REPOSITORY',
);
