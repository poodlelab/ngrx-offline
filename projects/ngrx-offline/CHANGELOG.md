# @poodlelab/ngrx-offline

## 0.1.0-alpha.1

### Patch Changes

- Link the deployed Atlas Journal showcase from the package README and make npm
  the primary installation example. Export a stable `OfflineOutboxFeature` type
  so generated public API reports are deterministic across operating systems.

## 0.1.0-alpha.0

### Minor Changes

- Add a concise `defineOfflineCreate` API, automatic tagged-reference discovery,
  default operation versions, and optional NgRx action sources. Keep the explicit
  operation-definition callbacks as advanced overrides. Automatically schedule a
  non-blocking, coalesced foreground replay after an online enqueue commits.
