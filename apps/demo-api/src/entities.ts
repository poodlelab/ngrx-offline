import { z } from 'zod';
import {
  createDayReflectionRequestSchema,
  createMemoryRequestSchema,
  createPlaceVisitRequestSchema,
  createTravelDayRequestSchema,
  createTripRequestSchema,
  dayReflectionListSchema,
  dayReflectionSchema,
  memoryListSchema,
  memorySchema,
  placeVisitListSchema,
  placeVisitSchema,
  snapshotSchema,
  travelDayListSchema,
  travelDaySchema,
  tripListSchema,
  tripSchema,
  updateDayReflectionRequestSchema,
  updateMemoryRequestSchema,
  updatePlaceVisitRequestSchema,
  updateTravelDayRequestSchema,
  updateTripRequestSchema,
} from './contracts';
import { ApiError, json, nextCursor, pagination } from './http';
import { MutationPlan } from './mutations';

export type EntityKind = 'day-reflection' | 'memory' | 'place-visit' | 'travel-day' | 'trip';
type Row = Record<string, number | string | null>;

const specifications = {
  trip: {
    table: 'trips',
    path: 'trips',
    quota: 50,
    quotaVariable: 'TRIP_QUOTA' as const,
    createSchema: createTripRequestSchema,
    updateSchema: updateTripRequestSchema,
    outputSchema: tripSchema,
    listSchema: tripListSchema,
    order: 'id',
    filters: [] as const,
  },
  'travel-day': {
    table: 'travel_days',
    path: 'travel-days',
    quota: 100,
    quotaVariable: 'TRAVEL_DAY_QUOTA' as const,
    createSchema: createTravelDayRequestSchema,
    updateSchema: updateTravelDayRequestSchema,
    outputSchema: travelDaySchema,
    listSchema: travelDayListSchema,
    order: 'date, id',
    filters: ['tripId'] as const,
  },
  'place-visit': {
    table: 'place_visits',
    path: 'place-visits',
    quota: 250,
    quotaVariable: 'PLACE_VISIT_QUOTA' as const,
    createSchema: createPlaceVisitRequestSchema,
    updateSchema: updatePlaceVisitRequestSchema,
    outputSchema: placeVisitSchema,
    listSchema: placeVisitListSchema,
    order: 'arrived_at, id',
    filters: ['travelDayId'] as const,
  },
  memory: {
    table: 'memories',
    path: 'memories',
    quota: 1_000,
    quotaVariable: 'MEMORY_QUOTA' as const,
    createSchema: createMemoryRequestSchema,
    updateSchema: updateMemoryRequestSchema,
    outputSchema: memorySchema,
    listSchema: memoryListSchema,
    order: 'sort_order, id',
    filters: ['placeVisitId'] as const,
  },
  'day-reflection': {
    table: 'day_reflections',
    path: 'day-reflections',
    quota: 1_000,
    quotaVariable: 'DAY_REFLECTION_QUOTA' as const,
    createSchema: createDayReflectionRequestSchema,
    updateSchema: updateDayReflectionRequestSchema,
    outputSchema: dayReflectionSchema,
    listSchema: dayReflectionListSchema,
    order: 'client_created_at, id',
    filters: ['travelDayId'] as const,
  },
} as const;

export function createSchema(kind: EntityKind): z.ZodType {
  return specifications[kind].createSchema;
}

export function updateSchema(kind: EntityKind): z.ZodType {
  return specifications[kind].updateSchema;
}

export async function createPlan(
  env: Env,
  workspaceId: string,
  kind: EntityKind,
  inputValue: unknown,
  now: Date,
): Promise<MutationPlan> {
  const specification = specifications[kind];
  const input = specification.createSchema.parse(inputValue) as Record<string, unknown>;
  await ensureQuota(
    env,
    workspaceId,
    specification.table,
    env[specification.quotaVariable],
    specification.quota,
  );
  await ensureClientIdAvailable(env, workspaceId, specification.table, input['clientId'] as string);
  await validateCreateParent(env, workspaceId, kind, input);
  const id = serverId();
  const timestamp = now.toISOString();
  const built = createValues(kind, workspaceId, id, input, timestamp);
  const response = specification.outputSchema.parse(built.output);
  return {
    statement: env.DB.prepare(
      `INSERT INTO ${specification.table} (${built.columns.join(', ')}) VALUES (${built.columns.map(() => '?').join(', ')})`,
    ).bind(...built.values),
    status: 201,
    body: response,
    location: `/v1/${specification.path}/${id}`,
    etag: '"1"',
  };
}

export async function updatePlan(
  env: Env,
  workspaceId: string,
  kind: EntityKind,
  id: number,
  inputValue: unknown,
  expectedVersion: number,
  now: Date,
): Promise<MutationPlan> {
  const specification = specifications[kind];
  const input = specification.updateSchema.parse(inputValue) as Record<string, unknown>;
  const currentRow = await env.DB.prepare(
    `SELECT * FROM ${specification.table} WHERE workspace_id = ? AND id = ?`,
  )
    .bind(workspaceId, id)
    .first<Row>();
  if (currentRow === null) notFound();
  if (currentRow['version'] !== expectedVersion) versionConflict(expectedVersion);
  await validateUpdateDomain(env, workspaceId, kind, id, input);
  const updatedAt = now.toISOString();
  const fields = updateValues(input);
  const next = specification.outputSchema.parse({
    ...mapRow(kind, currentRow),
    ...input,
    version: expectedVersion + 1,
    updatedAt,
  });
  return {
    statement: env.DB.prepare(
      `UPDATE ${specification.table} SET ${[
        ...fields.columns.map((column) => `${column} = ?`),
        'version = version + 1',
        'updated_at = ?',
      ].join(', ')} WHERE workspace_id = ? AND id = ? AND version = ?`,
    ).bind(...fields.values, updatedAt, workspaceId, id, expectedVersion),
    status: 200,
    body: next,
    etag: `"${expectedVersion + 1}"`,
  };
}

export async function getEntity(
  env: Env,
  workspaceId: string,
  kind: EntityKind,
  id: number,
): Promise<Response> {
  const specification = specifications[kind];
  const row = await env.DB.prepare(
    `SELECT * FROM ${specification.table} WHERE workspace_id = ? AND id = ?`,
  )
    .bind(workspaceId, id)
    .first<Row>();
  if (row === null) notFound();
  const entity = specification.outputSchema.parse(mapRow(kind, row));
  return json(entity, 200, { ETag: `"${entity.version}"` });
}

export async function listEntities(
  env: Env,
  workspaceId: string,
  kind: EntityKind,
  url: URL,
): Promise<Response> {
  const specification = specifications[kind];
  const { limit, cursor, filters } = pagination(url, specification.filters);
  const clauses = ['workspace_id = ?'];
  const values: unknown[] = [workspaceId];
  const filterColumns: Record<string, string> = {
    tripId: 'trip_id',
    travelDayId: 'travel_day_id',
    placeVisitId: 'place_visit_id',
  };
  for (const [name, value] of Object.entries(filters)) {
    if (value !== null) {
      clauses.push(`${filterColumns[name]} = ?`);
      values.push(Number(value));
    }
  }
  addCursor(kind, cursor, clauses, values);
  const result = await env.DB.prepare(
    `SELECT * FROM ${specification.table} WHERE ${clauses.join(' AND ')}
     ORDER BY ${specification.order} LIMIT ?`,
  )
    .bind(...values, limit + 1)
    .all<Row>();
  const rows = result.results;
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map((row) => mapRow(kind, row));
  const last = pageRows.at(-1);
  const cursorValue =
    hasMore && last !== undefined ? nextCursor(cursorPosition(kind, last), filters) : null;
  return json(specification.listSchema.parse({ items, page: { nextCursor: cursorValue } }));
}

export async function snapshot(env: Env, workspaceId: string, now: Date): Promise<Response> {
  const results = await env.DB.batch([
    env.DB.prepare('SELECT * FROM trips WHERE workspace_id = ? ORDER BY id').bind(workspaceId),
    env.DB.prepare('SELECT * FROM travel_days WHERE workspace_id = ? ORDER BY date, id').bind(
      workspaceId,
    ),
    env.DB.prepare(
      'SELECT * FROM place_visits WHERE workspace_id = ? ORDER BY arrived_at, id',
    ).bind(workspaceId),
    env.DB.prepare('SELECT * FROM memories WHERE workspace_id = ? ORDER BY sort_order, id').bind(
      workspaceId,
    ),
    env.DB.prepare(
      'SELECT * FROM day_reflections WHERE workspace_id = ? ORDER BY client_created_at, id',
    ).bind(workspaceId),
  ]);
  return json(
    snapshotSchema.parse({
      trips: results[0]?.results.map((row) => mapRow('trip', row as Row)) ?? [],
      travelDays: results[1]?.results.map((row) => mapRow('travel-day', row as Row)) ?? [],
      placeVisits: results[2]?.results.map((row) => mapRow('place-visit', row as Row)) ?? [],
      memories: results[3]?.results.map((row) => mapRow('memory', row as Row)) ?? [],
      dayReflections: results[4]?.results.map((row) => mapRow('day-reflection', row as Row)) ?? [],
      generatedAt: now.toISOString(),
    }),
  );
}

function createValues(
  kind: EntityKind,
  workspaceId: string,
  id: number,
  input: Record<string, unknown>,
  timestamp: string,
) {
  const commonColumns = ['workspace_id', 'id', 'client_id', 'version'];
  const commonValues = [workspaceId, id, input['clientId'], 1];
  const complete = (columns: string[], values: unknown[], output: Record<string, unknown>) => ({
    columns: [...commonColumns, ...columns, 'created_at', 'updated_at'],
    values: [...commonValues, ...values, timestamp, timestamp],
    output: {
      id,
      clientId: input['clientId'],
      version: 1,
      ...output,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
  if (kind === 'trip')
    return complete(
      ['title', 'destination', 'start_date', 'status'],
      [input['title'], input['destination'], input['startDate'], 'planned'],
      {
        title: input['title'],
        destination: input['destination'],
        startDate: input['startDate'],
        status: 'planned',
      },
    );
  if (kind === 'travel-day')
    return complete(
      ['trip_id', 'date', 'title', 'summary', 'status'],
      [input['tripId'], input['date'], input['title'], input['summary'] ?? null, 'planned'],
      {
        tripId: input['tripId'],
        date: input['date'],
        title: input['title'],
        summary: input['summary'] ?? null,
        status: 'planned',
      },
    );
  if (kind === 'place-visit')
    return complete(
      ['travel_day_id', 'name', 'city', 'country_code', 'arrived_at', 'status'],
      [
        input['travelDayId'],
        input['name'],
        input['city'],
        input['countryCode'],
        input['arrivedAt'] ?? null,
        'planned',
      ],
      {
        travelDayId: input['travelDayId'],
        name: input['name'],
        city: input['city'],
        countryCode: input['countryCode'],
        arrivedAt: input['arrivedAt'] ?? null,
        status: 'planned',
      },
    );
  if (kind === 'memory')
    return complete(
      ['place_visit_id', 'title', 'body', 'category', 'sort_order'],
      [input['placeVisitId'], input['title'], input['body'], input['category'], input['sortOrder']],
      {
        placeVisitId: input['placeVisitId'],
        title: input['title'],
        body: input['body'],
        category: input['category'],
        sortOrder: input['sortOrder'],
      },
    );
  return complete(
    ['travel_day_id', 'body', 'mood', 'weather', 'client_created_at'],
    [
      input['travelDayId'],
      input['body'],
      input['mood'],
      input['weather'] ?? null,
      input['clientCreatedAt'],
    ],
    {
      travelDayId: input['travelDayId'],
      body: input['body'],
      mood: input['mood'],
      weather: input['weather'] ?? null,
      clientCreatedAt: input['clientCreatedAt'],
    },
  );
}

function updateValues(input: Record<string, unknown>) {
  const mapping: Readonly<Record<string, string>> = {
    arrivedAt: 'arrived_at',
    body: 'body',
    category: 'category',
    city: 'city',
    countryCode: 'country_code',
    date: 'date',
    destination: 'destination',
    mood: 'mood',
    name: 'name',
    sortOrder: 'sort_order',
    startDate: 'start_date',
    status: 'status',
    summary: 'summary',
    title: 'title',
    weather: 'weather',
  };
  const columns: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(input)) {
    columns.push(mapping[key] as string);
    values.push(value);
  }
  return { columns, values };
}

async function validateCreateParent(
  env: Env,
  workspaceId: string,
  kind: EntityKind,
  input: Record<string, unknown>,
) {
  if (kind === 'trip') return;
  const parent =
    kind === 'travel-day'
      ? { table: 'trips', id: input['tripId'], disallowed: ['archived'] }
      : kind === 'place-visit' || kind === 'day-reflection'
        ? { table: 'travel_days', id: input['travelDayId'], disallowed: [] }
        : { table: 'place_visits', id: input['placeVisitId'], disallowed: ['skipped'] };
  const row = await env.DB.prepare(
    `SELECT status FROM ${parent.table} WHERE workspace_id = ? AND id = ?`,
  )
    .bind(workspaceId, parent.id)
    .first<{ status: string }>();
  if (row === null) notFound();
  if (parent.disallowed.includes(row.status))
    domainConflict('parent_unavailable', 'The parent journal record cannot accept this child.');
}

async function validateUpdateDomain(
  env: Env,
  workspaceId: string,
  kind: EntityKind,
  id: number,
  input: Record<string, unknown>,
) {
  if (kind === 'trip' && input['status'] === 'archived') {
    await conflictIfExists(
      env,
      "SELECT 1 FROM travel_days WHERE workspace_id = ? AND trip_id = ? AND status != 'complete' LIMIT 1",
      workspaceId,
      id,
      'trip_has_active_days',
    );
  }
  if (kind === 'travel-day' && input['status'] === 'complete') {
    await conflictIfExists(
      env,
      "SELECT 1 FROM place_visits WHERE workspace_id = ? AND travel_day_id = ? AND status = 'planned' LIMIT 1",
      workspaceId,
      id,
      'day_has_planned_visits',
    );
  }
}

async function conflictIfExists(
  env: Env,
  sql: string,
  workspaceId: string,
  id: number,
  code: string,
) {
  if ((await env.DB.prepare(sql).bind(workspaceId, id).first()) !== null)
    domainConflict(code, 'The requested state conflicts with related journal records.');
}

async function ensureQuota(
  env: Env,
  workspaceId: string,
  table: string,
  configured: string | undefined,
  fallback: number,
) {
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`,
  )
    .bind(workspaceId)
    .first<{ count: number }>();
  if ((count?.count ?? 0) >= quota(configured, fallback))
    domainConflict('workspace_quota_exceeded', `The ${table} quota is exhausted.`);
}

async function ensureClientIdAvailable(
  env: Env,
  workspaceId: string,
  table: string,
  clientId: string,
) {
  if (
    (await env.DB.prepare(`SELECT 1 FROM ${table} WHERE workspace_id = ? AND client_id = ?`)
      .bind(workspaceId, clientId)
      .first()) !== null
  )
    domainConflict('client_id_exists', 'The client ID already exists for this entity kind.');
}

function mapRow(kind: EntityKind, row: Row): Record<string, unknown> {
  const base = {
    id: row['id'],
    clientId: row['client_id'],
    version: row['version'],
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
  };
  if (kind === 'trip')
    return {
      ...base,
      title: row['title'],
      destination: row['destination'],
      startDate: row['start_date'],
      status: row['status'],
    };
  if (kind === 'travel-day')
    return {
      ...base,
      tripId: row['trip_id'],
      date: row['date'],
      title: row['title'],
      summary: row['summary'],
      status: row['status'],
    };
  if (kind === 'place-visit')
    return {
      ...base,
      travelDayId: row['travel_day_id'],
      name: row['name'],
      city: row['city'],
      countryCode: row['country_code'],
      arrivedAt: row['arrived_at'],
      status: row['status'],
    };
  if (kind === 'memory')
    return {
      ...base,
      placeVisitId: row['place_visit_id'],
      title: row['title'],
      body: row['body'],
      category: row['category'],
      sortOrder: row['sort_order'],
    };
  return {
    ...base,
    travelDayId: row['travel_day_id'],
    body: row['body'],
    mood: row['mood'],
    weather: row['weather'],
    clientCreatedAt: row['client_created_at'],
  };
}

function addCursor(kind: EntityKind, cursor: unknown, clauses: string[], values: unknown[]) {
  if (cursor === undefined) return;
  if (kind === 'memory' && Array.isArray(cursor) && cursor.length === 2) {
    clauses.push('(sort_order > ? OR (sort_order = ? AND id > ?))');
    values.push(cursor[0], cursor[0], cursor[1]);
  } else if (kind === 'day-reflection' && Array.isArray(cursor) && cursor.length === 2) {
    clauses.push('(client_created_at > ? OR (client_created_at = ? AND id > ?))');
    values.push(cursor[0], cursor[0], cursor[1]);
  } else if (typeof cursor === 'number') {
    clauses.push('id > ?');
    values.push(cursor);
  } else {
    throw new ApiError(400, 'invalid_cursor', 'Invalid cursor', 'Cursor position is invalid.');
  }
}

function cursorPosition(kind: EntityKind, row: Row): unknown {
  if (kind === 'memory') return [row['sort_order'], row['id']];
  if (kind === 'day-reflection') return [row['client_created_at'], row['id']];
  return row['id'];
}

function serverId(): number {
  const values = crypto.getRandomValues(new Uint32Array(2));
  return ((values[0] ?? 0) & 0x1f_ffff) * 0x1_0000_0000 + (values[1] ?? 1) || 1;
}
function quota(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function notFound(): never {
  throw new ApiError(
    404,
    'resource_not_found',
    'Resource not found',
    'The journal record does not exist in this workspace.',
  );
}
function versionConflict(version: number): never {
  throw new ApiError(
    412,
    'version_conflict',
    'Version conflict',
    `The journal record changed after version ${version}.`,
  );
}
function domainConflict(code: string, detail: string): never {
  throw new ApiError(409, code, 'Domain conflict', detail);
}
