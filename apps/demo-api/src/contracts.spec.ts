import { describe, expect, it } from 'vitest';
import {
  configureTestBehaviorRequestSchema,
  createMemoryOperationInputSchema,
  createTripOperationInputSchema,
  createDayReflectionOperationInputSchema,
  createTravelDayOperationInputSchema,
  createTravelDayRequestSchema,
  createPlaceVisitOperationInputSchema,
  problemDetailsSchema,
  registerWorkspaceRequestSchema,
  updateTripRequestSchema,
} from './contracts';

const ids = {
  trip: '11111111-1111-4111-8111-111111111111',
  travelDay: '22222222-2222-4222-8222-222222222222',
  placeVisit: '33333333-3333-4333-8333-333333333333',
  memory: '44444444-4444-4444-8444-444444444444',
  dayReflection: '55555555-5555-4555-8555-555555555555',
  operation: '66666666-6666-4666-8666-666666666666',
  workspace: '77777777-7777-4777-8777-777777777777',
} as const;

const tripReference = {
  type: 'offline-reference',
  kind: 'trip',
  clientId: ids.trip,
} as const;
const travelDayReference = {
  type: 'offline-reference',
  kind: 'travel-day',
  clientId: ids.travelDay,
} as const;
const placeVisitReference = {
  type: 'offline-reference',
  kind: 'place-visit',
  clientId: ids.placeVisit,
} as const;

describe('reference application contracts', () => {
  it('expresses the complete related offline creation chain', () => {
    expect(
      createTripOperationInputSchema.parse({
        trip: {
          clientId: ids.trip,
          title: 'Lisbon in the margins',
          destination: 'Lisbon, Portugal',
          startDate: '2026-08-10',
        },
      }),
    ).toBeDefined();

    expect(
      createTravelDayOperationInputSchema.parse({
        travelDay: {
          clientId: ids.travelDay,
          date: '2026-08-10',
          title: 'A slow morning in Alfama',
          summary: 'Climbed through tiled lanes before the city woke.',
        },
        trip: tripReference,
      }),
    ).toBeDefined();

    expect(
      createPlaceVisitOperationInputSchema.parse({
        placeVisit: {
          clientId: ids.placeVisit,
          name: 'Miradouro da Senhora do Monte',
          city: 'Lisbon',
          countryCode: 'PT',
          arrivedAt: '2026-08-10T08:30:00.000Z',
        },
        travelDay: travelDayReference,
      }),
    ).toBeDefined();

    expect(
      createMemoryOperationInputSchema.parse({
        memory: {
          clientId: ids.memory,
          title: 'The city before breakfast',
          body: 'Terracotta roofs stepped down toward the river.',
          category: 'place',
          sortOrder: 0,
        },
        placeVisit: placeVisitReference,
      }),
    ).toBeDefined();

    expect(
      createDayReflectionOperationInputSchema.parse({
        dayReflection: {
          clientId: ids.dayReflection,
          body: 'The city felt unhurried today.',
          mood: 'radiant',
          weather: 'Warm and clear',
          clientCreatedAt: '2026-08-10T12:00:00.000Z',
        },
        travelDay: travelDayReference,
      }),
    ).toBeDefined();
  });

  it('requires resolved numeric parent IDs at the HTTP boundary', () => {
    const result = createTravelDayRequestSchema.safeParse({
      clientId: ids.travelDay,
      tripId: tripReference,
      date: '2026-08-10',
      title: 'A slow morning in Alfama',
      summary: 'Climbed through tiled lanes before the city woke.',
    });

    expect(result.success).toBe(false);
  });

  it('rejects empty updates and unexpected properties', () => {
    expect(updateTripRequestSchema.safeParse({}).success).toBe(false);
    expect(updateTripRequestSchema.safeParse({ title: 'Updated', ignored: true }).success).toBe(
      false,
    );
  });

  it('requires a high-entropy base64url workspace secret', () => {
    expect(
      registerWorkspaceRequestSchema.safeParse({
        workspaceId: ids.workspace,
        secret: 'too-short',
      }).success,
    ).toBe(false);

    expect(
      registerWorkspaceRequestSchema.safeParse({
        workspaceId: ids.workspace,
        secret: 'gP6RjvzY2M5EuJrJ0YJDHhSl9IgOlLzQYrP7b9Et9QU',
      }).success,
    ).toBe(true);
  });

  it('defines deterministic behavior controls by idempotency key', () => {
    expect(
      configureTestBehaviorRequestSchema.parse({
        idempotencyKey: ids.operation,
        behavior: 'commit_then_disconnect',
      }),
    ).toEqual({
      idempotencyKey: ids.operation,
      behavior: 'commit_then_disconnect',
    });
  });

  it('uses stable machine-readable problem codes', () => {
    expect(
      problemDetailsSchema.parse({
        type: 'https://github.com/poodlelab/ngrx-offline/problems/version-conflict',
        title: 'Version conflict',
        status: 412,
        detail: 'The entity changed after version 3.',
        instance: '/v1/place-visits/42',
        code: 'version_conflict',
        requestId: 'request-123',
      }).code,
    ).toBe('version_conflict');
  });
});
