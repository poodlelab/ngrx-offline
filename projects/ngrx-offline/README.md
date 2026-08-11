# @poodlelab/ngrx-offline

Durable, optimistic, offline mutation handling for Angular applications that
use NgRx.

[Try the live Atlas Journal showcase](https://poodlelab.github.io/ngrx-offline/).

Most offline support stops at caching screens or retrying one request. Real
applications also need to create related records before server IDs exist. NgRx
Offline persists those mutations and resolves their local references during
replay. Application code continues to dispatch actions, update reducers, run
effects, and select state through the usual NgRx workflow. Optimistic updates
begin with the durable `queued` action instead of the initial `requested`
action.

## Alpha status

NgRx Offline is ready for evaluation, but it is not yet recommended for
production use. Public APIs may change before 1.0. If it solves a problem in
your application, please share your use case, missing requirements, or API
feedback in the
[repository](https://github.com/poodlelab/ngrx-offline). Continued development
toward a stable release will be guided by real-world use and contributor
interest.

## Install

```bash
pnpm add @poodlelab/ngrx-offline@alpha
```

Entry points:

- `@poodlelab/ngrx-offline`
- `@poodlelab/ngrx-offline/core`
- `@poodlelab/ngrx-offline/indexeddb`
- `@poodlelab/ngrx-offline/worker`
- `@poodlelab/ngrx-offline/testing`

They provide the deterministic replay
state machine, durable browser persistence, typed lifecycle actions, foreground
and optional service-worker synchronization, explicit offline relationships,
cross-context coordination, durable receipts, and deterministic test ports.

## Quick example

```ts
import { createOfflineMutation, defineOfflineCreate } from '@poodlelab/ngrx-offline';

const createTrip = defineOfflineCreate<CreateTrip, CreatedTrip>({
  kind: 'journal.trip.create',
  entity: 'trip',
  request: (input) => ({ method: 'POST', url: '/api/trips', body: input }),
});

export const tripMutation = createOfflineMutation(createTrip);
```

For conventional `{ clientId }` inputs and `{ id }` results, version 1 and the
complete client-to-server ID mapping are automatic. Tagged offline references
inside an input are also discovered automatically.

## License

MIT
