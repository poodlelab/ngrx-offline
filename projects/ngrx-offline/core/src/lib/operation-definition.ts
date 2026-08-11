import { OfflineOperationDefinition, OfflineReference, ResolvedReference } from './contracts';
import { isOfflineRef, offlineRef, resolvedRef } from './offline-reference';

/**
 * Definition input for the general-purpose operation helper.
 *
 * Version 1 and automatic discovery of tagged offline references are the
 * common path. Both can be overridden when a durable contract needs it.
 *
 * @alpha
 */
export type OfflineOperationOptions<Input, Result> = Omit<
  OfflineOperationDefinition<Input, Result>,
  'dependencies' | 'version'
> & {
  readonly version?: number;
  dependencies?(input: Input): readonly OfflineReference[];
};

type ConventionalClientId<Input> = Input extends { readonly clientId: string }
  ? { readonly clientId?: (input: Input) => string }
  : { readonly clientId: (input: Input) => string };

type ConventionalServerId<Result> = Result extends {
  readonly id: number | string;
}
  ? { readonly serverId?: (result: Result) => number | string }
  : { readonly serverId: (result: Result) => number | string };

/**
 * Concise definition for the common create-and-map operation.
 *
 * `entity`, the input client ID, and the successful result ID are enough to
 * derive the producer declaration and durable client-to-server mapping.
 * Conventional `clientId` and `id` properties need no selectors.
 *
 * @alpha
 */
export type OfflineCreateOptions<Input, Result> = Omit<
  OfflineOperationOptions<Input, Result>,
  'produces' | 'producesKeys'
> &
  ConventionalClientId<Input> &
  ConventionalServerId<Result> & {
    readonly entity: string;
  };

/**
 * Preserves the input and result types of a worker-safe operation definition.
 *
 * @alpha
 */
export function defineOfflineOperation<Input, Result>(
  definition: OfflineOperationOptions<Input, Result>,
): OfflineOperationDefinition<Input, Result> {
  return {
    ...definition,
    version: definition.version ?? 1,
    dependencies: definition.dependencies ?? collectOfflineReferences,
  };
}

/**
 * Defines an entity-creation operation without repeating relationship metadata.
 *
 * @alpha
 */
export function defineOfflineCreate<Input, Result>(
  options: OfflineCreateOptions<Input, Result>,
): OfflineOperationDefinition<Input, Result> {
  const selectClientId = options.clientId ?? ((input: Input) => conventionalClientId(input));
  const selectServerId = options.serverId ?? ((result: Result) => conventionalServerId(result));
  const referenceFor = (input: Input): OfflineReference =>
    offlineRef(options.entity, selectClientId(input));

  return defineOfflineOperation({
    kind: options.kind,
    request: options.request,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.lane === undefined ? {} : { lane: options.lane }),
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
    ...(options.parseResult === undefined ? {} : { parseResult: options.parseResult }),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
    ...(options.migrations === undefined ? {} : { migrations: options.migrations }),
    producesKeys: (input) => [referenceFor(input).key],
    produces: ({ input, result }): readonly ResolvedReference[] => [
      resolvedRef(referenceFor(input), selectServerId(result)),
    ],
  });
}

/**
 * Finds unique tagged offline references in JSON-compatible input.
 *
 * @alpha
 */
export function collectOfflineReferences(value: unknown): readonly OfflineReference[] {
  const references = new Map<string, OfflineReference>();
  const visited = new WeakSet<object>();

  const visit = (candidate: unknown): void => {
    if (isOfflineRef(candidate)) {
      references.set(candidate.key, candidate);
      return;
    }
    if (typeof candidate !== 'object' || candidate === null || visited.has(candidate)) {
      return;
    }
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const item of Object.values(candidate)) visit(item);
  };

  visit(value);
  return [...references.values()];
}

function conventionalClientId(input: unknown): string {
  if (
    typeof input === 'object' &&
    input !== null &&
    'clientId' in input &&
    typeof input.clientId === 'string'
  ) {
    return input.clientId;
  }
  throw new TypeError('defineOfflineCreate requires a string clientId or a clientId selector.');
}

function conventionalServerId(result: unknown): number | string {
  if (
    typeof result === 'object' &&
    result !== null &&
    'id' in result &&
    (typeof result.id === 'number' || typeof result.id === 'string')
  ) {
    return result.id;
  }
  throw new TypeError('defineOfflineCreate requires an id result or a serverId selector.');
}
