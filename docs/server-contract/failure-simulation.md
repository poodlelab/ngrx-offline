# Deterministic failure simulation

## Purpose

The reference API provides workspace-scoped controls for demonstrating and
testing recovery behavior without making normal endpoints randomly unreliable.
Controls are disabled unless explicitly armed and cannot affect another
workspace.

## Arming behavior

The client first chooses the operation UUID it will use as `Idempotency-Key`,
then calls:

```http
POST /v1/test-controls/behaviors
Authorization: Bearer <workspace capability>
Content-Type: application/json

{
  "idempotencyKey": "66666666-6666-4666-8666-666666666666",
  "behavior": "commit_then_disconnect"
}
```

Only the next matching domain mutation in that workspace consumes the armed
behavior. Re-arming the same key replaces the existing behavior. DELETE removes
it idempotently. Controls expire with the workspace and count toward a small
quota.

## Behaviors

### `timeout`

The server delays the matching response by `delayMs`, defaulting to 10 seconds
and capped at 30 seconds. The demo configures a shorter operation timeout. The
mutation does not commit before the delay ends, so a retry is safe and executes
normally after the one-shot behavior is consumed.

### `commit_then_disconnect`

The server commits the mutation and its idempotency result atomically, then
prevents the first success response from reaching the client. The preferred
implementation terminates or suppresses the response stream. If the hosting
runtime cannot guarantee that behavior, it delays the response beyond the demo
client timeout and returns a transient `503` only after the durable commit.

The next request with the same key and fingerprint returns the stored original
success with `Idempotency-Replayed: true`. Request-count diagnostics must prove
that one domain mutation occurred even though two deliveries were observed.

### `conflict_409`

Returns `409 forced_conflict` without committing or storing an idempotency
success. It demonstrates application-controlled conflict repair.

### `precondition_412`

Returns `412 forced_precondition_failure` without committing. It demonstrates
stale entity-version handling independently of concurrent test setup.

### `validation_422`

Returns `422 forced_validation_failure` without committing. It demonstrates a
permanent application failure and blocked operation.

### `server_error_500`

Returns `500 forced_server_error` without committing. The library classifies it
as retryable and uses its configured backoff.

## Safety

- Production domain endpoints never accept a magic failure header or query
  parameter.
- Controls require a valid workspace capability.
- Behavior lookup includes both workspace and idempotency key.
- Failure bodies contain no secrets or raw stored payloads.
- Rate limits apply to control and domain endpoints.
- The showcase labels forced failures clearly so they are not mistaken for
  service health incidents.
