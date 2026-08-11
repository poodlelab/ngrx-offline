import {
  configureTestBehaviorRequestSchema,
  configuredTestBehaviorSchema,
  requestDiagnosticSchema,
  testBehaviorSchema,
  uuidSchema,
} from './contracts';
import { ApiError, canonicalJson, json, parseJson, requireIdempotencyKey, sha256 } from './http';

interface IdempotencyRow {
  readonly fingerprint: string;
  readonly status: number;
  readonly body: string;
  readonly location: string | null;
  readonly etag: string | null;
}

interface BehaviorRow {
  readonly behavior: string;
  readonly delay_ms: number;
}

export interface MutationPlan {
  readonly statement: D1PreparedStatement;
  readonly status: number;
  readonly body: unknown;
  readonly location?: string;
  readonly etag?: string;
}

export async function executeMutation(
  request: Request,
  env: Env,
  workspaceId: string,
  input: unknown,
  ifMatch: number | undefined,
  now: Date,
  plan: () => Promise<MutationPlan>,
): Promise<Response> {
  const key = requireIdempotencyKey(request);
  const fingerprint = await sha256(
    canonicalJson({
      method: request.method,
      route: new URL(request.url).pathname,
      body: input,
      ifMatch: ifMatch ?? null,
    }),
  );
  await recordDelivery(env, workspaceId, key, now);
  const existing = await readReceipt(env, workspaceId, key);
  if (existing !== null) return replay(existing, fingerprint);

  const behavior = await env.DB.prepare(
    'SELECT behavior, delay_ms FROM test_behaviors WHERE workspace_id = ? AND idempotency_key = ?',
  )
    .bind(workspaceId, key)
    .first<BehaviorRow>();
  if (behavior !== null && behavior.behavior !== 'commit_then_disconnect') {
    await env.DB.prepare(
      'DELETE FROM test_behaviors WHERE workspace_id = ? AND idempotency_key = ?',
    )
      .bind(workspaceId, key)
      .run();
    if (behavior.behavior === 'timeout') {
      await new Promise((resolve) => setTimeout(resolve, behavior.delay_ms || 10_000));
    } else {
      throw forcedBehavior(behavior.behavior);
    }
  }

  const mutation = await plan();
  const body = canonicalJson(mutation.body);
  const statements: D1PreparedStatement[] = [];
  if (behavior?.behavior === 'commit_then_disconnect') {
    statements.push(
      env.DB.prepare(
        'DELETE FROM test_behaviors WHERE workspace_id = ? AND idempotency_key = ?',
      ).bind(workspaceId, key),
    );
  }
  statements.push(mutation.statement);
  const mutationIndex = statements.length - 1;
  statements.push(
    env.DB.prepare(
      `INSERT INTO idempotency_results
       (workspace_id, idempotency_key, fingerprint, status, body, location, etag, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
    ).bind(
      workspaceId,
      key,
      fingerprint,
      mutation.status,
      body,
      mutation.location ?? null,
      mutation.etag ?? null,
      now.toISOString(),
    ),
  );
  const receiptIndex = statements.length - 1;
  statements.push(
    env.DB.prepare(
      `UPDATE request_diagnostics SET mutations = mutations + 1, updated_at = ?
       WHERE workspace_id = ? AND idempotency_key = ? AND changes() = 1`,
    ).bind(now.toISOString(), workspaceId, key),
  );

  try {
    const results = await env.DB.batch(statements);
    if (results[mutationIndex]?.meta.changes !== 1 || results[receiptIndex]?.meta.changes !== 1) {
      throw new ApiError(
        412,
        'version_conflict',
        'Version conflict',
        'The entity changed after the supplied version.',
      );
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const raced = await readReceipt(env, workspaceId, key);
    if (raced !== null) return replay(raced, fingerprint);
    throw error;
  }

  if (behavior?.behavior === 'commit_then_disconnect') {
    throw new ApiError(
      503,
      'committed_response_suppressed',
      'Response suppressed',
      'The mutation committed, but this deterministic test response was suppressed.',
    );
  }
  return mutationResponse(mutation, false);
}

export async function configureBehavior(
  request: Request,
  env: Env,
  workspaceId: string,
  now: Date,
): Promise<Response> {
  const input = await parseJson(request, configureTestBehaviorRequestSchema);
  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM test_behaviors WHERE workspace_id = ?',
  )
    .bind(workspaceId)
    .first<{ count: number }>();
  const existing = await env.DB.prepare(
    'SELECT 1 AS present FROM test_behaviors WHERE workspace_id = ? AND idempotency_key = ?',
  )
    .bind(workspaceId, input.idempotencyKey)
    .first();
  if (existing === null && (count?.count ?? 0) >= quota(env.TEST_BEHAVIOR_QUOTA, 20)) {
    throw new ApiError(
      409,
      'workspace_quota_exceeded',
      'Workspace quota exceeded',
      'The test-behavior quota is exhausted.',
    );
  }
  await env.DB.prepare(
    `INSERT INTO test_behaviors (workspace_id, idempotency_key, behavior, delay_ms, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, idempotency_key) DO UPDATE SET
       behavior = excluded.behavior, delay_ms = excluded.delay_ms, created_at = excluded.created_at`,
  )
    .bind(
      workspaceId,
      input.idempotencyKey,
      input.behavior,
      input.delayMs ?? (input.behavior === 'timeout' ? 10_000 : 0),
      now.toISOString(),
    )
    .run();
  return json(
    { idempotencyKey: input.idempotencyKey, behavior: input.behavior, armed: true },
    200,
    {},
    configuredTestBehaviorSchema,
  );
}

export async function clearBehavior(
  env: Env,
  workspaceId: string,
  idempotencyKey: string,
): Promise<Response> {
  const parsed = testBehaviorKey(idempotencyKey);
  await env.DB.prepare('DELETE FROM test_behaviors WHERE workspace_id = ? AND idempotency_key = ?')
    .bind(workspaceId, parsed)
    .run();
  return new Response(null, { status: 204 });
}

export async function diagnostics(env: Env, workspaceId: string, idempotencyKey: string) {
  const parsed = testBehaviorKey(idempotencyKey);
  const row = await env.DB.prepare(
    `SELECT deliveries, mutations, updated_at FROM request_diagnostics
     WHERE workspace_id = ? AND idempotency_key = ?`,
  )
    .bind(workspaceId, parsed)
    .first<{ deliveries: number; mutations: number; updated_at: string }>();
  return json(
    {
      idempotencyKey: parsed,
      deliveries: row?.deliveries ?? 0,
      mutations: row?.mutations ?? 0,
      updatedAt: row?.updated_at ?? null,
    },
    200,
    {},
    requestDiagnosticSchema,
  );
}

function mutationResponse(plan: MutationPlan, replayed: boolean): Response {
  return json(plan.body, plan.status, {
    ...(plan.location === undefined ? {} : { Location: plan.location }),
    ...(plan.etag === undefined ? {} : { ETag: plan.etag }),
    ...(replayed ? { 'Idempotency-Replayed': 'true' } : {}),
  });
}

function replay(receipt: IdempotencyRow, fingerprint: string): Response {
  if (!constantFingerprint(receipt.fingerprint, fingerprint)) {
    throw new ApiError(
      409,
      'idempotency_key_reused',
      'Idempotency key reused',
      'The idempotency key was already used for a different request.',
    );
  }
  return mutationResponse(
    {
      statement: undefined as unknown as D1PreparedStatement,
      status: receipt.status,
      body: JSON.parse(receipt.body),
      ...(receipt.location === null ? {} : { location: receipt.location }),
      ...(receipt.etag === null ? {} : { etag: receipt.etag }),
    },
    true,
  );
}

function readReceipt(env: Env, workspaceId: string, key: string) {
  return env.DB.prepare(
    `SELECT fingerprint, status, body, location, etag FROM idempotency_results
     WHERE workspace_id = ? AND idempotency_key = ?`,
  )
    .bind(workspaceId, key)
    .first<IdempotencyRow>();
}

function recordDelivery(env: Env, workspaceId: string, key: string, now: Date) {
  return env.DB.prepare(
    `INSERT INTO request_diagnostics
     (workspace_id, idempotency_key, deliveries, mutations, updated_at)
     VALUES (?, ?, 1, 0, ?)
     ON CONFLICT(workspace_id, idempotency_key) DO UPDATE SET
       deliveries = deliveries + 1, updated_at = excluded.updated_at`,
  )
    .bind(workspaceId, key, now.toISOString())
    .run();
}

function forcedBehavior(behaviorValue: string): ApiError {
  const behavior = testBehaviorSchema.parse(behaviorValue);
  const values = {
    conflict_409: [409, 'forced_conflict', 'Forced conflict'],
    precondition_412: [412, 'forced_precondition_failure', 'Forced precondition failure'],
    validation_422: [422, 'forced_validation_failure', 'Forced validation failure'],
    server_error_500: [500, 'forced_server_error', 'Forced server error'],
  } as const;
  if (behavior === 'timeout' || behavior === 'commit_then_disconnect') {
    throw new Error('Behavior is handled separately.');
  }
  const [status, code, title] = values[behavior];
  return new ApiError(status, code, title, `${title} was armed for this operation.`);
}

function testBehaviorKey(value: string) {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, 'invalid_request', 'Invalid request', 'Operation key must be a UUID.');
  }
  return parsed.data;
}

function constantFingerprint(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function quota(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
