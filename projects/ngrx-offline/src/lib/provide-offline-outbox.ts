import {
  DestroyRef,
  EnvironmentProviders,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
} from '@angular/core';
import { provideEffects } from '@ngrx/effects';
import { provideState } from '@ngrx/store';
import { AngularHttpTransport } from './angular-http-transport';
import {
  BrowserClock,
  BrowserConnectivity,
  BrowserRandomSource,
  BrowserScheduler,
  BrowserUuidGenerator,
} from './browser-adapters';
import { offlineOutboxEffects } from './outbox-effects';
import {
  OFFLINE_OPERATION_REPOSITORY,
  OFFLINE_OUTBOX_CONFIG,
  OfflineOutboxConfig,
} from './outbox-config';
import { offlineOutboxFeature } from './outbox-state';
import {
  OFFLINE_REPLAY_ENGINE,
  NgRxEngineEventSink,
  OfflineOutboxRuntime,
  OutboxConnectivity,
  createReplayEngine,
  createRepository,
} from './outbox-runtime';

/**
 * Registers the foreground durable outbox, its feature state, and functional effects.
 *
 * @alpha
 */
export function provideOfflineOutbox(
  configFactory: () => OfflineOutboxConfig,
): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: OFFLINE_OUTBOX_CONFIG, useFactory: configFactory },
    BrowserClock,
    BrowserUuidGenerator,
    BrowserRandomSource,
    BrowserScheduler,
    BrowserConnectivity,
    AngularHttpTransport,
    OutboxConnectivity,
    NgRxEngineEventSink,
    OfflineOutboxRuntime,
    {
      provide: OFFLINE_OPERATION_REPOSITORY,
      useFactory: () => createRepository(inject(OFFLINE_OUTBOX_CONFIG), inject(DestroyRef)),
    },
    { provide: OFFLINE_REPLAY_ENGINE, useFactory: createReplayEngine },
    provideState(offlineOutboxFeature),
    provideEffects(offlineOutboxEffects),
    provideAppInitializer(() => inject(OfflineOutboxRuntime).initialize()),
  ]);
}
