# Reddit alpha announcement

## Suggested title

I built an alpha NgRx mutation outbox for relational offline workflows — looking for API feedback

## Post

I have been working on NgRx Offline, an open-source mutation outbox for Angular
applications that use NgRx.

The problem I wanted to solve is more involved than caching a screen or retrying
one failed request: an application can create a parent and several related
records while offline, before any of them have server IDs. The library stores
each mutation in IndexedDB, tracks the dependencies between them, resolves local
references as IDs arrive, and replays the requests in order. Application code
still follows the usual NgRx workflow with actions, reducers, effects, and
selectors; optimistic updates start from the durable `queued` action.

The travel-journal demo creates a trip, travel day, place, three memories, and a
reflection while offline. Turn on its offline simulator, save the journal, then
restore the connection to watch all seven records synchronize and their local
references become server IDs.

- Demo: https://poodlelab.github.io/ngrx-offline/
- Source and documentation: https://github.com/poodlelab/ngrx-offline
- npm: https://www.npmjs.com/package/@poodlelab/ngrx-offline

This is an alpha for evaluation, not something I recommend for production yet.
The current release targets Angular and NgRx 21 because that is their latest
mutually compatible stable line. Public APIs may change before 1.0.

I would particularly value feedback from Angular/NgRx users on three points:

1. Does the small `defineOfflineCreate` API feel natural in an NgRx codebase?
2. Which conflict, retry, and authentication policies would you need before
   considering this for a real application?
3. Is relational offline creation a problem you encounter often enough to want
   a focused library for it?

I am the author. If there is real interest and useful feedback, I plan to keep
developing it toward a stable release.

## Posting notes

- Use the suggested title as a text post and let the live demo be the first link
  in the body.
- Attach `docs/media/offline-relations-walkthrough.gif` if the subreddit permits
  media in text posts; otherwise the demo link is sufficient.
- Check the target subreddit's self-promotion rules immediately before posting.
- Stay available after posting to answer questions about scope, tradeoffs, and
  why this is an outbox rather than a local database.
