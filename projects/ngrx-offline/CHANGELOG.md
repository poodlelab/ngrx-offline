# @poodlelab/ngrx-offline

## 0.1.0-alpha.0

### Minor Changes

- Add a concise `defineOfflineCreate` API, automatic tagged-reference discovery,
  default operation versions, and optional NgRx action sources. Keep the explicit
  operation-definition callbacks as advanced overrides. Automatically schedule a
  non-blocking, coalesced foreground replay after an online enqueue commits.
