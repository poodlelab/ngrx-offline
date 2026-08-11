/**
 * Stable error categories surfaced by the IndexedDB adapter.
 *
 * @alpha
 */
export type IndexedDbErrorCode =
  | 'migration_failed'
  | 'quota_exceeded'
  | 'serialization_failed'
  | 'transaction_failed'
  | 'unavailable';

/**
 * Sanitized persistence error suitable for enqueue failure actions.
 *
 * @alpha
 */
export class IndexedDbRepositoryError extends Error {
  constructor(
    readonly code: IndexedDbErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'IndexedDbRepositoryError';
  }
}

/**
 * Converts browser-specific IndexedDB failures into stable adapter errors.
 *
 * @alpha
 */
export function normalizeIndexedDbError(error: unknown, action: string): IndexedDbRepositoryError {
  if (error instanceof IndexedDbRepositoryError) {
    return error;
  }
  const name =
    typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : undefined;
  if (name === 'QuotaExceededError') {
    return new IndexedDbRepositoryError(
      'quota_exceeded',
      `IndexedDB quota was exceeded while ${action}.`,
      { cause: error },
    );
  }
  if (name === 'DataCloneError') {
    return new IndexedDbRepositoryError(
      'serialization_failed',
      `IndexedDB could not clone durable data while ${action}.`,
      { cause: error },
    );
  }
  return new IndexedDbRepositoryError(
    'transaction_failed',
    `IndexedDB transaction failed while ${action}.`,
    { cause: error },
  );
}
