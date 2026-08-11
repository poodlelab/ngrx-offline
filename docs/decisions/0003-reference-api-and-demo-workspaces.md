# ADR-0003: Reference API and demo workspace isolation

- Status: Accepted
- Date: 2026-08-10

## Context

GitHub Pages can host the static showcase but not the stateful API required to
demonstrate idempotency, numeric server IDs, conflicts, and isolated test data.
Anonymous visitors need separate pools without creating user accounts.

## Decision

Build the reference API as a Cloudflare Worker backed by D1. The browser creates
a workspace UUID and a high-entropy secret, then registers them through
`POST /demo-workspaces`. The UUID is an identifier; the secret is the bearer
capability. Every domain row, idempotency record, query, and mutation is scoped
to the workspace.

Demo workspaces expire seven days after their most recent activity. The service
will enforce per-workspace record quotas, request-body limits, and rate limits.
It stores no intended personal information and exposes an authenticated reset
operation.

## Consequences

- The static showcase and API deploy separately and require explicit CORS.
- A client-generated UUID alone is not treated as authorization.
- D1 migrations and Worker deployment become part of the repository and release
  operations.
- Cloudflare credentials are required only for deployment, not local library
  development.
