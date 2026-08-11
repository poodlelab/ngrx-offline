import { healthSchema, versionInfoSchema, workspaceResetSchema } from './contracts';
import {
  EntityKind,
  createPlan,
  createSchema,
  getEntity,
  listEntities,
  snapshot,
  updatePlan,
  updateSchema,
} from './entities';
import {
  ApiError,
  cors,
  json,
  logRequest,
  parseJson,
  parsePositiveId,
  problem,
  requestContext,
  requireIfMatch,
} from './http';
import { clearBehavior, configureBehavior, diagnostics, executeMutation } from './mutations';
import { authenticate, cleanupExpired, registerWorkspace, resetWorkspace } from './workspaces';

const collections: Readonly<Record<string, EntityKind>> = {
  trips: 'trip',
  'travel-days': 'travel-day',
  'place-visits': 'place-visit',
  memories: 'memory',
  'day-reflections': 'day-reflection',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const context = requestContext(request);
    let workspaceId: string | undefined;
    let response: Response;
    try {
      if (request.method === 'OPTIONS') {
        response = new Response(null, { status: 204 });
      } else if (context.url.pathname === '/v1/health' && request.method === 'GET') {
        response = json(
          { status: 'ok', version: env.API_VERSION, time: new Date().toISOString() },
          200,
          {},
          healthSchema,
        );
      } else if (context.url.pathname === '/v1/version' && request.method === 'GET') {
        response = json(
          { version: env.API_VERSION, compatibilityDate: '2026-08-10' },
          200,
          {},
          versionInfoSchema,
        );
      } else if (context.url.pathname === '/v1/demo-workspaces' && request.method === 'POST') {
        response = await registerWorkspace(request, env, new Date());
      } else {
        const workspace = await authenticate(request, env, new Date());
        workspaceId = workspace.id;
        response = await routeProtected(request, env, workspace.id, context.url);
      }
    } catch (error) {
      const apiError = normalizeError(error);
      response = problem(apiError, context);
      if (apiError.status === 429 || apiError.status === 503) {
        const headers = new Headers(response.headers);
        headers.set('Retry-After', apiError.status === 429 ? '60' : '0');
        response = new Response(response.body, { status: response.status, headers });
      }
      if (apiError.status >= 500) {
        console.error(
          JSON.stringify({
            event: 'api_error',
            requestId: context.requestId,
            code: apiError.code,
            status: apiError.status,
            ...(workspaceId === undefined ? {} : { workspaceId }),
          }),
        );
      }
    }
    const headers = new Headers(response.headers);
    headers.set('X-Request-Id', context.requestId);
    response = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    response = cors(request, response, env);
    logRequest(request, context, response, workspaceId);
    return response;
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const deleted = await cleanupExpired(env);
    console.log(JSON.stringify({ event: 'workspace_cleanup', deleted }));
  },
} satisfies ExportedHandler<Env>;

async function routeProtected(
  request: Request,
  env: Env,
  workspaceId: string,
  url: URL,
): Promise<Response> {
  const now = new Date();
  if (url.pathname === '/v1/demo-workspaces/reset' && request.method === 'POST') {
    await resetWorkspace(env, workspaceId, now);
    return json({ workspaceId, resetAt: now.toISOString() }, 200, {}, workspaceResetSchema);
  }
  if (url.pathname === '/v1/snapshot' && request.method === 'GET') {
    return snapshot(env, workspaceId, now);
  }
  if (url.pathname === '/v1/test-controls/behaviors' && request.method === 'POST') {
    return configureBehavior(request, env, workspaceId, now);
  }
  const behaviorMatch = /^\/v1\/test-controls\/behaviors\/([^/]+)$/.exec(url.pathname);
  if (behaviorMatch !== null && request.method === 'DELETE') {
    return clearBehavior(env, workspaceId, behaviorMatch[1] as string);
  }
  const diagnosticsMatch = /^\/v1\/test-controls\/diagnostics\/([^/]+)$/.exec(url.pathname);
  if (diagnosticsMatch !== null && request.method === 'GET') {
    return diagnostics(env, workspaceId, diagnosticsMatch[1] as string);
  }

  const collectionMatch = /^\/v1\/([^/]+)$/.exec(url.pathname);
  const collectionKind =
    collectionMatch === null ? undefined : collections[collectionMatch[1] as string];
  if (collectionKind !== undefined) {
    if (request.method === 'GET') return listEntities(env, workspaceId, collectionKind, url);
    if (request.method === 'POST') {
      const input = await parseJson(request, createSchema(collectionKind));
      return executeMutation(request, env, workspaceId, input, undefined, now, () =>
        createPlan(env, workspaceId, collectionKind, input, now),
      );
    }
  }

  const detailMatch = /^\/v1\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  const detailKind = detailMatch === null ? undefined : collections[detailMatch[1] as string];
  if (detailMatch !== null && detailKind !== undefined) {
    const id = parsePositiveId(detailMatch[2]);
    if (request.method === 'GET') return getEntity(env, workspaceId, detailKind, id);
    if (request.method === 'PATCH') {
      const input = await parseJson(request, updateSchema(detailKind));
      const ifMatch = requireIfMatch(request);
      return executeMutation(request, env, workspaceId, input, ifMatch, now, () =>
        updatePlan(env, workspaceId, detailKind, id, input, ifMatch, now),
      );
    }
  }
  throw new ApiError(404, 'resource_not_found', 'Resource not found', 'The route does not exist.');
}

function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return new ApiError(
        409,
        'client_id_exists',
        'Client ID exists',
        'The client-generated ID already exists in this workspace.',
      );
    }
    if (error.message.includes('FOREIGN KEY constraint failed')) {
      return new ApiError(
        404,
        'resource_not_found',
        'Resource not found',
        'A referenced resource does not exist in this workspace.',
      );
    }
  }
  return new ApiError(
    500,
    'internal_error',
    'Internal error',
    'The request could not be completed.',
  );
}
