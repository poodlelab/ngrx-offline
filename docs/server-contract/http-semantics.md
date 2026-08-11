# HTTP semantics

## Transport

The API is JSON over HTTPS. All request and response bodies use UTF-8. Successful
JSON responses use `application/json`; failures use `application/problem+json`.
Unknown object properties are rejected instead of silently ignored.

All routes live below `/v1`. The only unauthenticated operations are health and
demo-workspace registration.

## Workspace authentication

Authenticated requests use:

```http
Authorization: Bearer <workspace UUID>.<base64url secret>
```

The UUID identifies the data pool. The independently generated high-entropy
secret authorizes access. Authentication failure always returns a generic
`401 workspace_unauthorized`, whether the UUID is unknown, expired, or has the
wrong secret, to avoid an existence oracle.

## Idempotency

Every domain mutation requires:

```http
Idempotency-Key: <operation UUID>
```

The key is unique inside a workspace. The server computes a canonical request
fingerprint from:

- HTTP method;
- normalized route including the numeric resource ID;
- normalized JSON body;
- `If-Match` when present.

Authorization, tracing, user-agent, CORS, and transport headers are excluded.
Object keys are sorted before hashing; numeric and string values are not
coerced.

The server atomically stores the fingerprint and successful mutation result,
including status, response body, `Location`, and `ETag`. A later request with
the same workspace, key, and fingerprint receives the original result and:

```http
Idempotency-Replayed: true
```

A key reused with another fingerprint returns
`409 idempotency_key_reused`. Validation, authentication, rate-limit, and
precondition failures are not stored as successful receipts and may be retried
after correction with the same key. Domain conflicts are not stored because the
application may resolve state and retry a replacement operation.

The reference implementation must serialize concurrent first use of the same
key. Two concurrent equivalent requests may not execute two domain mutations.

## Optimistic concurrency

Create responses begin with `version: 1` and `ETag: "1"`. Every PATCH requires
a strong `If-Match` header:

```http
If-Match: "3"
```

If the header does not match the current entity version, the server returns
`412 version_conflict`. The failure detail may include sanitized current-version
metadata, but the full current entity is not returned automatically. A
successful update increments the version exactly once and returns the new ETag.

Idempotency lookup occurs before evaluating the current precondition. This is
necessary when the original update committed but its response was lost: replay
must return the stored success even though the entity version has advanced.

## Status codes

- `200`: successful read, update, reset, or recovered workspace registration.
- `201`: newly registered workspace or newly created domain entity.
- `204`: idempotent removal of an armed test behavior.
- `400`: malformed JSON, header, path, cursor, or query value.
- `401`: invalid or expired workspace capability.
- `404`: resource not present in the active workspace.
- `409`: domain conflict, duplicate client ID, or idempotency-key misuse.
- `412`: stale `If-Match` precondition.
- `422`: valid JSON that fails field or cross-field validation.
- `429`: rate limit exceeded; includes `Retry-After`.
- `500`: unexpected server failure.
- `503`: transient failure used by the commit/response-loss test fallback.

A resource belonging to another workspace is reported as `404`, never `403`.

## Problem details

Failures follow RFC-style problem details with stable application codes:

```json
{
  "type": "https://github.com/poodlelab/ngrx-offline/problems/version-conflict",
  "title": "Version conflict",
  "status": 412,
  "detail": "The entity changed after version 3.",
  "instance": "/v1/place-visits/42",
  "code": "version_conflict",
  "requestId": "request-01J5..."
}
```

Validation failures may add an `errors` array with `path`, `code`, and a safe
message. Problem bodies never contain workspace secrets, raw authentication,
SQL text, stack traces, or records belonging to another workspace.

Stable initial codes include:

| HTTP | Code                     | Meaning                                    |
| ---- | ------------------------ | ------------------------------------------ |
| 400  | `invalid_request`        | Malformed request syntax or metadata       |
| 401  | `workspace_unauthorized` | Missing, invalid, or expired capability    |
| 404  | `resource_not_found`     | Resource absent in active workspace        |
| 409  | `idempotency_key_reused` | Key fingerprint differs                    |
| 409  | `client_id_exists`       | Entity kind already uses the client UUID   |
| 409  | `trip_archived`          | Travel Day cannot be added                 |
| 409  | `parent_unavailable`     | Parent cannot accept the requested child   |
| 409  | `trip_has_active_days`   | Trip cannot be archived                    |
| 409  | `day_has_planned_visits` | Travel Day cannot complete                 |
| 412  | `version_conflict`       | `If-Match` is stale                        |
| 422  | `validation_failed`      | Input violates schema or domain validation |
| 429  | `rate_limited`           | Request budget exhausted                   |
| 500  | `internal_error`         | Unexpected server error                    |

## Pagination and snapshots

List endpoints use opaque cursor pagination. `limit` defaults to 50 and is
bounded to 100. Cursors encode the stable ordering position and filter set; a
cursor used with different filters returns `400 invalid_cursor`.

`GET /snapshot` returns all demo entities from one consistent database view.
The configured workspace quotas keep this response bounded. It is the preferred
showcase bootstrap endpoint; list and detail endpoints remain in the contract
to demonstrate a realistic API and support targeted refreshes.

## Request ordering

The server does not understand offline references and does not reorder client
requests. It enforces ordinary foreign keys. The replay engine must resolve and
send the Trip before its Travel Day, the Travel Day before its Place Visit, and the
Place Visit before its children.
