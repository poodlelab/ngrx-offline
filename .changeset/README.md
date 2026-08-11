# Changesets

Add a changeset for every pull request that changes the published package:

```bash
pnpm changeset
```

Documentation, test-only, and repository-maintenance changes do not require a
changeset unless they affect the published contract.
