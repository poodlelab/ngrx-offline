import {
  HttpRequestDescriptor,
  OfflineTransportError,
  OperationTransport,
  TransportContext,
  TransportResponse,
} from '@poodlelab/ngrx-offline/core';
import {
  HttpClient,
  HttpContext,
  HttpContextToken,
  HttpErrorResponse,
  HttpEvent,
  HttpHeaders,
  HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  Observable,
  TimeoutError,
  catchError,
  filter,
  firstValueFrom,
  of,
  take,
  throwError,
  timeout,
} from 'rxjs';

/** Scope captured by the durable operation, for credential-selecting interceptors. @alpha */
export const OFFLINE_HTTP_SCOPE = new HttpContextToken<string | null>(() => null);
/** Durable operation ID available to interceptors and diagnostics. @alpha */
export const OFFLINE_HTTP_OPERATION_ID = new HttpContextToken<string | null>(() => null);

/**
 * Foreground transport using the application's configured HttpClient and interceptors.
 *
 * @alpha
 */
@Injectable()
export class AngularHttpTransport implements OperationTransport {
  private readonly http = inject(HttpClient);

  async execute(
    descriptor: HttpRequestDescriptor,
    context: TransportContext,
  ): Promise<TransportResponse> {
    const request = new HttpRequest(descriptor.method, descriptor.url, descriptor.body ?? null, {
      headers: new HttpHeaders(descriptor.headers),
      responseType: angularResponseType(descriptor.responseType),
      withCredentials: descriptor.credentials === 'include',
      context: new HttpContext()
        .set(OFFLINE_HTTP_SCOPE, context.scope)
        .set(OFFLINE_HTTP_OPERATION_ID, context.operationId),
    });
    let responses: Observable<HttpResponse<unknown>> = this.http.request(request).pipe(
      filter(
        (event: HttpEvent<unknown>): event is HttpResponse<unknown> =>
          event instanceof HttpResponse,
      ),
      take(1),
    );
    if (descriptor.timeoutMs !== undefined) {
      responses = responses.pipe(timeout(descriptor.timeoutMs));
    }
    const response = await firstValueFrom(
      responses.pipe(
        catchError((error: unknown) => {
          if (error instanceof HttpErrorResponse && error.status > 0) {
            return of(
              new HttpResponse({
                status: error.status,
                statusText: error.statusText,
                headers: error.headers,
                body: error.error,
                ...(error.url === null ? {} : { url: error.url }),
              }),
            );
          }
          if (error instanceof TimeoutError) {
            return throwError(
              () => new OfflineTransportError('timeout', 'The operation timed out.'),
            );
          }
          return throwError(
            () => new OfflineTransportError('network', 'The network request failed.'),
          );
        }),
      ),
    );
    return {
      status: response.status,
      headers: Object.fromEntries(
        response.headers.keys().map((name) => [name, response.headers.get(name) ?? '']),
      ),
      ...(descriptor.responseType === 'none' ? {} : { body: response.body }),
    };
  }
}

/**
 * Resolves the Angular transport from a `provideOfflineOutbox` configuration factory.
 *
 * @alpha
 */
export function withAngularHttpTransport(): OperationTransport {
  return inject(AngularHttpTransport);
}

function angularResponseType(responseType: HttpRequestDescriptor['responseType']) {
  return responseType === 'blob' || responseType === 'text' ? responseType : 'json';
}
