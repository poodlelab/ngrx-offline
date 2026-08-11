# Phase 1 acceptance cases

These cases are normative inputs for Phase 5 API tests and later Playwright
tests.

## Identity and relationships

| Given                                                  | When                                                                   | Then                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| No server IDs are known                                | Trip, Travel Day, Place Visit, and Memory operation inputs are created | Every child stores a typed parent reference and all inputs validate |
| A Travel Day operation still contains a Trip reference | Its HTTP request is validated                                          | Validation fails because `tripId` must be a positive integer        |
| Trip create succeeds with ID 10                        | Travel Day request is built                                            | `trip:<clientId>` resolves to `tripId: 10`                          |
| Two workspaces have server record ID 10                | Workspace A fetches its record                                         | Only A's record is visible                                          |
| A parent numeric ID belongs to another workspace       | A child create is attempted                                            | `404 resource_not_found`; no relationship is created                |

## Idempotency

| Given                                      | When                                         | Then                                                                         |
| ------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------- |
| A new key and valid create request         | Request commits                              | Entity and stored success are committed atomically                           |
| The response is lost after commit          | Equivalent request repeats with the same key | Original `201`, body, Location, and ETag replay; no second entity is created |
| A stored key                               | Another payload uses it                      | `409 idempotency_key_reused`                                                 |
| Two equivalent first deliveries race       | Both reach the API                           | One mutation occurs and both observe the same logical result                 |
| A validation or conflict response occurred | Corrected operation uses its key             | No stored success prevents evaluation of the corrected request               |

## Concurrency and conflicts

| Given                                                    | When                                         | Then                                                  |
| -------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------- |
| Entity version is 3                                      | PATCH uses `If-Match: "3"`                   | Update succeeds, version becomes 4, ETag is `"4"`     |
| Entity version is 4                                      | PATCH uses `If-Match: "3"`                   | `412 version_conflict`; entity is unchanged           |
| Original version-3 PATCH committed but response was lost | Same request repeats after version reached 4 | Stored success replays before precondition evaluation |
| Travel Day has a planned Place Visit                     | Completion is requested                      | `409 day_has_planned_visits`                          |
| Trip has an incomplete Travel Day                        | Archival is requested                        | `409 trip_has_active_days`                            |

## Workspaces and lifecycle

| Given                                   | When                            | Then                                                               |
| --------------------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| Unknown UUID and valid secret           | Workspace registers             | `201`, seven-day expiry returned, only a secret hash is stored     |
| Existing UUID and matching secret       | Registration repeats            | `200` with the same workspace                                      |
| Existing UUID and another secret        | Registration is attempted       | `409 workspace_id_taken`                                           |
| Invalid, unknown, or expired capability | Protected resource is requested | Identical `401 workspace_unauthorized` shape                       |
| Workspace is reset twice                | Both calls finish               | Both succeed; workspace remains and domain data is empty           |
| Workspace is inactive beyond retention  | Cleanup runs                    | Domain, idempotency, test-control, and diagnostic data are removed |

## Failures and limits

| Given                                     | When                                  | Then                                                                   |
| ----------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `commit_then_disconnect` is armed         | Matching operation is delivered twice | First response is unavailable, second replays; one mutation is counted |
| `server_error_500` is armed               | Matching operation executes           | One `500` occurs without commit; later retry can succeed               |
| Record quota is reached                   | Another record is created             | `409 workspace_quota_exceeded` without mutation                        |
| Request rate is exceeded                  | Another request arrives               | `429 rate_limited` with `Retry-After`                                  |
| GitHub Pages origin preflights a mutation | Required headers are requested        | Exact origin, methods, and headers are allowed                         |
| An unlisted origin preflights             | Preflight is evaluated                | No allow-origin header is returned                                     |
