/// <reference lib="webworker" />

import {
  FetchOperationTransport,
  WorkerClientNotifier,
  WorkerOutboxExecutor,
  composeWorkerRequestEnhancers,
  registerOfflineWorkerHandlers,
} from '@poodlelab/ngrx-offline/worker';
import { OfflineWorkerSyncRequest } from '@poodlelab/ngrx-offline/core';
import { showcaseOperationDefinitions } from './app/operation-definitions';

declare const self: ServiceWorkerGlobalScope;

// Angular must install its cache/update listeners before the outbox extension.
importScripts('./ngsw-worker.js');

interface EphemeralCapability {
  readonly apiBaseUrl: string;
  readonly authorization: string;
}

const capabilities = new Map<string, EphemeralCapability>();
const transport = new FetchOperationTransport({
  enhanceRequest: composeWorkerRequestEnhancers((request, context) => {
    const capability = capabilities.get(context.scope);
    if (capability === undefined) throw new Error('Worker credentials are unavailable.');
    return {
      ...request,
      url: `${capability.apiBaseUrl}${request.url}`,
      headers: {
        ...request.headers,
        Authorization: capability.authorization,
        'Content-Type': 'application/json',
      },
    };
  }),
});
const executor = new WorkerOutboxExecutor({
  databaseName: 'atlas-journal-outbox-v1',
  coordinationKey: 'atlas-journal-outbox-v1-executor',
  definitions: showcaseOperationDefinitions,
  transport,
  canReplay: (scope) => capabilities.has(scope),
  notifier: new WorkerClientNotifier(self.clients),
  maximumConcurrentLanes: 2,
});

registerOfflineWorkerHandlers({
  scope: self,
  executor,
  prepareRequest: (request) => captureCapability(request),
});

function captureCapability(request: OfflineWorkerSyncRequest): void {
  const payload = request.payload;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    typeof payload['apiBaseUrl'] !== 'string' ||
    typeof payload['authorization'] !== 'string'
  ) {
    return;
  }
  capabilities.set(request.scope, {
    apiBaseUrl: payload['apiBaseUrl'].replace(/\/$/, ''),
    authorization: payload['authorization'],
  });
}
