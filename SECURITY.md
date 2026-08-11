# Security Policy

## Supported versions

During the pre-1.0 alpha, security fixes apply to the latest published alpha and
the default branch. A supported-version table will be added before the first
stable release.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature for this repository:

<https://github.com/poodlelab/ngrx-offline/security/advisories/new>

Do not open a public issue for a suspected vulnerability. Include the affected
version or commit, impact, reproduction steps, and any suggested mitigation.

Maintainers should acknowledge a report within seven days and provide a status
update within fourteen days. Resolution time depends on severity and the need
to coordinate a release.

## Security model

IndexedDB data is accessible to JavaScript executing in the same origin. This
library does not protect an application against cross-site scripting. In
particular, consumers must not persist bearer tokens, authentication headers,
or other short-lived credentials in operation inputs.
