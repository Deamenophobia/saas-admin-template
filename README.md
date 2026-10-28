# SaaS Admin Backend Template

[![CI](https://github.com/Deamenophobia/saas-admin-template/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Deamenophobia/saas-admin-template/actions/workflows/ci.yml)

An extensible Express + Prisma + PostgreSQL backend for SaaS identity and administration,
extracted and adapted from the Kokoro repositories. MIT licensed.

**Pre-1.0 developer preview.** API and migration contracts may change. This is a
backend starting point; review the documented deployment boundaries for your product.

## Included

- Email registration, verification, invitation-based onboarding and password recovery.
- Opaque bearer sessions, session listing/revocation, TOTP MFA and one-use recovery codes.
- Optional OIDC sign-in, explicit identity linking and preservation of local MFA checks.
- Organizations and memberships; OWNER / ADMIN / MEMBER / VIEWER roles.
- User search, profile editing, platform-admin suspension/reactivation.
- Tenant-owned service accounts and scoped API keys with expiry, rotation and revocation.
- Optional external credential provisioning through an HTTP provider adapter.
- Idempotent provisioning operations, encrypted external secrets and tenant audit APIs.
- PostgreSQL migrations, structured API errors and an OpenAPI 3.1 document.
- Registered product permissions/routes, transactional lifecycle hooks and optional feature entitlements.
- Tenant suspension/resumption, versioned durable events and a callable outbox dispatcher.
- Two optional product examples: team projects and a metered API service.

This backend extraction is validated by eight integration scenarios.
It has not been deployed or independently security-audited. Frontend pages, billing,
SAML/SCIM, organization-managed SSO and concrete VPN providers remain outside this scope.

## Local setup

Node.js 22+ and PostgreSQL are required. Docker is optional.

```sh
npm ci
cp .env.example .env
# Set ENCRYPTION_KEY to a random secret (at least 32 characters).
# Set DATABASE_URL to your own PostgreSQL database.
npm run db:generate
npm run db:migrate
npm run dev
```

With Docker available, `docker compose up -d postgres mailpit` starts local
dependencies. The compose credentials are development-only. For local mail set
`EMAIL_FROM=admin@example.test`, `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`.
View messages at http://localhost:8025. Alternatively configure Resend or your SMTP.
Without an email transport, email-dependent operations report delivery failure;
verification resend and password recovery deliberately return a generic response.

The API binds to `127.0.0.1:4050` by default. Inspect `/health`, `/ready` and
`/openapi.json`. The JSON spec is also committed as `openapi.json` for API clients.
The email links point to configurable frontend URLs; no frontend is included.
An API client can submit the token from the email to the documented API endpoint.

## First user and API calls

1. `POST /api/v1/auth/register` with `email`, `name`, `password`.
2. Submit the emailed token to `POST /api/v1/auth/verify`.
3. `POST /api/v1/auth/login`; use the returned token as `Authorization: Bearer ...`.
4. `POST /api/v1/orgs` with `name` and `slug`. The creator becomes OWNER.
5. Invite users, assign roles and issue keys under `/api/v1/orgs/{orgId}/...`.

For invitation-only deployments set `ALLOW_REGISTRATION=false`. New invitees can
use `/api/v1/auth/invitations/register` with the invitation token, name and password.
Existing users sign in and call `/api/v1/invitations/accept`.

Optional platform administration: after creating a verified account, run
`npx tsx scripts/operator.ts your-email@example.com` on the operator's machine.
Organization administrators cannot grant themselves platform access.

## Access and revocation behavior

- A user can belong to several organizations. Every tenant URL checks current membership.
- Organization roles live on membership records. Platform-admin status never bypasses tenant checks.
- API-key scopes intersect with the owner's current organization role. Keys for service
  accounts are limited to their explicit scopes. Human-only actions require a session.
- Removing a member revokes that member's keys in that organization. Other memberships survive.
- Suspending a user or service account revokes its keys; reactivation does not restore them.
- Password change/reset revokes sessions. API keys have a separate lifecycle.
- Last-owner removal/demotion is rejected. Promote another member to OWNER before transferring ownership.
- Key creation returns plaintext once; the database holds a SHA-256 hash. Lost keys must be replaced.
- External secrets that must be retrieved are encrypted separately, and reveal operations are audited.

Register product permissions, routes and lifecycle hooks through `createApp({ extensions })`.
Use dedicated product models linked to organization IDs; auth internals need no edits.
See [docs/EXTENSIONS.md](docs/EXTENSIONS.md) for contracts, runnable examples and upgrade notes.

## Optional SSO

Configure `OIDC_PROVIDERS` or `createApp({ oidcProviders })` to accept sign-in from an
existing OIDC provider. No providers are enabled by default. See [docs/SSO.md](docs/SSO.md)
for the API flow, provider requirements, account linking, MFA and original-repo compatibility.
The frontend owns its callback page; `examples/sso-client.mjs` supplies an integration helper.

## Optional credential providers

Set `PROVISIONER_URL` and `PROVISIONER_TOKEN`, or supply a `CredentialProvider` to
`createApp`. The provided HTTP adapter calls your provisioner's `/issue` and `/revoke`.
No external service is enabled by default. See `docs/PROVIDERS.md` for the contract.

Use the same `Idempotency-Key` when retrying an operation. `PENDING` is polled through
the operation API; `FAILED` can be retried with the original body and key. Provider
rotation is currently revoke + issue with explicit separate operations; atomic
external rotation is provider-specific and is not advertised by this API.

## Focused validation

GitHub Actions runs the build, example type checks, migrations, eight integration
tests and compiled API scenario on Node.js 22 with PostgreSQL 16. It runs for pushes
and pull requests to `main`, and can also be started manually. The database is
disposable; email, credential provisioning and OIDC use local fixtures.

```sh
npm run build
npm run typecheck:examples
# Point TEST_DATABASE_URL at a dedicated database whose name includes "test".
npm test
npm run scenario
```

Tests create a random schema, apply the real migrations, exercise HTTP APIs and a
local fake provisioning server, then drop only that generated schema. They cover
auth/MFA replay, tenant isolation/offboarding, key scope/rotation/revocation,
provider retries/failure states, platform suspension, product extensions and OIDC sign-in. No unit-test expansion
or coverage target is imposed. Build output and lockfile are reproducible locally.

`npm run scenario` rebuilds the server, then executes one continuous onboarding-to-
revocation scenario against compiled JavaScript and a fresh PostgreSQL schema. It
uses captured email and local fixtures. It never connects to crypto-payment or a VPN.
Five original scenarios, one product-extension scenario and two SSO scenarios form the test suite;
the CLI scenario also serves as a readable API usage example.

For a real configured server, reuse `examples/api-client.mjs`. Set `API_BASE_URL`,
`API_TOKEN` and `ORGANIZATION_ID`, then run `node examples/read-organization.mjs`.
The client supports user-session or scoped API-key tokens and does not print secrets.

## Source package

On Windows, `npm run package:template` creates `release/saas-admin-template-0.3.1.zip`
and a SHA-256 checksum. The explicit allowlist includes source, migrations, examples,
docs, tests and the dependency lockfile. It excludes `.env`, credentials, database
files, Git metadata, logs and installed dependencies. Existing archives are preserved.
Extract into an empty directory and follow Local setup; no existing Kokoro repo is required.

See `docs/REVIEW.md` for the source comparison, corrected gaps and remaining boundaries.
See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Source provenance and licensing

Released under the [MIT license](LICENSE), retaining Kokoro copyright and the
crypto-payment-core notice under `licenses/`. See [source provenance](docs/PROVENANCE.md)
for source revisions and extraction decisions. Better Auth, Keycloak and ZITADEL were
design references only. `package.json` remains `private: true` to prevent accidental
npm publication; this does not restrict the public repository's MIT license.
