# Contributing

Keep changes focused on reusable backend capabilities. Preserve tenant boundaries,
source attribution and the conventions in [AGENTS.md](AGENTS.md). Product-specific
features belong in extensions; new integrations should reuse existing services.

Use Node.js 22+ and a dedicated PostgreSQL test database whose name includes `test`:

```sh
npm ci
npm run db:generate
npm run build
npm run typecheck:examples
# Set TEST_DATABASE_URL to the dedicated test database.
npm test
npm run scenario
npm audit
```

Update OpenAPI/docs when changing a public contract. Add forward-only database
migrations and a focused regression scenario when behavior warrants one. Do not
commit local configuration, credentials, logs, dependencies or generated archives.
New contributions are licensed under this repository's MIT license.
