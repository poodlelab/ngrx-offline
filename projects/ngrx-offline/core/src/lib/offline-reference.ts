import { OfflineReference, ResolvedReference } from './contracts';
import { OfflineConfigurationError } from './errors';

const REFERENCE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Creates an explicit, JSON-compatible client-to-server relationship reference. @alpha */
export function offlineRef(entity: string, clientId: string): OfflineReference {
  if (!REFERENCE_PART.test(entity) || !REFERENCE_PART.test(clientId)) {
    throw new OfflineConfigurationError(
      'invalid_offline_reference',
      'Offline reference entity and client ID must be non-empty URL-safe identifiers.',
    );
  }
  return { type: 'offline-reference', key: `${entity}:${clientId}` };
}

/** Narrows a value to an explicit unresolved offline reference. @alpha */
export function isOfflineRef(value: unknown): value is OfflineReference {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'offline-reference' &&
    'key' in value &&
    typeof value.key === 'string' &&
    value.key.trim() !== ''
  );
}

/** Creates a validated mapping emitted by a successful parent operation. @alpha */
export function resolvedRef(
  reference: OfflineReference,
  value: number | string,
): ResolvedReference {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'number' && !Number.isFinite(value))
  ) {
    throw new OfflineConfigurationError(
      'invalid_reference_value',
      `Resolved reference "${reference.key}" must be a finite number or string.`,
    );
  }
  return { key: reference.key, value };
}
