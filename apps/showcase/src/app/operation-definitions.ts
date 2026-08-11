import {
  OfflineReference,
  TransportResponse,
  defineOfflineCreate,
} from '@poodlelab/ngrx-offline/core';

export interface CreateTripInput {
  readonly clientId: string;
  readonly title: string;
  readonly destination: string;
  readonly startDate: string;
}
export interface CreateTravelDayInput {
  readonly clientId: string;
  readonly trip: OfflineReference;
  readonly date: string;
  readonly title: string;
  readonly summary: string;
}
export interface CreatePlaceVisitInput {
  readonly clientId: string;
  readonly travelDay: OfflineReference;
  readonly name: string;
  readonly city: string;
  readonly countryCode: string;
  readonly arrivedAt: string;
}
export interface CreateMemoryInput {
  readonly clientId: string;
  readonly placeVisit: OfflineReference;
  readonly title: string;
  readonly body: string;
  readonly category: 'moment' | 'place' | 'sound' | 'taste';
  readonly sortOrder: number;
}
export interface CreateDayReflectionInput {
  readonly clientId: string;
  readonly travelDay: OfflineReference;
  readonly body: string;
  readonly mood: 'calm' | 'curious' | 'radiant' | 'tired';
  readonly weather: string;
  readonly clientCreatedAt: string;
}
export interface CreatedEntity {
  readonly id: number;
  readonly clientId: string;
  readonly version: number;
}

const retryPolicy = {
  initialDelayMs: 1_000,
  maximumDelayMs: 15_000,
  multiplier: 2,
  jitter: 'none' as const,
  maximumAttempts: 5,
};

export const tripDefinition = defineOfflineCreate<CreateTripInput, CreatedEntity>({
  kind: 'journal.trip.create',
  entity: 'trip',
  lane: () => 'journal-foundation',
  request: (input) => ({
    method: 'POST',
    url: '/v1/trips',
    body: {
      clientId: input.clientId,
      title: input.title,
      destination: input.destination,
      startDate: input.startDate,
    },
  }),
  parseResult,
  retryPolicy,
});

export const travelDayDefinition = defineOfflineCreate<CreateTravelDayInput, CreatedEntity>({
  kind: 'journal.travel-day.create',
  entity: 'travel-day',
  lane: () => 'journal-foundation',
  request: (input, context) => ({
    method: 'POST',
    url: '/v1/travel-days',
    body: {
      clientId: input.clientId,
      tripId: context.resolve(input.trip),
      date: input.date,
      title: input.title,
      summary: input.summary,
    },
  }),
  parseResult,
  retryPolicy,
});

export const placeVisitDefinition = defineOfflineCreate<CreatePlaceVisitInput, CreatedEntity>({
  kind: 'journal.place-visit.create',
  entity: 'place-visit',
  lane: () => 'journal-route',
  request: (input, context) => ({
    method: 'POST',
    url: '/v1/place-visits',
    body: {
      clientId: input.clientId,
      travelDayId: context.resolve(input.travelDay),
      name: input.name,
      city: input.city,
      countryCode: input.countryCode,
      arrivedAt: input.arrivedAt,
    },
  }),
  parseResult,
  retryPolicy,
});

export const memoryDefinition = defineOfflineCreate<CreateMemoryInput, CreatedEntity>({
  kind: 'journal.memory.create',
  entity: 'memory',
  lane: () => 'journal-route',
  request: (input, context) => ({
    method: 'POST',
    url: '/v1/memories',
    body: {
      clientId: input.clientId,
      placeVisitId: context.resolve(input.placeVisit),
      title: input.title,
      body: input.body,
      category: input.category,
      sortOrder: input.sortOrder,
    },
  }),
  parseResult,
  retryPolicy,
});

export const dayReflectionDefinition = defineOfflineCreate<CreateDayReflectionInput, CreatedEntity>(
  {
    kind: 'journal.day-reflection.create',
    entity: 'day-reflection',
    lane: () => 'journal-reflection',
    request: (input, context) => ({
      method: 'POST',
      url: '/v1/day-reflections',
      body: {
        clientId: input.clientId,
        travelDayId: context.resolve(input.travelDay),
        body: input.body,
        mood: input.mood,
        weather: input.weather,
        clientCreatedAt: input.clientCreatedAt,
      },
    }),
    parseResult,
    retryPolicy,
  },
);

export const showcaseOperationDefinitions = [
  tripDefinition,
  travelDayDefinition,
  placeVisitDefinition,
  memoryDefinition,
  dayReflectionDefinition,
] as const;

function parseResult(response: TransportResponse): CreatedEntity {
  const value = response.body;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !('clientId' in value) ||
    !('version' in value) ||
    typeof value.id !== 'number' ||
    typeof value.clientId !== 'string' ||
    typeof value.version !== 'number'
  )
    throw new Error('The journal API returned an invalid entity response.');
  return { id: value.id, clientId: value.clientId, version: value.version };
}
