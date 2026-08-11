---
'@poodlelab/ngrx-offline': minor
---

Add a concise `defineOfflineCreate` API, automatic tagged-reference discovery,
default operation versions, and optional NgRx action sources. Keep the explicit
operation-definition callbacks as advanced overrides. Automatically schedule a
non-blocking, coalesced foreground replay after an online enqueue commits.
