import { ZodError, ZodType } from 'zod';
import { uuidSchema } from './contracts';

export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    message: string,
    readonly errors?: readonly ValidationIssue[],
  ) {
    super(message);
  }
}

export interface RequestContext {
  readonly requestId: string;
  readonly url: URL;
}

export function requestContext(request: Request): RequestContext {
  return { requestId: crypto.randomUUID(), url: new URL(request.url) };
}

export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    throw new ApiError(
      400,
      'invalid_request',
      'Invalid request',
      'Content-Type must be application/json.',
    );
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > 65_536) {
    throw new ApiError(
      413,
      'payload_too_large',
      'Payload too large',
      'Request body exceeds 64 KiB.',
    );
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 65_536) {
    throw new ApiError(
      413,
      'payload_too_large',
      'Payload too large',
      'Request body exceeds 64 KiB.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(
      400,
      'invalid_request',
      'Invalid request',
      'Request body is not valid JSON.',
    );
  }
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

export function json<T>(
  value: T,
  status = 200,
  headers: HeadersInit = {},
  schema?: ZodType<T>,
): Response {
  const output = schema?.parse(value) ?? value;
  return new Response(JSON.stringify(output), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function problem(error: ApiError, context: RequestContext): Response {
  return new Response(
    JSON.stringify({
      type: `https://github.com/poodlelab/ngrx-offline/problems/${error.code.replaceAll('_', '-')}`,
      title: error.title,
      status: error.status,
      detail: error.message,
      instance: context.url.pathname,
      code: error.code,
      requestId: context.requestId,
      ...(error.errors === undefined ? {} : { errors: error.errors }),
    }),
    {
      status: error.status,
      headers: { 'Content-Type': 'application/problem+json; charset=utf-8' },
    },
  );
}

export function parsePositiveId(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ApiError(
      400,
      'invalid_request',
      'Invalid request',
      'Resource ID must be a positive integer.',
    );
  }
  return id;
}

export function requireIdempotencyKey(request: Request): string {
  const result = uuidSchema.safeParse(request.headers.get('idempotency-key'));
  if (!result.success) {
    throw new ApiError(
      400,
      'invalid_request',
      'Invalid request',
      'Idempotency-Key must be a UUID.',
    );
  }
  return result.data;
}

export function requireIfMatch(request: Request): number {
  const match = /^"([1-9]\d*)"$/.exec(request.headers.get('if-match') ?? '');
  const version = Number(match?.[1]);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new ApiError(
      400,
      'invalid_request',
      'Invalid request',
      'If-Match must contain one strong positive-integer ETag.',
    );
  }
  return version;
}

export function pagination(url: URL, filterNames: readonly string[]) {
  const limitValue = url.searchParams.get('limit');
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(
      400,
      'invalid_request',
      'Invalid request',
      'limit must be between 1 and 100.',
    );
  }
  const filters = Object.fromEntries(filterNames.map((name) => [name, url.searchParams.get(name)]));
  const cursor = decodeCursor(url.searchParams.get('cursor'), filters);
  for (const value of Object.values(filters)) {
    if (value !== null) parsePositiveId(value);
  }
  const allowed = new Set(['cursor', 'limit', ...filterNames]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(
        400,
        'invalid_request',
        'Invalid request',
        `Unknown query parameter "${key}".`,
      );
    }
  }
  return { limit, cursor, filters };
}

export function nextCursor(position: unknown, filters: Readonly<Record<string, string | null>>) {
  return base64Url(JSON.stringify({ position, filters }));
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64Url(digest);
}

export async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64Url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function cors(request: Request, response: Response, env: Env): Response {
  const origin = request.headers.get('origin');
  const allowed = new Set([
    env.GITHUB_PAGES_ORIGIN,
    'http://localhost:4200',
    'http://127.0.0.1:4200',
  ]);
  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', response.headers.get('X-Request-Id') ?? crypto.randomUUID());
  headers.set('Vary', 'Origin');
  if (origin !== null && allowed.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    headers.set(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, Idempotency-Key, If-Match',
    );
    headers.set(
      'Access-Control-Expose-Headers',
      'ETag, Idempotency-Replayed, Location, Retry-After, X-Request-Id',
    );
    headers.set('Access-Control-Max-Age', '3600');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function logRequest(
  request: Request,
  context: RequestContext,
  response: Response,
  workspaceId?: string,
): void {
  console.log(
    JSON.stringify({
      event: 'api_request',
      requestId: context.requestId,
      method: request.method,
      path: context.url.pathname,
      status: response.status,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    }),
  );
}

function validationError(error: ZodError): ApiError {
  return new ApiError(
    422,
    'validation_failed',
    'Validation failed',
    'Request body failed validation.',
    error.issues.map((issue) => ({
      path: issue.path.length === 0 ? '$' : `$.${issue.path.join('.')}`,
      code: issue.code,
      message: issue.message,
    })),
  );
}

function decodeCursor(value: string | null, filters: Readonly<Record<string, string | null>>) {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlBytes(value))) as {
      position?: unknown;
      filters?: unknown;
    };
    if (canonicalJson(parsed.filters) !== canonicalJson(filters) || parsed.position === undefined) {
      throw new Error('mismatch');
    }
    return parsed.position;
  } catch {
    throw new ApiError(
      400,
      'invalid_cursor',
      'Invalid cursor',
      'Cursor is malformed or uses different filters.',
    );
  }
}

function base64Url(value: string | ArrayBuffer): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlBytes(value: string): Uint8Array {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
