import { JsonValue, ReplayResult } from './contracts';

/** Message sent by a page to request replay from its controlling service worker. @alpha */
export interface OfflineWorkerSyncRequest {
  readonly type: 'ngrx-offline:sync';
  readonly scope: string;
  /** Opaque, structured-cloneable data interpreted only by application worker code. */
  readonly payload?: JsonValue;
}

/** Durable replay result announced by the worker to open application clients. @alpha */
export type OfflineWorkerSyncEvent =
  | {
      readonly type: 'ngrx-offline:sync-event';
      readonly scope: string;
      readonly status: 'completed';
      readonly replay: ReplayResult;
    }
  | {
      readonly type: 'ngrx-offline:sync-event';
      readonly scope: string;
      readonly status: 'deferred';
      readonly reason: 'credentials-unavailable';
    }
  | {
      readonly type: 'ngrx-offline:sync-event';
      readonly scope: string;
      readonly status: 'failed';
    };

/** Background Sync tag prefix understood by the worker integration. @alpha */
export const OFFLINE_WORKER_SYNC_TAG_PREFIX = 'ngrx-offline:';

/** Builds a scope-safe Background Sync tag. @alpha */
export function offlineWorkerSyncTag(scope: string): string {
  return `${OFFLINE_WORKER_SYNC_TAG_PREFIX}${encodeURIComponent(scope)}`;
}

/** Parses a Background Sync tag created by {@link offlineWorkerSyncTag}. @alpha */
export function scopeFromOfflineWorkerSyncTag(tag: string): string | undefined {
  if (!tag.startsWith(OFFLINE_WORKER_SYNC_TAG_PREFIX)) return undefined;
  try {
    const scope = decodeURIComponent(tag.slice(OFFLINE_WORKER_SYNC_TAG_PREFIX.length));
    return scope.trim() === '' ? undefined : scope;
  } catch {
    return undefined;
  }
}

/** Narrow an unknown service-worker message to a replay request. @alpha */
export function isOfflineWorkerSyncRequest(value: unknown): value is OfflineWorkerSyncRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'ngrx-offline:sync' &&
    'scope' in value &&
    typeof value.scope === 'string' &&
    value.scope.trim() !== ''
  );
}

/** Narrow an unknown client message to a worker replay event. @alpha */
export function isOfflineWorkerSyncEvent(value: unknown): value is OfflineWorkerSyncEvent {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    value.type !== 'ngrx-offline:sync-event' ||
    !('scope' in value) ||
    typeof value.scope !== 'string' ||
    !('status' in value)
  ) {
    return false;
  }
  return value.status === 'completed' || value.status === 'deferred' || value.status === 'failed';
}
