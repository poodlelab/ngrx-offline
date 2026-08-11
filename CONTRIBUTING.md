# Contributing to NgRx Offline

Thank you for helping improve NgRx Offline. The project welcomes focused bug
reports, design feedback, documentation improvements, and code contributions.

## Before opening a pull request

For substantial public API or architecture changes, open an issue first. This
avoids investing in an approach that conflicts with the project's durable-data
or compatibility guarantees.

Security vulnerabilities must follow [SECURITY.md](./SECURITY.md) and must not
be reported in public issues.

## AI-assisted contributions

AI-assisted contributions are welcome, but contributors remain responsible for
the code they submit and should be able to explain, test, and maintain it. The
same review, licensing, security, and quality requirements apply regardless of
which tools were used to produce a contribution.

## Development setup

The repository pins its expected Node.js and pnpm versions.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Use `pnpm format` to apply the repository formatting rules.

## Architecture boundaries

- `core` is framework-independent and cannot import Angular, NgRx, IndexedDB,
  DOM APIs, or application code.
- `indexeddb` can depend on `core`, but not Angular or NgRx.
- `worker` can depend on `core` and `indexeddb`, but not Angular or NgRx.
- `testing` contains deterministic framework-independent test utilities.
- The primary entry point contains Angular and NgRx integration.
- Reducers remain pure. Storage, network, locking, and timers belong outside
  reducers and meta-reducers.

ESLint enforces the most important dependency boundaries. Reviewers should
also reject indirect coupling through globals or application-specific types.

## Tests

Changes should be tested at the narrowest useful layer:

- deterministic unit tests for the core engine;
- IndexedDB integration tests for persistence and transactions;
- adapter tests for NgRx lifecycle behavior;
- Playwright tests for browser and cross-context guarantees;
- API contract tests for server idempotency and scope isolation.

Bug fixes should include a regression test when practical.

## Public API changes

Every exported API is tracked by API Extractor. After an intentional public API
change, run:

```bash
pnpm build
pnpm api:report
```

Review and commit the resulting report changes. Add a changeset for changes to
the published package:

```bash
pnpm changeset
```

## Pull requests

- Keep changes focused.
- Explain the user-visible behavior and architectural consequences.
- Update documentation alongside behavior.
- Do not commit generated build output, credentials, or personal demo data.
- Ensure `pnpm check` passes before requesting review.

By participating, you agree to follow [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
