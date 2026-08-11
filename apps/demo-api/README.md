# Reference API

This Cloudflare Worker and D1 service backs the Atlas Journal showcase. It is
deliberately small, anonymous, isolated by demo workspace, and disposable. It
exists to exercise the guarantees of `@poodlelab/ngrx-offline`; it is not a
general-purpose backend or part of the npm package.

The normative HTTP and behavioral contract is in
[`docs/server-contract`](../../docs/server-contract/README.md). Runtime input
and output validation uses the Zod schemas in `src/contracts.ts`.

## Local development

From the repository root:

```bash
cp apps/demo-api/.dev.vars.example apps/demo-api/.dev.vars
# Replace SECRET_HASH_KEY with at least 32 random characters.
pnpm api:migrate:local
pnpm api:dev
```

Wrangler serves the API at `http://localhost:8787`. Local D1 state stays in
Wrangler's ignored local state directory. The configured CORS origins are
`http://localhost:4200`, `http://127.0.0.1:4200`, and the exact GitHub Pages
origin in `wrangler.jsonc`.

Useful checks:

```bash
pnpm test:api             # Real Worker runtime and local D1 acceptance tests
pnpm contract:check       # Generated schemas and OpenAPI validation
pnpm typecheck:contracts  # Contract, Worker, and Worker-test type checks
pnpm api:types            # Regenerate worker-configuration.d.ts
```

The tests apply `migrations/*.sql` to an isolated D1 database. They cover the
complete relation chain, cross-workspace isolation, atomic idempotency,
optimistic concurrency, quotas, cleanup, reset, CORS, and deterministic
failures.

## Production configuration

1. Authenticate Wrangler and create the database:

   ```bash
   pnpm exec wrangler login
   pnpm exec wrangler d1 create ngrx-offline-demo
   ```

2. Replace the placeholder `database_id` in `wrangler.jsonc` with the ID from
   that command. Set `GITHUB_PAGES_ORIGIN` to the deployed site's exact origin
   if it differs from `https://poodlelab.github.io`.

3. Add a secret containing at least 32 random characters:

   ```bash
   pnpm exec wrangler secret put SECRET_HASH_KEY --config apps/demo-api/wrangler.jsonc
   ```

4. Migrate and deploy:

   ```bash
   pnpm api:migrate:remote
   pnpm api:deploy
   ```

The D1 database ID is configuration, not a credential, and may be committed in
`wrangler.jsonc`. Never commit `.dev.vars` or `SECRET_HASH_KEY`. After
deployment, verify `/v1/health`, `/v1/version`, registration, and one
authenticated snapshot request from both the local showcase and the GitHub
Pages origin.

## Runtime configuration

| Setting                    | Default   | Purpose                                     |
| -------------------------- | --------- | ------------------------------------------- |
| `API_VERSION`              | `0.1.0`   | Reported contract/service version           |
| `GITHUB_PAGES_ORIGIN`      | travelDay | Exact production browser origin             |
| `WORKSPACE_RETENTION_DAYS` | `7`       | Sliding demo-workspace lifetime             |
| `REQUESTS_PER_MINUTE`      | `150`     | Per-workspace fixed-window request budget   |
| `SECRET_HASH_KEY`          | secret    | HMAC key used to protect capability secrets |

Optional environment variables can lower individual domain and test-behavior
quotas; see `src/env-extensions.d.ts`. The hourly cron deletes expired
workspaces in bounded batches. D1 foreign keys cascade their domain data,
idempotency receipts, failure controls, and diagnostics.

## Safety and privacy

The service stores no account profile and never stores the raw workspace
secret. Authorization headers and request bodies are excluded from structured
logs. Users must not enter personal, confidential, or production information:
this is public demonstration infrastructure. Reset removes a workspace's demo
records immediately; inactivity removes the whole pool after the configured
retention period.
