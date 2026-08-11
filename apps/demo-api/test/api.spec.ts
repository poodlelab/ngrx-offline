import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupExpired } from '../src/workspaces';

const secretA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const secretB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const workspaceA = '10000000-0000-4000-8000-000000000001';
const workspaceB = '20000000-0000-4000-8000-000000000002';

describe('Cloudflare Worker reference API', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM workspaces'),
      env.DB.prepare('DELETE FROM rate_limits'),
    ]);
  });

  it('registers recoverable hashed capabilities and applies exact-origin CORS', async () => {
    const health = await api('/v1/health', {
      headers: { Origin: 'https://poodlelab.github.io' },
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', version: '0.1.0' });
    expect(health.headers.get('access-control-allow-origin')).toBe('https://poodlelab.github.io');
    const version = await api('/v1/version');
    expect(await version.json()).toEqual({
      version: '0.1.0',
      compatibilityDate: '2026-08-10',
    });

    expect((await register(workspaceA, secretA)).status).toBe(201);
    expect((await register(workspaceA, secretA)).status).toBe(200);
    expect((await register(workspaceA, secretB)).status).toBe(409);
    const stored = await env.DB.prepare('SELECT secret_hash FROM workspaces WHERE id = ?')
      .bind(workspaceA)
      .first<{ secret_hash: string }>();
    expect(stored?.secret_hash).not.toContain(secretA);
    expect((await authorized('/v1/snapshot', workspaceA, secretB)).status).toBe(401);

    const preflight = await api('/v1/trips', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://poodlelab.github.io',
        'Access-Control-Request-Headers': 'Authorization, Idempotency-Key, Content-Type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Idempotency-Key');
    const disallowed = await api('/v1/health', {
      headers: { Origin: 'https://attacker.example' },
    });
    expect(disallowed.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('creates, reads, lists, updates, and snapshots the complete scoped hierarchy', async () => {
    await register(workspaceA, secretA);
    await register(workspaceB, secretB);
    const trip = await create(
      '/v1/trips',
      workspaceA,
      secretA,
      '30000000-0000-4000-8000-000000000001',
      tripPayload('40000000-0000-4000-8000-000000000001', 'Lisbon in the margins'),
    );
    expect(trip.response.status).toBe(201);
    expect(trip.body.id).toEqual(expect.any(Number));
    expect(trip.response.headers.get('etag')).toBe('"1"');
    const travelDay = await create(
      '/v1/travel-days',
      workspaceA,
      secretA,
      '30000000-0000-4000-8000-000000000002',
      {
        clientId: '40000000-0000-4000-8000-000000000002',
        tripId: trip.body.id,
        date: '2026-08-10',
        title: 'A slow morning in Alfama',
        summary: 'Climbed through tiled lanes before the city woke.',
      },
    );
    const placeVisit = await create(
      '/v1/place-visits',
      workspaceA,
      secretA,
      '30000000-0000-4000-8000-000000000003',
      {
        clientId: '40000000-0000-4000-8000-000000000003',
        travelDayId: travelDay.body.id,
        name: 'Miradouro da Senhora do Monte',
        city: 'Lisbon',
        countryCode: 'PT',
        arrivedAt: '2026-08-10T08:30:00.000Z',
      },
    );
    await create('/v1/memories', workspaceA, secretA, '30000000-0000-4000-8000-000000000004', {
      clientId: '40000000-0000-4000-8000-000000000004',
      placeVisitId: placeVisit.body.id,
      title: 'The city before breakfast',
      body: 'Terracotta roofs stepped down toward the river.',
      category: 'place',
      sortOrder: 0,
    });
    await create(
      '/v1/day-reflections',
      workspaceA,
      secretA,
      '30000000-0000-4000-8000-000000000005',
      {
        clientId: '40000000-0000-4000-8000-000000000005',
        travelDayId: travelDay.body.id,
        body: 'The city felt unhurried today.',
        mood: 'radiant',
        weather: 'Warm and clear',
        clientCreatedAt: '2026-08-10T12:00:00.000Z',
      },
    );

    const incomplete = await patch(
      `/v1/travel-days/${travelDay.body.id}`,
      workspaceA,
      secretA,
      '30000000-0000-4000-8000-000000000009',
      '"1"',
      { status: 'complete' },
    );
    expect(incomplete.response.status).toBe(409);
    expect(await code(incomplete.response)).toBe('day_has_planned_visits');

    const crossScope = await create(
      '/v1/travel-days',
      workspaceB,
      secretB,
      '30000000-0000-4000-8000-000000000006',
      {
        clientId: '40000000-0000-4000-8000-000000000006',
        tripId: trip.body.id,
        date: '2026-08-11',
        title: 'Forbidden relation',
        summary: 'This relation crosses workspace boundaries.',
      },
    );
    expect(crossScope.response.status).toBe(404);

    const visited = await patch(
      `/v1/place-visits/${placeVisit.body.id}`,
      workspaceA,
      secretA,
      '30000000-0000-4000-8000-000000000007',
      '"1"',
      { status: 'visited' },
    );
    expect(visited.response.status).toBe(200);
    expect(visited.body).toMatchObject({ status: 'visited', version: 2 });
    const completed = await patch(
      `/v1/travel-days/${travelDay.body.id}`,
      workspaceA,
      secretA,
      '30000000-0000-4000-8000-000000000008',
      '"1"',
      { status: 'complete' },
    );
    expect(completed.response.status).toBe(200);
    expect(completed.response.headers.get('etag')).toBe('"2"');
    expect(
      (await authorized(`/v1/place-visits/${placeVisit.body.id}`, workspaceB, secretB)).status,
    ).toBe(404);

    const snapshot = await authorized('/v1/snapshot', workspaceA, secretA);
    expect(await snapshot.json()).toMatchObject({
      trips: [{ id: trip.body.id }],
      travelDays: [{ tripId: trip.body.id }],
      placeVisits: [{ travelDayId: travelDay.body.id, status: 'visited' }],
      memories: [{ placeVisitId: placeVisit.body.id }],
      dayReflections: [{ travelDayId: travelDay.body.id }],
    });
    const list = await authorized(
      `/v1/travel-days?tripId=${trip.body.id}&limit=1`,
      workspaceA,
      secretA,
    );
    expect(await list.json()).toMatchObject({ items: [{ id: travelDay.body.id }] });
  });

  it('atomically collapses retries and concurrent equivalent deliveries', async () => {
    await register(workspaceA, secretA);
    const key = '50000000-0000-4000-8000-000000000001';
    const body = tripPayload('60000000-0000-4000-8000-000000000001', 'Idempotent trip');
    const [first, second] = await Promise.all([
      mutation('/v1/trips', workspaceA, secretA, key, body),
      mutation('/v1/trips', workspaceA, secretA, key, body),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(await first.json()).toEqual(await second.json());
    expect([
      first.headers.get('idempotency-replayed'),
      second.headers.get('idempotency-replayed'),
    ]).toContain('true');
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM trips WHERE workspace_id = ?')
      .bind(workspaceA)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);

    const mismatched = await mutation('/v1/trips', workspaceA, secretA, key, {
      ...body,
      title: 'Different payload',
    });
    expect(mismatched.status).toBe(409);
    expect(await code(mismatched)).toBe('idempotency_key_reused');
    const diagnostic = await authorized(
      `/v1/test-controls/diagnostics/${key}`,
      workspaceA,
      secretA,
    );
    expect(await diagnostic.json()).toMatchObject({ deliveries: 3, mutations: 1 });
  });

  it('enforces ETags and domain conflicts without storing failed receipts', async () => {
    await register(workspaceA, secretA);
    const trip = await create(
      '/v1/trips',
      workspaceA,
      secretA,
      '70000000-0000-4000-8000-000000000001',
      tripPayload('71000000-0000-4000-8000-000000000001', 'Conflict trip'),
    );
    const staleKey = '70000000-0000-4000-8000-000000000002';
    const updated = await patch(`/v1/trips/${trip.body.id}`, workspaceA, secretA, staleKey, '"1"', {
      title: 'Updated',
    });
    expect(updated.body.version).toBe(2);
    const replayed = await patch(
      `/v1/trips/${trip.body.id}`,
      workspaceA,
      secretA,
      staleKey,
      '"1"',
      { title: 'Updated' },
    );
    expect(replayed.response.status).toBe(200);
    expect(replayed.response.headers.get('idempotency-replayed')).toBe('true');
    const stale = await patch(
      `/v1/trips/${trip.body.id}`,
      workspaceA,
      secretA,
      '70000000-0000-4000-8000-000000000003',
      '"1"',
      { title: 'Stale' },
    );
    expect(stale.response.status).toBe(412);
    expect(await code(stale.response)).toBe('version_conflict');
  });

  it('provides one-shot scoped failures and commit-with-lost-response diagnostics', async () => {
    await register(workspaceA, secretA);
    await register(workspaceB, secretB);
    const key = '80000000-0000-4000-8000-000000000001';
    expect((await arm(workspaceA, secretA, key, 'commit_then_disconnect')).status).toBe(200);
    const body = tripPayload('81000000-0000-4000-8000-000000000001', 'Committed once');
    const lost = await mutation('/v1/trips', workspaceA, secretA, key, body);
    expect(lost.status).toBe(503);
    const replay = await mutation('/v1/trips', workspaceA, secretA, key, body);
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect(
      await (await authorized(`/v1/test-controls/diagnostics/${key}`, workspaceA, secretA)).json(),
    ).toMatchObject({ deliveries: 2, mutations: 1 });
    expect(
      await (await authorized(`/v1/test-controls/diagnostics/${key}`, workspaceB, secretB)).json(),
    ).toMatchObject({ deliveries: 0, mutations: 0 });

    const forcedKey = '80000000-0000-4000-8000-000000000002';
    const forcedCases = [
      ['conflict_409', 409, 'forced_conflict'],
      ['precondition_412', 412, 'forced_precondition_failure'],
      ['validation_422', 422, 'forced_validation_failure'],
      ['server_error_500', 500, 'forced_server_error'],
    ] as const;
    for (const [index, [behavior, status, expectedCode]] of forcedCases.entries()) {
      const operationKey = `82000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      await arm(workspaceA, secretA, operationKey, behavior);
      const forced = await mutation(
        '/v1/trips',
        workspaceA,
        secretA,
        operationKey,
        tripPayload(
          `83000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          `Forced ${behavior}`,
        ),
      );
      expect(forced.status).toBe(status);
      expect(await code(forced)).toBe(expectedCode);
    }

    await arm(workspaceA, secretA, forcedKey, 'server_error_500');
    expect(
      (
        await mutation('/v1/trips', workspaceA, secretA, forcedKey, {
          ...tripPayload('81000000-0000-4000-8000-000000000002', 'Retry me'),
        })
      ).status,
    ).toBe(500);
    expect(
      (
        await mutation('/v1/trips', workspaceA, secretA, forcedKey, {
          ...tripPayload('81000000-0000-4000-8000-000000000002', 'Retry me'),
        })
      ).status,
    ).toBe(201);

    const scopedKey = '84000000-0000-4000-8000-000000000001';
    await arm(workspaceA, secretA, scopedKey, 'conflict_409');
    expect(
      (
        await mutation('/v1/trips', workspaceB, secretB, scopedKey, {
          ...tripPayload('85000000-0000-4000-8000-000000000001', 'Unaffected workspace'),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await mutation('/v1/trips', workspaceA, secretA, scopedKey, {
          ...tripPayload('85000000-0000-4000-8000-000000000002', 'Affected workspace'),
        })
      ).status,
    ).toBe(409);

    const timeoutKey = '84000000-0000-4000-8000-000000000002';
    await arm(workspaceB, secretB, timeoutKey, 'timeout', 1);
    expect(
      (
        await mutation('/v1/trips', workspaceB, secretB, timeoutKey, {
          ...tripPayload('85000000-0000-4000-8000-000000000003', 'Delayed success'),
        })
      ).status,
    ).toBe(201);
  });

  it('rate limits one workspace without denying another workspace', async () => {
    await register(workspaceA, secretA);
    await register(workspaceB, secretB);
    let limited: Response | undefined;
    for (let index = 0; index < 41; index += 1) {
      limited = await authorized('/v1/snapshot', workspaceA, secretA);
    }
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get('retry-after')).toBe('60');
    expect((await authorized('/v1/snapshot', workspaceB, secretB)).status).toBe(200);
  });

  it('enforces validation, payload, quota, rate, reset, and expiration limits', async () => {
    await register(workspaceA, secretA);
    const wrongContentType = await authorized('/v1/trips', workspaceA, secretA, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Idempotency-Key': '90000000-0000-4000-8000-000000000000',
      },
      body: '{}',
    });
    expect(wrongContentType.status).toBe(400);
    expect(await code(wrongContentType)).toBe('invalid_request');
    expect((await authorized('/v1/trips?surprise=true', workspaceA, secretA)).status).toBe(400);
    const invalid = await mutation(
      '/v1/trips',
      workspaceA,
      secretA,
      '90000000-0000-4000-8000-000000000001',
      { ...tripPayload('not-a-uuid', 'Invalid'), unknown: true },
    );
    expect(invalid.status).toBe(422);
    const oversized = await mutation(
      '/v1/trips',
      workspaceA,
      secretA,
      '90000000-0000-4000-8000-000000000002',
      tripPayload('91000000-0000-4000-8000-000000000001', 'x'.repeat(66_000)),
    );
    expect(oversized.status).toBe(413);
    for (let index = 0; index < 2; index += 1) {
      const created = await create(
        '/v1/trips',
        workspaceA,
        secretA,
        `92000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        tripPayload(
          `93000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          `Trip ${index}`,
        ),
      );
      expect(created.response.status).toBe(201);
    }
    expect(
      (
        await create('/v1/trips', workspaceA, secretA, '92000000-0000-4000-8000-000000000003', {
          ...tripPayload('93000000-0000-4000-8000-000000000003', 'Over quota'),
        })
      ).response.status,
    ).toBe(409);
    expect(
      (await authorized('/v1/demo-workspaces/reset', workspaceA, secretA, { method: 'POST' }))
        .status,
    ).toBe(200);
    const emptySnapshot = (await (
      await authorized('/v1/snapshot', workspaceA, secretA)
    ).json()) as { trips: unknown[] };
    expect(emptySnapshot.trips).toEqual([]);

    await env.DB.prepare('UPDATE workspaces SET expires_at = ? WHERE id = ?')
      .bind('2000-01-01T00:00:00.000Z', workspaceA)
      .run();
    expect(await cleanupExpired(env, new Date('2026-08-10T00:00:00.000Z'))).toBe(1);
    expect((await authorized('/v1/snapshot', workspaceA, secretA)).status).toBe(401);
  });
});

function api(path: string, init: RequestInit = {}) {
  return SELF.fetch(`https://api.example${path}`, init);
}

function register(workspaceId: string, secret: string) {
  return api('/v1/demo-workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, secret }),
  });
}

function tripPayload(clientId: string, title: string) {
  return {
    clientId,
    title,
    destination: 'Lisbon, Portugal',
    startDate: '2026-08-10',
  };
}

function authorized(path: string, workspaceId: string, secret: string, init: RequestInit = {}) {
  return api(path, {
    ...init,
    headers: { Authorization: `Bearer ${workspaceId}.${secret}`, ...init.headers },
  });
}

function mutation(
  path: string,
  workspaceId: string,
  secret: string,
  key: string,
  body: unknown,
  headers: HeadersInit = {},
) {
  return authorized(path, workspaceId, secret, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers },
    body: JSON.stringify(body),
  });
}

async function create(
  path: string,
  workspaceId: string,
  secret: string,
  key: string,
  body: unknown,
) {
  const response = await mutation(path, workspaceId, secret, key, body);
  return { response, body: (await response.clone().json()) as EntityBody };
}

async function patch(
  path: string,
  workspaceId: string,
  secret: string,
  key: string,
  etag: string,
  body: unknown,
) {
  const response = await authorized(path, workspaceId, secret, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      'If-Match': etag,
    },
    body: JSON.stringify(body),
  });
  return { response, body: (await response.clone().json()) as EntityBody };
}

function arm(
  workspaceId: string,
  secret: string,
  idempotencyKey: string,
  behavior: string,
  delayMs?: number,
) {
  return authorized('/v1/test-controls/behaviors', workspaceId, secret, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idempotencyKey,
      behavior,
      ...(delayMs === undefined ? {} : { delayMs }),
    }),
  });
}

async function code(response: Response): Promise<string> {
  return ((await response.clone().json()) as { code: string }).code;
}

interface EntityBody extends Record<string, unknown> {
  readonly id: number;
  readonly version: number;
}
