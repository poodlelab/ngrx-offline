import { Injectable, inject } from '@angular/core';
import {
  OfflineTransportError,
  type HttpRequestDescriptor,
  type OperationTransport,
  type TransportContext,
  type TransportResponse,
} from '@poodlelab/ngrx-offline/core';
import { DemoWorkspaceService } from './demo-workspace.service';
import { ShowcaseConnectivity } from './showcase-connectivity';

@Injectable()
export class ShowcaseTransport implements OperationTransport {
  private readonly workspace = inject(DemoWorkspaceService);
  private readonly connectivity = inject(ShowcaseConnectivity);
  private readonly armedOperations = new Set<string>();

  async execute(
    descriptor: HttpRequestDescriptor,
    context: TransportContext,
  ): Promise<TransportResponse> {
    if (!this.connectivity.isOnline()) {
      throw new OfflineTransportError('network', 'This journal is offline.');
    }
    await this.workspace.ensureRegistered();
    const failure = this.armedOperations.has(context.operationId)
      ? null
      : this.workspace.consumeNextFailure();
    if (failure !== null) {
      this.armedOperations.add(context.operationId);
      await this.workspace.armRemoteFailure(context.idempotencyKey, failure);
    }
    let response: Response;
    try {
      response = await fetch(`${this.workspace.apiBaseUrl}${descriptor.url}`, {
        method: descriptor.method,
        headers: {
          ...descriptor.headers,
          Authorization: this.workspace.authorization(),
          'Content-Type': 'application/json',
          'Idempotency-Key': context.idempotencyKey,
        },
        ...(descriptor.body === undefined ? {} : { body: JSON.stringify(descriptor.body) }),
      });
    } catch {
      throw new OfflineTransportError('network', 'The reference API could not be reached.');
    }
    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('json') ? await response.json() : await response.text();
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      ...(descriptor.responseType === 'none' ? {} : { body }),
    };
  }
}
