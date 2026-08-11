// The Angular test builder discovers entry files from the primary source root.
// A used export keeps the framework-independent suite in the optimized test bundle.
import { replayEngineSuiteRegistered } from '../testing/src/lib/replay-engine.spec';
import { indexedDbRepositorySuiteRegistered } from '../indexeddb/src/lib/indexeddb-operation-repository.spec';
import { defineOfflineCreate, defineOfflineOperation, offlineRef } from './public-api';
import { describe, expect, it } from 'vitest';

it('registers the secondary-entry-point suites', () => {
  expect(replayEngineSuiteRegistered).toBe(true);
  expect(indexedDbRepositorySuiteRegistered).toBe(true);
});

describe('concise operation definitions', () => {
  it('defaults to version one and discovers nested offline references', () => {
    const trip = offlineRef('trip', 'trip-local');
    const definition = defineOfflineOperation<
      {
        readonly parent: typeof trip;
        readonly nested: { readonly sameParent: typeof trip };
      },
      { readonly ok: true }
    >({
      kind: 'journal.day.create',
      request: () => ({ method: 'POST', url: '/days' }),
    });

    expect(definition.version).toBe(1);
    expect(definition.dependencies?.({ parent: trip, nested: { sameParent: trip } })).toEqual([
      trip,
    ]);
  });

  it('derives both phases of a conventional client-to-server ID mapping', () => {
    const definition = defineOfflineCreate<
      { readonly clientId: string; readonly trip: ReturnType<typeof offlineRef> },
      { readonly id: number }
    >({
      kind: 'journal.day.create',
      entity: 'travel-day',
      request: () => ({ method: 'POST', url: '/days' }),
    });
    const input = { clientId: 'day-local', trip: offlineRef('trip', 'trip-local') };

    expect(definition.dependencies?.(input)).toEqual([input.trip]);
    expect(definition.producesKeys?.(input)).toEqual(['travel-day:day-local']);
    expect(definition.produces?.({ input, result: { id: 8421 } })).toEqual([
      { key: 'travel-day:day-local', value: 8421 },
    ]);
  });

  it('supports custom ID shapes and explicit advanced overrides', () => {
    const dependency = offlineRef('trip', 'custom-parent');
    const definition = defineOfflineCreate<
      { readonly localKey: string },
      { readonly serverKey: string }
    >({
      kind: 'journal.custom.create',
      entity: 'custom',
      version: 3,
      clientId: (input) => input.localKey,
      serverId: (result) => result.serverKey,
      dependencies: () => [dependency],
      request: () => ({ method: 'POST', url: '/custom' }),
    });
    const input = { localKey: 'local-1' };

    expect(definition.version).toBe(3);
    expect(definition.dependencies?.(input)).toEqual([dependency]);
    expect(definition.producesKeys?.(input)).toEqual(['custom:local-1']);
    expect(definition.produces?.({ input, result: { serverKey: 'server-1' } })).toEqual([
      { key: 'custom:local-1', value: 'server-1' },
    ]);
  });
});
