# Product extension contract (0.2)

The core owns identity, memberships, sessions, API keys and tenant access. Product
extensions own their tables, feature rules and HTTP operations. Register trusted
application code through `createApp({ extensions, entitlements })`; customers cannot
upload code or alter this policy through the API. All API instances must load the
same extensions. No plugin runtime, message broker or microservice split is required.

For an existing 0.1 template database, deploy migration 003 before starting 0.2. Custom
credential adapters must now declare their contract version/capabilities and accept
the versioned context; HTTP provisioners receive an added `contractVersion` field.
Update any `onEvent` callback from the old audit-shaped payload to the envelope below.

## Permissions and APIs

`ProductExtension` in `src/extensions/contracts.ts` declares resource/action permissions,
their grants to OWNER/ADMIN/MEMBER/VIEWER, routes and optional lifecycle hooks. Core
permissions cannot be overwritten. Unknown scopes and duplicate registrations fail
closed. Tenant-defined custom roles remain deferred.

Routes mount under `/api/v1/orgs/{orgId}/extensions/{extensionId}`. The wrapper applies
authentication, current membership, organization suspension, permission checks and the
intersection with API-key scopes. Mutations run through the existing serializable
transaction and recheck credentials/membership before the product handler executes.
The context supplies the transaction, organization ID, optional human user ID and
`emit`. Service-account requests have no human user ID. Always constrain product
queries by the context organization ID. This is trusted server code, not a SQL sandbox.

Every route declares its request/response OpenAPI schemas and validates input in its
handler. `/openapi.json` incorporates registered routes and product API-key scopes.
`/api/v1/orgs/{orgId}/capabilities` exposes the caller's effective permissions, extension
IDs and configured adapter capabilities. `entitlements: true` means an adapter is
configured; it does not mean every feature is enabled for that tenant.

## Product data and lifecycle

Keep product tables and migrations alongside the product; reference organization IDs
with foreign keys. Installing an extension on an existing database requires its own
backfill for existing organizations. Core identity migrations contain no demo tables.

Transactional hooks cover organization creation/suspension/resumption, membership
addition/removal and global user suspension/resumption. They receive `(db, event)` and
must perform local database work only. A hook failure rolls back identity/product
changes, audit records and queued events together. Do external IO through the outbox.
The organization creator is identified by `organization.created.data.ownerId`;
membership events include membership `resourceId`, `userId` and `role`. User lifecycle
events are global (`organizationId: null`) and include the affected `userId`.

Platform administrators suspend/resume a tenant with
`PATCH /api/v1/admin/organizations/{id}` and `{ "suspended": true | false }`.
Suspension blocks tenant routes and invitation acceptance. It pauses access without
revoking keys; resumption permits otherwise-valid credentials again. Membership
removal still permanently revokes that member's organization keys. Neither action
automatically revokes externally provisioned credentials; an adapter can react to
the corresponding event. Accepted provider operations still record their real result.

Permanent organization/account deletion, retention and export need a product-specific
policy. No destructive purge endpoint or legal-retention promise is included.

## Durable events

Mutation events use `{ id, version: 1, type, occurredAt, organizationId, actorId, data }`.
They are inserted into `integration_events` in the same transaction as the mutation,
following crypto-payment-core's transactional enqueue pattern. Audit IDs and event IDs
match. Product event types use their extension prefix, such as `team.project_created`.
Keep payloads small and exclude secrets, credentials, email bodies and user input.
Version 1 consumers should tolerate extra fields and unknown event types. Breaking
payload changes require a new version/type; stored envelopes are not rewritten.

Call `dispatchEvents(sender, { limit, leaseMs, retryMs })` from your application's worker
or operator command. It claims persisted rows, invokes the sender outside transactions,
and records delivery or retry eligibility. An expired lease is recoverable; lease tokens
prevent an older attempt from acknowledging a newer claim. The sender receives an
AbortSignal and must honor it for network IO. Failures persist no raw exception text.

Delivery is at least once, with no ordering guarantee. Deduplicate by event ID, including
the crash-after-send-before-ack case. There is one logical subscriber; fan-out destinations
need independent deduplication and must all succeed before the sender resolves. No
automatic scheduler, HTTP webhook transport, dead-letter policy or pruning job is
installed. The operator must run the dispatcher and monitor pending rows/attempts.

`onEvent` remains an optional, nonblocking after-commit notification with the new envelope;
it is not delivery acknowledgment. Use it for a wake-up or local observation, not a
second copy of the dispatcher's external side effect. `/orgs/{orgId}/events` is a paged
inspection API requiring `audit.read`, not a lossless polling cursor. Access-denial audit
records are not emitted as domain events. Existing 0.1 audits are not backfilled.

## Optional capabilities

`EntitlementProvider` version 1 answers whether a tenant may use a named feature from
local persisted state. Missing adapters deny gated features; adapter errors return 503
without executing the product operation. A billing or subscription adapter can update
that state independently. Plans, prices and payment methods never enter auth logic.
Resource quotas belong in product transactions, as shown by the API-service example.
Site-wide OIDC sign-in is available separately (SSO.md). Organization-managed SSO,
SAML and billing remain future integrations.

The credential-provider contract now declares version 1 and supported `issue`/`revoke`
actions. Unsupported actions return 503 before creating an operation. Its existing
durable idempotency/retry behavior is retained; see PROVIDERS.md.

## Two small examples

`examples/extensions/team.ts` creates tenant projects, initializes a welcome project on
organization creation, and clears assignments when a member leaves. `api-service.ts`
has tenant usage counters, a feature entitlement and a transactional quota. Neither
imports a payment module or changes core identity routes. Both can run in the same app.

For a fresh local demo database, configure `.env` as in README, then run:

```sh
npm run db:migrate
npx tsx examples/extensions/migrate.ts
npx tsx examples/extensions/server.ts
```

Create an organization through the normal API. Its API-service entitlement starts off.
An operator can enable `demo_api_usage.enabled` for that organization in the database;
the demo intentionally has no customer-controlled entitlement-granting endpoint.
The example quota is a total call allowance, not a billing ledger or a daily rate limit.
Each successful POST consumes one call; retrying it consumes another call.

One additional PostgreSQL/HTTP scenario covers both examples, hook rollback, scopes,
tenant boundaries, entitlement failure, quota enforcement, suspension, member cleanup,
event retry and worker lease recovery. No extra unit-test suite was introduced.
