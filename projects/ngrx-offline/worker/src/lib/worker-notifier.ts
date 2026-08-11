import { OfflineWorkerSyncEvent } from '@poodlelab/ngrx-offline/core';

/** Minimal service-worker client used to keep public declarations portable. @alpha */
export interface WorkerClientLike {
  postMessage(message: unknown): void;
}

/** Minimal service-worker clients collection used by the notifier. @alpha */
export interface WorkerClientsLike {
  matchAll(options: {
    readonly includeUncontrolled: boolean;
    readonly type: 'window';
  }): Promise<readonly WorkerClientLike[]>;
}

/** Delivers replay outcomes to every open client and an optional BroadcastChannel. @alpha */
export class WorkerClientNotifier {
  constructor(
    private readonly clients: WorkerClientsLike,
    private readonly channelName = 'ngrx-offline',
  ) {}

  async notify(event: OfflineWorkerSyncEvent): Promise<void> {
    const clients = await this.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage(event);
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(this.channelName);
      try {
        channel.postMessage(event);
      } finally {
        channel.close();
      }
    }
  }
}
