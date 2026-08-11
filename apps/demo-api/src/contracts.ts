import { z } from 'zod';

export const uuidSchema = z.string().uuid();
export const serverIdSchema = z.int().positive().max(Number.MAX_SAFE_INTEGER);
export const versionSchema = z.int().positive();
export const timestampSchema = z.string().datetime({ offset: true });
export const dateSchema = z.string().date();
export const clientIdSchema = uuidSchema;
export const workspaceSecretSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Must be an unpadded base64url value.');

const entityTimestamps = { createdAt: timestampSchema, updatedAt: timestampSchema };
const entityIdentity = {
  id: serverIdSchema,
  clientId: clientIdSchema,
  version: versionSchema,
};
const optionalText = (maximum: number) =>
  z.string().trim().min(1).max(maximum).nullable().optional();
const nonEmptyUpdate = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z
    .object(shape)
    .strict()
    .refine((value) => Object.keys(value).length > 0, 'At least one field is required.');

export const tripStatusSchema = z.enum(['planned', 'travelling', 'complete', 'archived']);
export const travelDayStatusSchema = z.enum(['planned', 'in_progress', 'complete']);
export const placeVisitStatusSchema = z.enum(['planned', 'visited', 'skipped']);
export const memoryCategorySchema = z.enum(['place', 'taste', 'sound', 'moment']);
export const reflectionMoodSchema = z.enum(['radiant', 'calm', 'curious', 'tired']);

export const createTripRequestSchema = z
  .object({
    clientId: clientIdSchema,
    title: z.string().trim().min(1).max(120),
    destination: z.string().trim().min(1).max(120),
    startDate: dateSchema,
  })
  .strict();
export const updateTripRequestSchema = nonEmptyUpdate({
  title: z.string().trim().min(1).max(120).optional(),
  destination: z.string().trim().min(1).max(120).optional(),
  startDate: dateSchema.optional(),
  status: tripStatusSchema.optional(),
});
export const tripSchema = z
  .object({
    ...entityIdentity,
    ...entityTimestamps,
    title: z.string(),
    destination: z.string(),
    startDate: dateSchema,
    status: tripStatusSchema,
  })
  .strict();

export const createTravelDayRequestSchema = z
  .object({
    clientId: clientIdSchema,
    tripId: serverIdSchema,
    date: dateSchema,
    title: z.string().trim().min(1).max(120),
    summary: optionalText(1000),
  })
  .strict();
export const updateTravelDayRequestSchema = nonEmptyUpdate({
  date: dateSchema.optional(),
  title: z.string().trim().min(1).max(120).optional(),
  summary: optionalText(1000),
  status: travelDayStatusSchema.optional(),
});
export const travelDaySchema = z
  .object({
    ...entityIdentity,
    ...entityTimestamps,
    tripId: serverIdSchema,
    date: dateSchema,
    title: z.string(),
    summary: z.string().nullable(),
    status: travelDayStatusSchema,
  })
  .strict();

export const createPlaceVisitRequestSchema = z
  .object({
    clientId: clientIdSchema,
    travelDayId: serverIdSchema,
    name: z.string().trim().min(1).max(160),
    city: z.string().trim().min(1).max(100),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    arrivedAt: timestampSchema.nullable().optional(),
  })
  .strict();
export const updatePlaceVisitRequestSchema = nonEmptyUpdate({
  name: z.string().trim().min(1).max(160).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  arrivedAt: timestampSchema.nullable().optional(),
  status: placeVisitStatusSchema.optional(),
});
export const placeVisitSchema = z
  .object({
    ...entityIdentity,
    ...entityTimestamps,
    travelDayId: serverIdSchema,
    name: z.string(),
    city: z.string(),
    countryCode: z.string(),
    arrivedAt: timestampSchema.nullable(),
    status: placeVisitStatusSchema,
  })
  .strict();

export const createMemoryRequestSchema = z
  .object({
    clientId: clientIdSchema,
    placeVisitId: serverIdSchema,
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(4000),
    category: memoryCategorySchema,
    sortOrder: z.int().min(0).max(10_000),
  })
  .strict();
export const updateMemoryRequestSchema = nonEmptyUpdate({
  title: z.string().trim().min(1).max(160).optional(),
  body: z.string().trim().min(1).max(4000).optional(),
  category: memoryCategorySchema.optional(),
  sortOrder: z.int().min(0).max(10_000).optional(),
});
export const memorySchema = z
  .object({
    ...entityIdentity,
    ...entityTimestamps,
    placeVisitId: serverIdSchema,
    title: z.string(),
    body: z.string(),
    category: memoryCategorySchema,
    sortOrder: z.int(),
  })
  .strict();

export const createDayReflectionRequestSchema = z
  .object({
    clientId: clientIdSchema,
    travelDayId: serverIdSchema,
    body: z.string().trim().min(1).max(8000),
    mood: reflectionMoodSchema,
    weather: optionalText(120),
    clientCreatedAt: timestampSchema,
  })
  .strict();
export const updateDayReflectionRequestSchema = nonEmptyUpdate({
  body: z.string().trim().min(1).max(8000).optional(),
  mood: reflectionMoodSchema.optional(),
  weather: optionalText(120),
});
export const dayReflectionSchema = z
  .object({
    ...entityIdentity,
    ...entityTimestamps,
    travelDayId: serverIdSchema,
    body: z.string(),
    mood: reflectionMoodSchema,
    weather: z.string().nullable(),
    clientCreatedAt: timestampSchema,
  })
  .strict();

export const pageInfoSchema = z.object({ nextCursor: z.string().min(1).nullable() }).strict();
const listSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), page: pageInfoSchema }).strict();
export const tripListSchema = listSchema(tripSchema);
export const travelDayListSchema = listSchema(travelDaySchema);
export const placeVisitListSchema = listSchema(placeVisitSchema);
export const memoryListSchema = listSchema(memorySchema);
export const dayReflectionListSchema = listSchema(dayReflectionSchema);
export const snapshotSchema = z
  .object({
    trips: z.array(tripSchema),
    travelDays: z.array(travelDaySchema),
    placeVisits: z.array(placeVisitSchema),
    memories: z.array(memorySchema),
    dayReflections: z.array(dayReflectionSchema),
    generatedAt: timestampSchema,
  })
  .strict();

export const registerWorkspaceRequestSchema = z
  .object({ workspaceId: uuidSchema, secret: workspaceSecretSchema })
  .strict();
export const workspaceSchema = z
  .object({ workspaceId: uuidSchema, expiresAt: timestampSchema })
  .strict();
export const workspaceResetSchema = z
  .object({ workspaceId: uuidSchema, resetAt: timestampSchema })
  .strict();
export const healthSchema = z
  .object({ status: z.literal('ok'), version: z.string().min(1), time: timestampSchema })
  .strict();
export const versionInfoSchema = z
  .object({ version: z.string().min(1), compatibilityDate: z.string().date() })
  .strict();
export const problemDetailsSchema = z
  .object({
    type: z.string().url(),
    title: z.string().min(1),
    status: z.int().min(400).max(599),
    detail: z.string().min(1),
    instance: z.string().min(1),
    code: z.string().regex(/^[a-z0-9_]+$/),
    requestId: z.string().min(1),
    errors: z
      .array(z.object({ path: z.string(), code: z.string(), message: z.string() }).strict())
      .optional(),
  })
  .strict();

export const testBehaviorSchema = z.enum([
  'timeout',
  'commit_then_disconnect',
  'conflict_409',
  'precondition_412',
  'validation_422',
  'server_error_500',
]);
export const configureTestBehaviorRequestSchema = z
  .object({
    idempotencyKey: uuidSchema,
    behavior: testBehaviorSchema,
    delayMs: z.int().min(0).max(30_000).optional(),
  })
  .strict();
export const configuredTestBehaviorSchema = z
  .object({ idempotencyKey: uuidSchema, behavior: testBehaviorSchema, armed: z.boolean() })
  .strict();
export const requestDiagnosticSchema = z
  .object({
    idempotencyKey: uuidSchema,
    deliveries: z.int().min(0),
    mutations: z.int().min(0),
    updatedAt: timestampSchema.nullable(),
  })
  .strict();

export const offlineEntityKindSchema = z.enum([
  'trip',
  'travel-day',
  'place-visit',
  'memory',
  'day-reflection',
]);
const offlineReferenceFor = <Kind extends z.ZodLiteral<string>>(kind: Kind) =>
  z.object({ type: z.literal('offline-reference'), kind, clientId: clientIdSchema }).strict();
export const tripReferenceSchema = offlineReferenceFor(z.literal('trip'));
export const travelDayReferenceSchema = offlineReferenceFor(z.literal('travel-day'));
export const placeVisitReferenceSchema = offlineReferenceFor(z.literal('place-visit'));

export const createTripOperationInputSchema = z.object({ trip: createTripRequestSchema }).strict();
export const createTravelDayOperationInputSchema = z
  .object({
    travelDay: createTravelDayRequestSchema.omit({ tripId: true }),
    trip: tripReferenceSchema,
  })
  .strict();
export const createPlaceVisitOperationInputSchema = z
  .object({
    placeVisit: createPlaceVisitRequestSchema.omit({ travelDayId: true }),
    travelDay: travelDayReferenceSchema,
  })
  .strict();
export const createMemoryOperationInputSchema = z
  .object({
    memory: createMemoryRequestSchema.omit({ placeVisitId: true }),
    placeVisit: placeVisitReferenceSchema,
  })
  .strict();
export const createDayReflectionOperationInputSchema = z
  .object({
    dayReflection: createDayReflectionRequestSchema.omit({ travelDayId: true }),
    travelDay: travelDayReferenceSchema,
  })
  .strict();

export const contractSchemas = {
  ConfigureTestBehaviorRequest: configureTestBehaviorRequestSchema,
  ConfiguredTestBehavior: configuredTestBehaviorSchema,
  CreateDayReflectionOperationInput: createDayReflectionOperationInputSchema,
  CreateDayReflectionRequest: createDayReflectionRequestSchema,
  CreateMemoryOperationInput: createMemoryOperationInputSchema,
  CreateMemoryRequest: createMemoryRequestSchema,
  CreatePlaceVisitOperationInput: createPlaceVisitOperationInputSchema,
  CreatePlaceVisitRequest: createPlaceVisitRequestSchema,
  CreateTravelDayOperationInput: createTravelDayOperationInputSchema,
  CreateTravelDayRequest: createTravelDayRequestSchema,
  CreateTripOperationInput: createTripOperationInputSchema,
  CreateTripRequest: createTripRequestSchema,
  DayReflection: dayReflectionSchema,
  DayReflectionList: dayReflectionListSchema,
  Health: healthSchema,
  Memory: memorySchema,
  MemoryList: memoryListSchema,
  PlaceVisit: placeVisitSchema,
  PlaceVisitList: placeVisitListSchema,
  ProblemDetails: problemDetailsSchema,
  RequestDiagnostic: requestDiagnosticSchema,
  RegisterWorkspaceRequest: registerWorkspaceRequestSchema,
  Snapshot: snapshotSchema,
  TravelDay: travelDaySchema,
  TravelDayList: travelDayListSchema,
  Trip: tripSchema,
  TripList: tripListSchema,
  UpdateDayReflectionRequest: updateDayReflectionRequestSchema,
  UpdateMemoryRequest: updateMemoryRequestSchema,
  UpdatePlaceVisitRequest: updatePlaceVisitRequestSchema,
  UpdateTravelDayRequest: updateTravelDayRequestSchema,
  UpdateTripRequest: updateTripRequestSchema,
  VersionInfo: versionInfoSchema,
  Workspace: workspaceSchema,
  WorkspaceReset: workspaceResetSchema,
} as const;

export type Trip = z.infer<typeof tripSchema>;
export type TravelDay = z.infer<typeof travelDaySchema>;
export type PlaceVisit = z.infer<typeof placeVisitSchema>;
export type Memory = z.infer<typeof memorySchema>;
export type DayReflection = z.infer<typeof dayReflectionSchema>;
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
