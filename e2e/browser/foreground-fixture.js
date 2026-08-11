import {
  OfflineTransportError,
  ReplayEngine,
  createOperationRegistry,
  defineOfflineOperation,
  offlineRef,
  resolvedRef,
} from '@poodlelab/ngrx-offline/core';
import {
  BrowserCoordinationLock,
  IndexedDbOperationRepository,
} from '@poodlelab/ngrx-offline/indexeddb';

const parameters = new URL(location.href).searchParams;
const databaseName = 'ngrx-offline-phase3-browser';
if (parameters.has('reset')) {
  await deleteDatabase(databaseName);
  history.replaceState({}, '', location.pathname);
}

const repository = new IndexedDbOperationRepository({ databaseName });
const state = {
  optimistic: false,
  online: false,
  events: [],
  transportCalls: [],
  responseStatuses: [],
  transportMode: 'normal',
  serverMutations: 0,
  serverReceipts: new Map(),
};
let releaseTransport = () => undefined;
let transportGate = Promise.resolve();
let activeReplay = Promise.resolve();
const operation = defineOfflineOperation({
  kind: 'browser.trip-create',
  version: 1,
  request: (input) => ({ method: 'POST', url: '/trips', body: input }),
  parseResult: (response) => response.body,
});
const relationDefinition = (kind, entity, url, parentField) =>
  defineOfflineOperation({
    kind,
    version: 1,
    dependencies: (input) => (input.parent ? [input.parent] : []),
    producesKeys: (input) => [offlineRef(entity, input.clientId).key],
    request: (input, context) => ({
      method: 'POST',
      url,
      body: {
        clientId: input.clientId,
        ...(input.parent ? { [parentField]: context.resolve(input.parent) } : {}),
      },
    }),
    parseResult: (response) => response.body,
    produces: ({ input, result }) => [resolvedRef(offlineRef(entity, input.clientId), result.id)],
  });
const trip = relationDefinition('browser.rel-trip', 'trip', '/rel/trips');
const travelDay = relationDefinition(
  'browser.rel-travel-day',
  'travel-day',
  '/rel/travel-days',
  'tripId',
);
const placeVisit = relationDefinition(
  'browser.rel-place-visit',
  'place-visit',
  '/rel/place-visits',
  'travelDayId',
);
const memory = relationDefinition('browser.rel-memory', 'memory', '/rel/memory', 'placeVisitId');
const migrated = defineOfflineOperation({
  kind: 'browser.migrated-create',
  version: parameters.has('legacy') ? 1 : 2,
  ...(parameters.has('legacy')
    ? {}
    : {
        migrations: [
          {
            fromVersion: 1,
            toVersion: 2,
            migrate: (input) => ({ label: input.name, upgraded: true }),
          },
        ],
      }),
  request: (input) => ({ method: 'POST', url: '/migrated', body: input }),
  parseResult: (response) => response.body,
});
const clock = { now: () => Date.now() };
const uuid = { generate: () => crypto.randomUUID() };
const scheduler = {
  schedule: (at, task) => {
    const timer = setTimeout(() => void task(), Math.max(0, at - Date.now()));
    return { cancel: () => clearTimeout(timer) };
  },
};
const engine = new ReplayEngine(
  createOperationRegistry(operation, trip, travelDay, placeVisit, memory, migrated),
  {
    repository,
    transport: {
      execute: async (request, context) => {
        state.transportCalls.push({
          url: request.url,
          body: request.body,
          headers: request.headers,
          context,
        });
        await transportGate;
        const replayed = state.serverReceipts.get(context.idempotencyKey);
        if (replayed !== undefined) return replayed;
        const configuredStatus = state.responseStatuses.shift();
        if (configuredStatus !== undefined) {
          return { status: configuredStatus, headers: {}, body: { code: 'configured_failure' } };
        }
        const ids = {
          '/rel/trips': 101,
          '/rel/travel-days': 202,
          '/rel/place-visits': 303,
          '/rel/memory': 404,
        };
        const response = {
          status: 201,
          headers: {},
          body: {
            id: ids[request.url] ?? 42,
            ...(request.body.clientId === undefined ? {} : { clientId: request.body.clientId }),
            ...(request.body.name === undefined ? {} : { name: request.body.name }),
          },
        };
        state.serverMutations += 1;
        state.serverReceipts.set(context.idempotencyKey, response);
        if (state.transportMode === 'commit_then_disconnect') {
          state.transportMode = 'normal';
          throw new OfflineTransportError('network', 'The response was lost after commit.');
        }
        return response;
      },
    },
    lock: new BrowserCoordinationLock({
      repository,
      clock,
      uuid,
      scheduler,
      ...(parameters.has('noLocks') ? { webLocks: null } : {}),
    }),
    clock,
    uuid,
    random: { next: () => 0 },
    connectivity: { isOnline: () => state.online },
    scheduler,
    events: { emit: (event) => state.events.push(event) },
  },
  {
    coordinationKey: 'phase3-browser',
    claimDurationMs: 300,
    claimRenewalIntervalMs: 100,
    maximumOperationsPerRun: 2000,
  },
);

window.phase3Fixture = {
  queue: async (scope = 'browser-pool') => {
    const queued = await engine.enqueue(
      operation,
      { clientId: 'local-browser-1', name: 'Ada Browser Services' },
      { scope },
    );
    state.optimistic = true;
    return queued.id;
  },
  restore: async () => {
    state.optimistic = (await repository.listOperations('browser-pool')).length > 0;
  },
  reconnectAndSync: async (scope = 'browser-pool') => {
    state.online = true;
    return engine.replay(scope);
  },
  queueRelations: async (scope = 'browser-pool') => {
    const tripRef = offlineRef('trip', 'trip-local');
    const travelDayRef = offlineRef('travel-day', 'travel-day-local');
    const placeVisitRef = offlineRef('place-visit', 'place-local');
    await engine.enqueue(trip, { clientId: 'trip-local' }, { scope });
    await engine.enqueue(travelDay, { clientId: 'travel-day-local', parent: tripRef }, { scope });
    await engine.enqueue(placeVisit, { clientId: 'place-local', parent: travelDayRef }, { scope });
    await engine.enqueue(memory, { clientId: 'memory-local', parent: placeVisitRef }, { scope });
  },
  queueMigrated: async () =>
    engine.enqueue(
      migrated,
      parameters.has('legacy') ? { name: 'Legacy inspection' } : { label: 'Current inspection' },
      { scope: 'browser-pool' },
    ),
  setResponseStatusOnce: (status) => state.responseStatuses.push(status),
  loseNextResponseAfterCommit: () => (state.transportMode = 'commit_then_disconnect'),
  retryNow: async (operationId, scope = 'browser-pool') => {
    await repository.retryNow(operationId, Date.now());
    state.online = true;
    return engine.replay(scope);
  },
  cancel: (operationId) => engine.cancel(operationId),
  pauseForAuthentication: (scope = 'browser-pool') =>
    repository.pauseScope({ scope, code: 'credentials_unavailable', pausedAt: Date.now() }),
  restoreAuthentication: async (scope = 'browser-pool') => {
    await engine.resumeScope(scope);
    state.online = true;
    return engine.replay(scope);
  },
  setOnline: (online) => (state.online = online),
  holdTransport: () => {
    transportGate = new Promise((resolve) => (releaseTransport = resolve));
  },
  releaseTransport: () => {
    releaseTransport();
    transportGate = Promise.resolve();
  },
  startSync: (scope = 'browser-pool') => {
    activeReplay = engine.replay(scope);
  },
  awaitSync: () => activeReplay,
  snapshot: async (scope = 'browser-pool') => ({
    optimistic: state.optimistic,
    operations: await repository.listOperations(scope),
    allOperations: await repository.listOperations(),
    receipts: await repository.listReceipts(scope),
    events: state.events,
    transportCalls: state.transportCalls,
    references: await repository.listReferences(scope),
    serverMutations: state.serverMutations,
    scopeCounts: await repository.countOperationsByScope(),
  }),
};
window.phase3Ready = true;
addEventListener('pagehide', () => void repository.close());

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Database deletion was blocked.'));
  });
}
