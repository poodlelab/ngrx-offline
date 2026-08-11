import {
  DestroyRef,
  EnvironmentProviders,
  Injectable,
  InjectionToken,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
} from '@angular/core';
import {
  JsonValue,
  OfflineWorkerSyncRequest,
  isOfflineWorkerSyncEvent,
  offlineWorkerSyncTag,
} from '@poodlelab/ngrx-offline/core';
import { OfflineOutboxRuntime } from './outbox-runtime';

/** Optional page-to-service-worker bridge settings. @alpha */
export interface OfflineWorkerBridgeConfig {
  /** Builds ephemeral, structured-cloneable worker data immediately before sync. */
  readonly payload?: (scope: string) => JsonValue | Promise<JsonValue | undefined> | undefined;
  readonly channelName?: string;
  readonly registerBackgroundSync?: boolean;
}

/** Result of requesting replay through the optional worker bridge. @alpha */
export type OfflineWorkerRequestResult = 'foreground' | 'worker';

const OFFLINE_WORKER_BRIDGE_CONFIG = new InjectionToken<OfflineWorkerBridgeConfig>(
  'OFFLINE_WORKER_BRIDGE_CONFIG',
);

interface SyncManagerLike {
  register(tag: string): Promise<void>;
}

interface RegistrationWithSync extends ServiceWorkerRegistration {
  readonly sync?: SyncManagerLike;
}

/**
 * Requests worker replay when a service worker is active and restores durable
 * receipts into NgRx when the worker announces completion.
 *
 * @alpha
 */
@Injectable()
export class OfflineWorkerBridge {
  private readonly config = inject(OFFLINE_WORKER_BRIDGE_CONFIG);
  private readonly runtime = inject(OfflineOutboxRuntime);
  private readonly destroyRef = inject(DestroyRef);
  private readonly pendingRestore = new Set<string>();
  private channel: BroadcastChannel | undefined;

  initialize(): void {
    if (!hasServiceWorker()) return;
    const onMessage = (event: MessageEvent<unknown>) => this.consume(event.data);
    navigator.serviceWorker.addEventListener('message', onMessage);
    this.destroyRef.onDestroy(() =>
      navigator.serviceWorker.removeEventListener('message', onMessage),
    );
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(this.config.channelName ?? 'ngrx-offline');
      this.channel.addEventListener('message', onMessage);
      this.destroyRef.onDestroy(() => this.channel?.close());
    }
  }

  async requestSync(): Promise<OfflineWorkerRequestResult> {
    const scope = this.runtime.currentScope();
    if (!hasServiceWorker()) return this.foreground(scope);
    const registration = (await navigator.serviceWorker.getRegistration()) as
      RegistrationWithSync | undefined;
    const target =
      registration?.active ??
      navigator.serviceWorker.controller ??
      registration?.waiting ??
      registration?.installing;
    if (registration === undefined || target === null || target === undefined) {
      return this.foreground(scope);
    }
    let payload: JsonValue | undefined;
    try {
      payload = await this.config.payload?.(scope);
    } catch {
      return this.foreground(scope);
    }
    const request: OfflineWorkerSyncRequest = {
      type: 'ngrx-offline:sync',
      scope,
      ...(payload === undefined ? {} : { payload }),
    };
    target.postMessage(request);
    if (this.config.registerBackgroundSync !== false && registration.sync !== undefined) {
      try {
        await registration.sync.register(offlineWorkerSyncTag(scope));
      } catch {
        // Explicit postMessage replay remains the portable path.
      }
    }
    return 'worker';
  }

  private consume(value: unknown): void {
    if (!isOfflineWorkerSyncEvent(value) || value.scope !== this.runtime.currentScope()) return;
    if (value.status === 'completed') {
      this.restoreOnce(value.scope);
    } else if (value.status === 'deferred') {
      void this.runtime.sync(value.scope);
    }
  }

  private restoreOnce(scope: string): void {
    if (this.pendingRestore.has(scope)) return;
    this.pendingRestore.add(scope);
    queueMicrotask(() => {
      void this.runtime.restore(scope, false).finally(() => this.pendingRestore.delete(scope));
    });
  }

  private async foreground(scope: string): Promise<'foreground'> {
    await this.runtime.sync(scope);
    return 'foreground';
  }
}

/** Registers the optional, tree-shakable Angular worker bridge. @alpha */
export function provideOfflineWorkerBridge(
  configFactory: () => OfflineWorkerBridgeConfig = () => ({}),
): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: OFFLINE_WORKER_BRIDGE_CONFIG, useFactory: configFactory },
    OfflineWorkerBridge,
    provideAppInitializer(() => inject(OfflineWorkerBridge).initialize()),
  ]);
}

function hasServiceWorker(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}
