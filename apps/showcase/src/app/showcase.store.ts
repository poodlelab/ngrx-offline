import {
  createActionGroup,
  createFeature,
  createReducer,
  emptyProps,
  on,
  props,
} from '@ngrx/store';
import {
  dayReflectionMutation,
  memoryMutation,
  placeVisitMutation,
  travelDayMutation,
  tripMutation,
} from './offline-definitions';

export type EntityKind = 'Day reflection' | 'Memory' | 'Place visit' | 'Travel day' | 'Trip';
export type EntitySyncState = 'blocked' | 'executing' | 'queued' | 'synced';
export interface ShowcaseEntity {
  readonly clientId: string;
  readonly kind: EntityKind;
  readonly label: string;
  readonly operationId: string;
  readonly parentClientId: string | null;
  readonly serverId: number | null;
  readonly state: EntitySyncState;
  readonly failureCode: string | null;
}
export interface ShowcaseState {
  readonly entities: readonly ShowcaseEntity[];
}

export const ShowcaseActions = createActionGroup({
  source: 'Showcase UI',
  events: {
    'Discard Entity': props<{ readonly operationId: string }>(),
    'Reset View': emptyProps(),
  },
});
const initialState: ShowcaseState = { entities: [] };

export const showcaseFeature = createFeature({
  name: 'showcase',
  reducer: createReducer(
    initialState,
    on(tripMutation.queued, tripMutation.restored, (state, action) =>
      queued(state, action.operationId, {
        clientId: action.input.clientId,
        kind: 'Trip',
        label: action.input.title,
        parentClientId: null,
      }),
    ),
    on(travelDayMutation.queued, travelDayMutation.restored, (state, action) =>
      queued(state, action.operationId, {
        clientId: action.input.clientId,
        kind: 'Travel day',
        label: action.input.title,
        parentClientId: clientIdFromKey(action.input.trip.key),
      }),
    ),
    on(placeVisitMutation.queued, placeVisitMutation.restored, (state, action) =>
      queued(state, action.operationId, {
        clientId: action.input.clientId,
        kind: 'Place visit',
        label: action.input.name,
        parentClientId: clientIdFromKey(action.input.travelDay.key),
      }),
    ),
    on(memoryMutation.queued, memoryMutation.restored, (state, action) =>
      queued(state, action.operationId, {
        clientId: action.input.clientId,
        kind: 'Memory',
        label: action.input.title,
        parentClientId: clientIdFromKey(action.input.placeVisit.key),
      }),
    ),
    on(dayReflectionMutation.queued, dayReflectionMutation.restored, (state, action) =>
      queued(state, action.operationId, {
        clientId: action.input.clientId,
        kind: 'Day reflection',
        label: action.input.body,
        parentClientId: clientIdFromKey(action.input.travelDay.key),
      }),
    ),
    on(
      tripMutation.executionStarted,
      travelDayMutation.executionStarted,
      placeVisitMutation.executionStarted,
      memoryMutation.executionStarted,
      dayReflectionMutation.executionStarted,
      (state, { operationId }) => patchByOperation(state, operationId, { state: 'executing' }),
    ),
    on(
      tripMutation.retryScheduled,
      travelDayMutation.retryScheduled,
      placeVisitMutation.retryScheduled,
      memoryMutation.retryScheduled,
      dayReflectionMutation.retryScheduled,
      (state, { operationId, failure }) =>
        patchByOperation(state, operationId, { state: 'queued', failureCode: failure.code }),
    ),
    on(
      tripMutation.blocked,
      travelDayMutation.blocked,
      placeVisitMutation.blocked,
      memoryMutation.blocked,
      dayReflectionMutation.blocked,
      (state, { operationId, failure }) =>
        patchByOperation(state, operationId, { state: 'blocked', failureCode: failure.code }),
    ),
    on(tripMutation.succeeded, (state, action) =>
      succeeded(state, action.operationId, action.result.id, {
        clientId: action.input.clientId,
        kind: 'Trip',
        label: action.input.title,
        parentClientId: null,
      }),
    ),
    on(travelDayMutation.succeeded, (state, action) =>
      succeeded(state, action.operationId, action.result.id, {
        clientId: action.input.clientId,
        kind: 'Travel day',
        label: action.input.title,
        parentClientId: clientIdFromKey(action.input.trip.key),
      }),
    ),
    on(placeVisitMutation.succeeded, (state, action) =>
      succeeded(state, action.operationId, action.result.id, {
        clientId: action.input.clientId,
        kind: 'Place visit',
        label: action.input.name,
        parentClientId: clientIdFromKey(action.input.travelDay.key),
      }),
    ),
    on(memoryMutation.succeeded, (state, action) =>
      succeeded(state, action.operationId, action.result.id, {
        clientId: action.input.clientId,
        kind: 'Memory',
        label: action.input.title,
        parentClientId: clientIdFromKey(action.input.placeVisit.key),
      }),
    ),
    on(dayReflectionMutation.succeeded, (state, action) =>
      succeeded(state, action.operationId, action.result.id, {
        clientId: action.input.clientId,
        kind: 'Day reflection',
        label: action.input.body,
        parentClientId: clientIdFromKey(action.input.travelDay.key),
      }),
    ),
    on(
      tripMutation.cancelled,
      travelDayMutation.cancelled,
      placeVisitMutation.cancelled,
      memoryMutation.cancelled,
      dayReflectionMutation.cancelled,
      ShowcaseActions.discardEntity,
      (state, { operationId }) => ({
        ...state,
        entities: state.entities.filter((entity) => entity.operationId !== operationId),
      }),
    ),
    on(ShowcaseActions.resetView, () => initialState),
  ),
});

function queued(
  state: ShowcaseState,
  operationId: string,
  entity: Pick<ShowcaseEntity, 'clientId' | 'kind' | 'label' | 'parentClientId'>,
): ShowcaseState {
  return upsert(state, {
    ...entity,
    operationId,
    serverId: null,
    state: 'queued',
    failureCode: null,
  });
}
function succeeded(
  state: ShowcaseState,
  operationId: string,
  serverId: number,
  entity: Pick<ShowcaseEntity, 'clientId' | 'kind' | 'label' | 'parentClientId'>,
): ShowcaseState {
  return upsert(state, {
    ...entity,
    operationId,
    serverId,
    state: 'synced',
    failureCode: null,
  });
}
function upsert(state: ShowcaseState, entity: ShowcaseEntity): ShowcaseState {
  const existing = state.entities.findIndex((candidate) => candidate.clientId === entity.clientId);
  return {
    ...state,
    entities:
      existing === -1
        ? [...state.entities, entity]
        : state.entities.map((candidate, index) => (index === existing ? entity : candidate)),
  };
}
function patchByOperation(
  state: ShowcaseState,
  operationId: string,
  patch: Partial<ShowcaseEntity>,
): ShowcaseState {
  return {
    ...state,
    entities: state.entities.map((entity) =>
      entity.operationId === operationId ? { ...entity, ...patch } : entity,
    ),
  };
}
function clientIdFromKey(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}
