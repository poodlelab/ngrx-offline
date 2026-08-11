import { registerWorkspaceRequestSchema, workspaceSchema } from './contracts';
import { ApiError, constantTimeEqual, hmac, json, parseJson, sha256 } from './http';

interface WorkspaceRow {
  readonly id: string;
  readonly secret_hash: string;
  readonly last_active_at: string;
  readonly expires_at: string;
}

export interface WorkspaceContext {
  readonly id: string;
}

export async function registerWorkspace(request: Request, env: Env, now: Date): Promise<Response> {
  await enforceRateLimit(
    env,
    `registration:${await sha256(request.headers.get('cf-connecting-ip') ?? 'local')}`,
    now,
  );
  const input = await parseJson(request, registerWorkspaceRequestSchema);
  const secretHash = await hmac(`${input.workspaceId}.${input.secret}`, secretKey(env));
  const existing = await env.DB.prepare(
    'SELECT id, secret_hash, last_active_at, expires_at FROM workspaces WHERE id = ?',
  )
    .bind(input.workspaceId)
    .first<WorkspaceRow>();
  if (existing !== null) {
    if (!constantTimeEqual(existing.secret_hash, secretHash)) {
      throw new ApiError(
        409,
        'workspace_id_taken',
        'Workspace ID unavailable',
        'The workspace ID is already registered.',
      );
    }
    if (Date.parse(existing.expires_at) <= now.getTime()) {
      await env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind(input.workspaceId).run();
    } else {
      return json(
        { workspaceId: existing.id, expiresAt: existing.expires_at },
        200,
        {},
        workspaceSchema,
      );
    }
  }
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + positive(env.WORKSPACE_RETENTION_DAYS, 7) * 86_400_000,
  ).toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO workspaces (id, secret_hash, created_at, last_active_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(input.workspaceId, secretHash, createdAt, createdAt, expiresAt)
      .run();
  } catch {
    const raced = await env.DB.prepare(
      'SELECT secret_hash, expires_at FROM workspaces WHERE id = ?',
    )
      .bind(input.workspaceId)
      .first<Pick<WorkspaceRow, 'secret_hash' | 'expires_at'>>();
    if (raced === null || !constantTimeEqual(raced.secret_hash, secretHash)) {
      throw new ApiError(
        409,
        'workspace_id_taken',
        'Workspace ID unavailable',
        'The workspace ID is already registered.',
      );
    }
    return json(
      { workspaceId: input.workspaceId, expiresAt: raced.expires_at },
      200,
      {},
      workspaceSchema,
    );
  }
  return json({ workspaceId: input.workspaceId, expiresAt }, 201, {}, workspaceSchema);
}

export async function authenticate(
  request: Request,
  env: Env,
  now: Date,
): Promise<WorkspaceContext> {
  const match = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{43,128})$/i.exec(
    request.headers.get('authorization') ?? '',
  );
  const row =
    match === null
      ? null
      : await env.DB.prepare(
          'SELECT id, secret_hash, last_active_at, expires_at FROM workspaces WHERE id = ?',
        )
          .bind(match[1])
          .first<WorkspaceRow>();
  const candidateHash = match === null ? '' : await hmac(`${match[1]}.${match[2]}`, secretKey(env));
  if (
    row === null ||
    Date.parse(row.expires_at) <= now.getTime() ||
    !constantTimeEqual(row.secret_hash, candidateHash)
  ) {
    throw new ApiError(
      401,
      'workspace_unauthorized',
      'Unauthorized workspace',
      'Workspace credentials are invalid or expired.',
    );
  }
  await enforceRateLimit(env, `workspace:${row.id}`, now);
  if (now.getTime() - Date.parse(row.last_active_at) >= 3_600_000) {
    const expiresAt = new Date(
      now.getTime() + positive(env.WORKSPACE_RETENTION_DAYS, 7) * 86_400_000,
    ).toISOString();
    await env.DB.prepare(
      `UPDATE workspaces SET last_active_at = ?, expires_at = ?
       WHERE id = ? AND last_active_at = ?`,
    )
      .bind(now.toISOString(), expiresAt, row.id, row.last_active_at)
      .run();
  }
  return { id: row.id };
}

export async function resetWorkspace(env: Env, workspaceId: string, now: Date): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM memories WHERE workspace_id = ?').bind(workspaceId),
    env.DB.prepare('DELETE FROM day_reflections WHERE workspace_id = ?').bind(workspaceId),
    env.DB.prepare('DELETE FROM place_visits WHERE workspace_id = ?').bind(workspaceId),
    env.DB.prepare('DELETE FROM travel_days WHERE workspace_id = ?').bind(workspaceId),
    env.DB.prepare('DELETE FROM trips WHERE workspace_id = ?').bind(workspaceId),
    env.DB.prepare('DELETE FROM idempotency_results WHERE workspace_id = ?').bind(workspaceId),
    env.DB.prepare('DELETE FROM test_behaviors WHERE workspace_id = ?').bind(workspaceId),
    env.DB.prepare('DELETE FROM request_diagnostics WHERE workspace_id = ?').bind(workspaceId),
    env.DB.prepare('UPDATE workspaces SET last_active_at = ? WHERE id = ?').bind(
      now.toISOString(),
      workspaceId,
    ),
  ]);
}

export async function cleanupExpired(env: Env, now = new Date()): Promise<number> {
  const result = await env.DB.prepare(
    `DELETE FROM workspaces WHERE id IN (
       SELECT id FROM workspaces WHERE expires_at <= ? ORDER BY expires_at LIMIT 100
     )`,
  )
    .bind(now.toISOString())
    .run();
  await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at <= ?')
    .bind(now.toISOString())
    .run();
  return result.meta.changes;
}

export async function enforceRateLimit(env: Env, subject: string, now: Date): Promise<void> {
  const windowStart = Math.floor(now.getTime() / 60_000);
  const expiresAt = new Date((windowStart + 2) * 60_000).toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (subject, window_start, request_count, expires_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(subject, window_start) DO UPDATE SET request_count = request_count + 1
     RETURNING request_count`,
  )
    .bind(subject, windowStart, expiresAt)
    .first<{ request_count: number }>();
  if ((row?.request_count ?? 1) > positive(env.REQUESTS_PER_MINUTE, 150)) {
    throw new ApiError(
      429,
      'rate_limited',
      'Rate limited',
      'Request budget exhausted for this minute.',
    );
  }
}

function secretKey(env: Env): string {
  if (env.SECRET_HASH_KEY.length < 32) {
    throw new Error('SECRET_HASH_KEY must contain at least 32 characters.');
  }
  return env.SECRET_HASH_KEY;
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
