# Travel journal domain and offline relationships

## Purpose

Atlas Journal uses a travel story because it naturally creates related records
where connectivity is unreliable. The model is deep enough to demonstrate
dependency ordering and ID reconciliation, while remaining easy to understand.

```text
Demo workspace
└── Trip
    └── Travel day
        ├── Place visit
        │   └── Memory × 3
        └── Day reflection
```

A Travel Day belongs to one Trip. A Place Visit belongs to one Travel Day.
Memories belong to a Place Visit, while a Day Reflection branches directly
from the Travel Day. Cross-workspace relations are rejected even when numeric
server IDs happen to match.

## Identity and versioning

Every entity carries a client-generated UUID in `clientId` and a server-generated
positive integer in `id`. The client ID is created before enqueue and survives
reloads; the server ID exists only after synchronization. The database enforces
uniqueness on `(workspace_id, client_id)` for every entity table.

Every entity starts at version `1`. A successful update increments the version
and returns the matching strong ETag, for example `ETag: "2"`. Create and update
timestamps are server-generated UTC values. Day Reflections additionally retain
`clientCreatedAt`, preserving when the traveler wrote them offline.

## Entities

### Trip

The root journal journey.

- Required: `clientId`, `title`, `destination`, and `startDate`.
- Status: `planned`, `travelling`, `complete`, or `archived`.
- A Trip cannot be archived while it has an incomplete Travel Day.

### Travel Day

A dated chapter within a Trip.

- Required: `clientId`, resolved numeric `tripId`, `date`, and `title`.
- Optional: `summary`.
- Status: `planned`, `in_progress`, or `complete`.
- A Travel Day cannot be completed while it has a planned Place Visit.

### Place Visit

A location visited during a Travel Day.

- Required: `clientId`, resolved numeric `travelDayId`, `name`, `city`, and
  two-letter `countryCode`.
- Optional: `arrivedAt`.
- Status: `planned`, `visited`, or `skipped`.

### Memory

An ordered journal fragment belonging to a Place Visit.

- Required: `clientId`, resolved numeric `placeVisitId`, `title`, `body`,
  `category`, and `sortOrder`.
- Category: `place`, `taste`, `sound`, or `moment`.

### Day Reflection

The traveler's evening reflection, belonging directly to a Travel Day.

- Required: `clientId`, resolved numeric `travelDayId`, `body`, `mood`, and
  `clientCreatedAt`.
- Optional: `weather`.
- Mood: `radiant`, `calm`, `curious`, or `tired`.

Exact lengths, formats, nullability, and response shapes are executable in
`apps/demo-api/src/contracts.ts` and published as generated JSON Schemas.

## Offline references

Durable operation inputs store symbolic parent identities. Request builders
resolve them only immediately before transport execution.

```ts
const trip = offlineRef('trip', tripClientId);
const day = offlineRef('travel-day', travelDayClientId);
const place = offlineRef('place-visit', placeVisitClientId);

tripMutation.requested({
  input: {
    clientId: tripClientId,
    title: 'Lisbon in the margins',
    destination: 'Lisbon, Portugal',
    startDate: '2026-08-10',
  },
});

travelDayMutation.requested({
  input: {
    clientId: travelDayClientId,
    trip,
    date: '2026-08-10',
    title: 'A slow morning in Alfama',
    summary: 'Climbed through tiled lanes before the city woke.',
  },
});

placeVisitMutation.requested({
  input: {
    clientId: placeVisitClientId,
    travelDay: day,
    name: 'Miradouro da Senhora do Monte',
    city: 'Lisbon',
    countryCode: 'PT',
    arrivedAt: '2026-08-10T08:30:00.000Z',
  },
});
```

When the Trip succeeds, it produces `trip:<clientId> → <server id>`. The
Travel Day can then build an HTTP request with a numeric `tripId`. The same
sequence continues through Place Visit and Memories. Day Reflection waits only
for Travel Day, so the two branches can replay concurrently.

The HTTP schemas accept numeric parent IDs only. Sending an unresolved reference
object is a validation error, keeping reference interpretation in the replay
engine rather than the server.

## Operation kinds and lanes

| Operation             | Kind                            | Lane                 | Dependency  | Produced reference       |
| --------------------- | ------------------------------- | -------------------- | ----------- | ------------------------ |
| Create Trip           | `journal.trip.create`           | `journal-foundation` | none        | `trip:<clientId>`        |
| Create Travel Day     | `journal.travel-day.create`     | `journal-foundation` | Trip        | `travel-day:<clientId>`  |
| Create Place Visit    | `journal.place-visit.create`    | `journal-route`      | Travel Day  | `place-visit:<clientId>` |
| Create Memory         | `journal.memory.create`         | `journal-route`      | Place Visit | none                     |
| Create Day Reflection | `journal.day-reflection.create` | `journal-reflection` | Travel Day  | none                     |

The shared route lane preserves Memory ordering. The reflection lane makes the
parallel branch visible without weakening dependency guarantees.
