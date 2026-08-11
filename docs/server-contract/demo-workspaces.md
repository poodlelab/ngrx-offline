# Demo workspaces

## Capability creation

The browser creates these values using a cryptographically secure random source:

- a UUID v4 `workspaceId`;
- 32 random bytes encoded as unpadded base64url `secret`.

It registers them with `POST /v1/demo-workspaces`. The server stores the UUID
and a keyed hash of the secret, never the raw secret. The client stores the
capability outside NgRx DevTools and outside durable mutation inputs.

Registration behavior:

- unknown UUID: create and return `201`;
- existing UUID with matching secret: recover and return `200`;
- existing UUID with another secret: return `409 workspace_id_taken`.

This makes registration retry-safe if its first response is lost. The client
generates a new pair after `workspace_id_taken`.

## Isolation rules

Every domain, idempotency, test-control, and diagnostic row includes
`workspace_id`. Queries include the authenticated workspace in their predicate.
Foreign keys use workspace plus server ID, so a relation cannot target another
workspace accidentally.

The API must test isolation at the repository and HTTP layers. Supplying a
numeric ID owned by another workspace returns `404 resource_not_found`.
References, idempotency keys, client IDs, cursors, request counts, and armed
failure behavior are all workspace-local.

## Expiration and reset

A workspace expires seven days after its latest recorded activity. To reduce
write amplification, the server may update `last_active_at` at most once per
hour. Expiration therefore has a maximum one-hour scheduling tolerance.

A scheduled Worker task deletes expired workspace data in bounded batches.
Deleting the workspace cascades to domain records, idempotency receipts, armed
behaviors, and diagnostics.

`POST /v1/demo-workspaces/reset` deletes those child records transactionally
but retains the workspace and secret. It is safe to repeat and is not queued by
the offline library.

## Quotas and limits

Initial per-workspace limits:

| Resource             | Maximum |
| -------------------- | ------: |
| Trips                |      50 |
| Travel Days          |     100 |
| Place Visits         |     250 |
| Memories             |   1,000 |
| Day Reflections      |   1,000 |
| Armed test behaviors |      20 |
| Request body         |  64 KiB |

The default request budget is 120 requests per minute per workspace with a
burst allowance of 30. Registration also receives an origin/IP-oriented abuse
limit so attackers cannot create unlimited workspaces. Production values may be
lowered without changing domain semantics.

Quota exhaustion returns `409 workspace_quota_exceeded`; transient request-rate
exhaustion returns `429 rate_limited` with `Retry-After`.

## Retention and privacy

- Demo data is not intended for personal or confidential information.
- Workspace data and idempotency results expire with the workspace.
- Sanitized operational diagnostics are retained no longer than 30 days.
- Request bodies and authorization headers are excluded from normal logs.
- Workspace IDs may appear in structured logs; secrets never do.
- The showcase warns users that the environment is public demonstration
  infrastructure and offers an immediate Reset action.

## CORS

Production allows the exact origin:

```text
https://poodlelab.github.io
```

Local development allows:

```text
http://localhost:4200
http://127.0.0.1:4200
```

No wildcard origin is used with Authorization. Preflight permits `GET`, `POST`,
`PATCH`, `DELETE`, and `OPTIONS`, plus these request headers:

- `Authorization`
- `Content-Type`
- `Idempotency-Key`
- `If-Match`

Responses expose:

- `ETag`
- `Idempotency-Replayed`
- `Location`
- `Retry-After`
- `X-Request-Id`

Preflight responses are cached for at most one hour. Disallowed origins receive
no CORS allow-origin header.
