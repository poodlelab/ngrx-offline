import { createOfflineMutation } from '@poodlelab/ngrx-offline';
import {
  dayReflectionDefinition,
  memoryDefinition,
  placeVisitDefinition,
  travelDayDefinition,
  tripDefinition,
} from './operation-definitions';

export type {
  CreatedEntity,
  CreateDayReflectionInput,
  CreateMemoryInput,
  CreatePlaceVisitInput,
  CreateTravelDayInput,
  CreateTripInput,
} from './operation-definitions';

export const tripMutation = createOfflineMutation(tripDefinition);
export const travelDayMutation = createOfflineMutation(travelDayDefinition);
export const placeVisitMutation = createOfflineMutation(placeVisitDefinition);
export const memoryMutation = createOfflineMutation(memoryDefinition);
export const dayReflectionMutation = createOfflineMutation(dayReflectionDefinition);

export const showcaseMutations = [
  tripMutation,
  travelDayMutation,
  placeVisitMutation,
  memoryMutation,
  dayReflectionMutation,
] as const;
