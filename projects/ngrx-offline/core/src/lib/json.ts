import { JsonValue } from './contracts';
import { OfflineInputError } from './errors';

/**
 * Validates and clones an unknown value into the durable JSON value model.
 *
 * @alpha
 */
export function cloneJsonValue(value: unknown, path = '$'): JsonValue {
  return cloneValue(value, path, new WeakSet<object>());
}

/**
 * Throws when a value cannot be stored safely as JSON.
 *
 * @alpha
 */
export function assertJsonValue(value: unknown, path = '$'): asserts value is JsonValue {
  cloneJsonValue(value, path);
}

function cloneValue(value: unknown, path: string, ancestors: WeakSet<object>): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      invalid(path, 'Numbers must be finite.');
    }
    return value;
  }

  if (typeof value !== 'object') {
    invalid(path, `Values of type ${typeof value} are not JSON compatible.`);
  }

  if (ancestors.has(value)) {
    invalid(path, 'Circular references are not JSON compatible.');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          invalid(`${path}[${index}]`, 'Sparse arrays are not JSON compatible.');
        }
        result.push(cloneValue(value[index], `${path}[${index}]`, ancestors));
      }
      return result;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid(path, 'Only plain objects can be stored as JSON.');
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      invalid(path, 'Symbol-keyed properties are not JSON compatible.');
    }

    const source = value as Record<string, unknown>;
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      result[key] = cloneValue(source[key], propertyPath(path, key), ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function invalid(path: string, reason: string): never {
  throw new OfflineInputError('invalid_json_value', path, `${reason} Invalid value at ${path}.`);
}
