import { AnyOfflineOperationDefinition, OfflineOperationDefinition } from './contracts';
import { OfflineConfigurationError } from './errors';

const KIND_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/**
 * Immutable registry that rejects ambiguous durable operation identities.
 *
 * @alpha
 */
export class OperationRegistry {
  private readonly definitions = new Map<string, AnyOfflineOperationDefinition>();

  constructor(definitions: readonly AnyOfflineOperationDefinition[]) {
    for (const definition of definitions) {
      validateDefinitionIdentity(definition.kind, definition.version);
      validateMigrations(definition);
      if (this.definitions.has(definition.kind)) {
        throw new OfflineConfigurationError(
          'duplicate_operation_kind',
          `Operation kind "${definition.kind}" is registered more than once.`,
        );
      }
      this.definitions.set(definition.kind, definition);
    }
  }

  /**
   * Finds the current definition for a durable kind.
   *
   * @alpha
   */
  get(kind: string): AnyOfflineOperationDefinition | undefined {
    return this.definitions.get(kind);
  }

  /**
   * Asserts that an enqueue definition is the registered current version.
   *
   * @alpha
   */
  assertRegistered<Input, Result>(definition: OfflineOperationDefinition<Input, Result>): void {
    const registered = this.get(definition.kind);
    if (registered === undefined) {
      throw new OfflineConfigurationError(
        'unknown_operation_kind',
        `Operation kind "${definition.kind}" is not registered.`,
      );
    }
    if (registered.version !== definition.version) {
      throw new OfflineConfigurationError(
        'operation_version_mismatch',
        `Operation kind "${definition.kind}" is registered at version ${registered.version}, not ${definition.version}.`,
      );
    }
  }
}

function validateMigrations(definition: AnyOfflineOperationDefinition): void {
  const fromVersions = new Set<number>();
  for (const migration of definition.migrations ?? []) {
    if (
      !Number.isSafeInteger(migration.fromVersion) ||
      !Number.isSafeInteger(migration.toVersion) ||
      migration.fromVersion < 1 ||
      migration.toVersion <= migration.fromVersion ||
      migration.toVersion > definition.version
    ) {
      throw new OfflineConfigurationError(
        'invalid_operation_migration',
        `Operation kind "${definition.kind}" has an invalid ${migration.fromVersion} -> ${migration.toVersion} migration.`,
      );
    }
    if (fromVersions.has(migration.fromVersion)) {
      throw new OfflineConfigurationError(
        'ambiguous_operation_migration',
        `Operation kind "${definition.kind}" has more than one migration from version ${migration.fromVersion}.`,
      );
    }
    fromVersions.add(migration.fromVersion);
  }
}

/**
 * Creates an operation registry while retaining inference at call sites.
 *
 * @alpha
 */
export function createOperationRegistry(
  ...definitions: readonly AnyOfflineOperationDefinition[]
): OperationRegistry {
  return new OperationRegistry(definitions);
}

function validateDefinitionIdentity(kind: string, version: number): void {
  if (!KIND_PATTERN.test(kind)) {
    throw new OfflineConfigurationError(
      'invalid_operation_kind',
      `Operation kind "${kind}" must be lowercase and namespaceable with dots or hyphens.`,
    );
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new OfflineConfigurationError(
      'invalid_operation_version',
      `Operation kind "${kind}" must use a positive safe-integer version.`,
    );
  }
}
