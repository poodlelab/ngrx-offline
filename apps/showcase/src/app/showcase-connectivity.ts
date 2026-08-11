import { Injectable, signal } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import type { Connectivity } from '@poodlelab/ngrx-offline/core';

@Injectable()
export class ShowcaseConnectivity implements Connectivity {
  private readonly onlineSubject = new BehaviorSubject<boolean>(true);
  private browserOnline = globalThis.navigator?.onLine ?? true;

  readonly simulatedOffline = signal(false);
  readonly changes = this.onlineSubject.asObservable();

  constructor() {
    this.publish();
    globalThis.addEventListener?.('online', () => {
      this.browserOnline = true;
      this.publish();
    });
    globalThis.addEventListener?.('offline', () => {
      this.browserOnline = false;
      this.publish();
    });
  }

  isOnline(): boolean {
    return this.browserOnline && !this.simulatedOffline();
  }

  setSimulatedOffline(offline: boolean): void {
    this.simulatedOffline.set(offline);
    this.publish();
  }

  private publish(): void {
    this.onlineSubject.next(this.isOnline());
  }
}
