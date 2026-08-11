import { isDevMode, inject } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideServiceWorker } from '@angular/service-worker';
import { provideStore } from '@ngrx/store';
import { provideOfflineOutbox, provideOfflineWorkerBridge } from '@poodlelab/ngrx-offline';
import { AppComponent } from './app/app.component';
import { DemoWorkspaceService } from './app/demo-workspace.service';
import { showcaseMutations } from './app/offline-definitions';
import { ShowcaseConnectivity } from './app/showcase-connectivity';
import { showcaseFeature } from './app/showcase.store';
import { ShowcaseTransport } from './app/showcase.transport';

bootstrapApplication(AppComponent, {
  providers: [
    provideStore({ [showcaseFeature.name]: showcaseFeature.reducer }),
    DemoWorkspaceService,
    ShowcaseConnectivity,
    ShowcaseTransport,
    provideOfflineOutbox(() => {
      const workspace = inject(DemoWorkspaceService);
      const connectivity = inject(ShowcaseConnectivity);
      return {
        databaseName: 'atlas-journal-outbox-v1',
        coordinationKey: 'atlas-journal-outbox-v1-executor',
        scope: () => workspace.workspaceId,
        mutations: showcaseMutations,
        transport: inject(ShowcaseTransport),
        connectivity,
        connectivity$: connectivity.changes,
        logoutPolicy: 'discard',
        maximumConcurrentLanes: 2,
        operationTimeoutMs: 3000,
      };
    }),
    provideOfflineWorkerBridge(() => {
      const workspace = inject(DemoWorkspaceService);
      return { payload: () => workspace.workerPayload() };
    }),
    provideServiceWorker('offline-service-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
      updateViaCache: 'none',
    }),
  ],
}).catch((error: unknown) => console.error(error));
