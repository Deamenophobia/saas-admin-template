# Scope and implementation decisions

Execution mode: single agent. User priorities: reuse existing repositories, backend
and database first, organizations/isolation in v1, optional external provisioning,
minimal meaningful tests, no automatic publishing or CI activation.

## Reuse decisions

Keep the account/pipeline family’s Express + Prisma + PostgreSQL structure. Extract
its user, organization, membership, token, audit and administration patterns. Reuse
kokoro-auth's crypto helpers. Do not merge PHP/Laravel, Hono and Express runtimes.
Do not import FSES academic roles, product billing, frontend packages or pipeline jobs.

The new backend uses opaque bearer sessions stored as hashes in PostgreSQL. This
adapts the existing account Session model and auth token-hashing approach for API
clients. Optional OIDC client sign-in now exchanges external identity for the same
local sessions. Cookie/Passport sessions and acting as an OIDC issuer are not implemented.

Prisma property names remain camelCase for code reuse; database tables/columns map
to snake_case, IDs are UUIDs, timestamps use timestamptz, and the connection defaults
to the identity schema. Existing source response objects are retained for successes;
errors use the recorded Kokoro API envelope. New migrations are forward-only.
The initial schema is one bootstrap migration including its indexes and foreign keys;
later business constraints are separate migrations. No existing production database
is upgraded by this template; migration of existing users is not part of extraction.

## Important boundaries

- One database with explicit organization scoping and composite service-account FK.
  This version does not implement PostgreSQL row-level security or per-tenant databases.
- Fixed seed roles with product-registered resource permissions. Runtime custom-role editing is deferred.
- Password reset keeps MFA enabled. Backup codes recover MFA; there is no administrative
  MFA bypass. An account with no remaining factor requires an operator recovery policy.
- Auth throttling is in-process. Deploy one API process initially; a shared rate-limit
  store and per-account protection are required before scaling across instances.
- The default API trusts no forwarded proxy headers. Configure a reviewed proxy policy
  before exposing it behind a reverse proxy; otherwise throttling sees the proxy IP.
- Email and credentials are injectable delivery/provider interfaces. Transactional
  lifecycle hooks, versioned outbox events and a callable dispatcher support product
  integration. The operator runs delivery; no scheduler or webhook transport is installed.
  Optional onEvent notifications remain best-effort. See EXTENSIONS.md for semantics.
- Provider operations are durable and retriable, with leases and fencing. There is no
  background retry worker. Timed-out provider effects must be reconciled through the
  same provider idempotency key. Pending operations do not claim success.
  Accepted operations retain truthful completion state if their caller's session
  expires during external IO. New calls still require current authorization.
- Credential metadata currently supports an operator-configured external provider.
  VPN, cloud IAM and third-party account connectors require concrete adapters.
- Optional site-wide OIDC sign-in and explicit linking are implemented; see SSO.md.
  Per-organization enterprise connections, SAML, SCIM and mandatory SSO are deferred.
- Tenant suspension/resumption and member cleanup hooks are implemented. Permanent
  data deletion/retention policies, billing,
  bulk import/export and the admin UI are deferred.

## Acceptance evidence

TypeScript compilation, Prisma schema validation and migration deployment succeed.
Eight integration scenarios use actual PostgreSQL and HTTP requests. See tests/critical.test.ts,
tests/extensions.test.ts and tests/sso.test.ts. SSO added two focused scenarios, no unit-test suite.
External provisioning is tested against a local HTTP simulator, not a live VPN service.
The CLI scenario also exercises the compiled backend through the reusable API client.
The owner selected source review, complete local scenario and packaging for this stage;
live integration with crypto-payment or any other provider is deferred.
