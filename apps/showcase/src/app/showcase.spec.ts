import { offlineRef } from '@poodlelab/ngrx-offline';
import { describe, expect, it } from 'vitest';
import { tripMutation, travelDayMutation, showcaseMutations } from './offline-definitions';
import { showcaseFeature } from './showcase.store';

describe('Phase 6 showcase integration', () => {
  it('starts optimism only after the durable queued lifecycle action', () => {
    const input = {
      clientId: 'trip-local',
      title: 'Lisbon in the margins',
      destination: 'Lisbon, Portugal',
      startDate: '2026-08-10',
    };
    const requested = showcaseFeature.reducer(undefined, tripMutation.requested({ input }));
    expect(requested.entities).toEqual([]);

    const queued = showcaseFeature.reducer(
      requested,
      tripMutation.queued({ input, operationId: 'operation-1', scope: 'workspace-a' }),
    );
    expect(queued.entities).toEqual([
      expect.objectContaining({
        clientId: 'trip-local',
        operationId: 'operation-1',
        state: 'queued',
      }),
    ]);

    const synchronized = showcaseFeature.reducer(
      queued,
      tripMutation.succeeded({
        operationId: 'operation-1',
        input,
        result: { id: 8421, clientId: input.clientId, version: 1 },
        scope: 'workspace-a',
      }),
    );
    expect(synchronized.entities[0]).toMatchObject({ serverId: 8421, state: 'synced' });
  });

  it('resolves a travel-day parent only while constructing the request', () => {
    const trip = offlineRef('trip', 'trip-local');
    const request = travelDayMutation.definition.request(
      {
        clientId: 'travel-day-local',
        trip,
        date: '2026-08-10',
        title: 'A slow morning in Alfama',
        summary: 'Climbed through tiled lanes before the city woke.',
      },
      {
        operationId: 'operation-2',
        scope: 'workspace-a',
        attempt: 1,
        resolve: (reference) => (reference.key === trip.key ? 7301 : 0),
      },
    );
    expect(request.body).toMatchObject({
      clientId: 'travel-day-local',
      tripId: 7301,
    });
  });

  it('rebuilds a synchronized entity from a durable worker receipt alone', () => {
    const input = {
      clientId: 'trip-local',
      title: 'Lisbon in the margins',
      destination: 'Lisbon, Portugal',
      startDate: '2026-08-10',
    };

    const restored = showcaseFeature.reducer(
      undefined,
      tripMutation.succeeded({
        operationId: 'operation-1',
        input,
        result: { id: 8421, clientId: input.clientId, version: 1 },
        scope: 'workspace-a',
      }),
    );

    expect(restored.entities).toEqual([
      expect.objectContaining({
        clientId: 'trip-local',
        operationId: 'operation-1',
        serverId: 8421,
        state: 'synced',
      }),
    ]);
  });

  it('registers the complete five-kind relationship workflow', () => {
    expect(showcaseMutations.map((mutation) => mutation.definition.kind)).toEqual([
      'journal.trip.create',
      'journal.travel-day.create',
      'journal.place-visit.create',
      'journal.memory.create',
      'journal.day-reflection.create',
    ]);
  });
});
