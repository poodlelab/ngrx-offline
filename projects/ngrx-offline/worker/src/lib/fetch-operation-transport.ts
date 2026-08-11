import {
  HttpRequestDescriptor,
  OfflineTransportError,
  OperationTransport,
  TransportContext,
  TransportResponse,
} from '@poodlelab/ngrx-offline/core';

/** Asynchronous hook applied immediately before a worker fetch. @alpha */
export type WorkerRequestEnhancer = (
  request: HttpRequestDescriptor,
  context: TransportContext,
) => HttpRequestDescriptor | Promise<HttpRequestDescriptor>;

/** Options for the worker-safe fetch transport. @alpha */
export interface FetchOperationTransportOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly enhanceRequest?: WorkerRequestEnhancer;
}

/** Worker-safe transport for framework-independent request descriptors. @alpha */
export class FetchOperationTransport implements OperationTransport {
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(private readonly options: FetchOperationTransportOptions = {}) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async execute(
    requestValue: HttpRequestDescriptor,
    context: TransportContext,
  ): Promise<TransportResponse> {
    const request = this.options.enhanceRequest
      ? await this.options.enhanceRequest(requestValue, context)
      : requestValue;
    const controller = new AbortController();
    let timedOut = false;
    const timer =
      request.timeoutMs === undefined
        ? undefined
        : globalThis.setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, request.timeoutMs);
    try {
      const headers = new Headers(request.headers);
      if (request.body !== undefined && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      const response = await this.fetchImplementation(request.url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        ...(request.credentials === undefined ? {} : { credentials: request.credentials }),
        signal: controller.signal,
      });
      return {
        status: response.status,
        headers: responseHeaders(response.headers),
        ...(request.responseType === 'none' ? {} : { body: await responseBody(response, request) }),
      };
    } catch (error) {
      throw new OfflineTransportError(
        timedOut ? 'timeout' : 'network',
        timedOut ? 'The worker request timed out.' : safeFetchMessage(error),
      );
    } finally {
      if (timer !== undefined) globalThis.clearTimeout(timer);
    }
  }
}

/** Composes request enhancers in declaration order. @alpha */
export function composeWorkerRequestEnhancers(
  ...enhancers: readonly WorkerRequestEnhancer[]
): WorkerRequestEnhancer {
  return async (request, context) => {
    let enhanced = request;
    for (const enhancer of enhancers) enhanced = await enhancer(enhanced, context);
    return enhanced;
  };
}

/** Prefixes relative definition URLs without coupling definitions to an environment. @alpha */
export function withWorkerBaseUrl(baseUrl: string): WorkerRequestEnhancer {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return (request) => ({
    ...request,
    url: new URL(request.url.replace(/^\//, ''), normalized).toString(),
  });
}

/** Adds fresh headers at execution time, suitable for cookie/credential brokers. @alpha */
export function withWorkerHeaders(
  resolveHeaders: (
    context: TransportContext,
  ) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>,
): WorkerRequestEnhancer {
  return async (request, context) => ({
    ...request,
    headers: { ...request.headers, ...(await resolveHeaders(context)) },
  });
}

async function responseBody(response: Response, request: HttpRequestDescriptor): Promise<unknown> {
  if (response.status === 204 || response.headers.get('Content-Length') === '0') return undefined;
  if (request.responseType === 'blob') return response.blob();
  if (request.responseType === 'text') return response.text();
  const text = await response.text();
  return text === '' ? undefined : (JSON.parse(text) as unknown);
}

function responseHeaders(headers: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => (result[name] = value));
  return result;
}

function safeFetchMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The worker fetch failed.';
}
