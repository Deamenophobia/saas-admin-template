# Focused extraction review — 2026-10-29

Review scope: source comparison, API scenarios, reusable packaging, extension
boundaries and OIDC client sign-in. Live provider verification is separate deployment work.

## Credential-lifecycle reference

crypto-payment-core is the clearest existing credential-lifecycle reference:

- `src/crypto.ts`: purpose-separated checkout/voucher credentials and canonical JSON.
- `src/services/credentials.ts`: active key fingerprints, old-key verification,
  revocation and explicit voucher reissue with a generation counter.
- `src/services/vouchers.ts`: one-time redemption, ownership of retries, expiry,
  refund freeze/revocation checks under a transaction.
- `src/operations.ts`: request fingerprint, idempotency conflict and transactional audit.

These are payment access/redemption credentials. They are distinct from the template's
login sessions and reusable API keys. A payment voucher must not automatically become
an unrestricted login credential. Any future entitlement bridge needs an explicit,
tenant-scoped exchange contract. No payment engine or voucher redemption was copied
into this stage. The canonicalJson utility is directly reused with its MIT notice.

## Source-to-template comparison

| Concern | Original behavior / source | Template decision |
|---|---|---|
| Tenant ownership | pipeline Organization + Membership, four member roles | Preserved with tenant-scoped API access and UUID database mappings |
| User lifecycle | account registration, verification, reset, safe admin selection | Adapted; hashed one-time tokens and session revocation |
| Authentication | account Passport/cookies; auth RS256/JWKS/refresh tokens | Opaque online-verified bearer sessions; deliberate contract change, not drop-in SSO compatibility |
| Crypto helpers | auth Argon2id, random API keys, TOTP, AES-GCM | Direct extraction; configurable product identity and mandatory encryption key |
| Credentials | auth issued API keys; account stored external secrets | Separate hash-only issued keys and encrypted retrievable external secrets |
| Payment credentials | purpose, key fingerprint, generation and redemption | Reference for boundaries and lifecycle; payment semantics stay in payment-core |

No original source repository was modified. This is a focused author review, not an
independent security audit or proof that all behavior of the source repos was preserved.

## Gaps corrected in the new template

1. MFA enrollment read credentials and wrote the pending secret outside the shared
   mutation transaction. It now rechecks session/account state, validates the password,
   prevents active-MFA replacement and records the enrollment audit atomically.
2. External work was only fully reauthorized when recording its result. It is now
   authorized while claiming the operation, before provider IO. Completion records the
   actual accepted effect even if the initiating session is revoked during the call.
3. Provisioner URLs accepted embedded credentials/query/fragment. The template now
   applies the payment source's stricter operator URL boundary.
4. Request fingerprints now use the payment source's stable JSON helper. Existing
   template fingerprints remain accepted for the same request during transition.

## Evidence

- TypeScript build passes.
- Five existing PostgreSQL/HTTP regression scenarios pass; no new unit-test suite.
- Existing scenarios now assert active-MFA reenrollment denial and durable provider
  completion when the caller's session is revoked in flight.
- `npm run scenario` passes five steps against compiled JavaScript: two organizations;
  new-user invitation/sign-in; scoped credential access; tenant-safe member offboarding;
  service-key rotation/revocation and audit.
- The scenario uses local captured email and no live payment/VPN service.

## Remaining boundaries

The source OIDC issuer/JWT protocols are not implemented by this template. Keyring rotation
for encrypted fields, runtime custom roles, shared rate-limit storage, HTTP webhook transport,
data retention and real provider connectors remain explicit follow-up decisions in
SCOPE.md. No production deployment was performed.

## General-purpose extensibility phase (0.2)

The next approved phase adds product permissions/routes without editing auth internals,
transactional lifecycle hooks, organization suspension, optional entitlement gates,
versioned provider capabilities, and durable domain events with an operator-invoked
dispatcher. Every core success response now has an explicit OpenAPI schema; extension
routes contribute their own schemas at startup. Billing and SSO remain optional future
integrations, not completed systems.

The payment repository's small transactional enqueue function supplies the outbox
pattern; pipeline's feature/plan gates supply the entitlement separation. Product tables
stay outside the core migrations. Team projects and a metered API demonstrate distinct
products using the same identity API. Original repositories remain unchanged.

One additional database/HTTP scenario verifies product-scope authorization and tenant
isolation, lifecycle rollback, member cleanup, tenant suspension including invitations,
entitlement failures and quota enforcement, stable event IDs on retries, and concurrent
worker/expired-lease behavior. Five existing regression scenarios and the compiled CLI
scenario remain in use. The demo migration parser initially failed on a semicolon in a
SQL comment; the comment and setup cleanup were corrected before the passing run.

## OIDC client sign-in phase (0.3)

The user selected sign-in through an existing OIDC provider. The implementation uses
openid-client for discovery, code exchange and JWT verification, while reusing original
account identity mapping and template hashing/session/MFA/audit services. PKCE verifiers
are encrypted in persisted one-use flows; callback completion requires a separate
browser-binding secret. Existing accounts are linked only after local password/MFA
proof, and email/role claims never silently merge accounts or grant local privileges.

New SSO-only accounts have a null local password and cannot use password recovery to
create a fallback password. Linked local accounts still complete local MFA before a
session is issued. Unlinking cascades revocation to the identity's sessions/challenges.
Two additional PostgreSQL/signed-provider scenarios pass. Provider configuration and
live provider verification remain deployment work. The pinned Kokoro Auth snapshot's
missing PKCE and verified-email claims are documented; original repos remain unchanged.

## Public preview preparation (0.3.1)

The owner authorized releasing this template under MIT. Source copyrights and the
payment-core MIT notice are retained; original repository licenses remain unchanged.
The release documents its pre-1.0 status and supplies contribution/security guidance.

The publication audit initially reported two high-severity dependency findings
(Nodemailer and Zod) and four low-severity dependency findings. Direct dependencies
and compatible transitive dependencies were updated. The resulting full npm audit
reported zero known vulnerabilities on 2026-10-29. A source scan found placeholders
and synthetic test credentials, with no obvious live secrets; this is not a guarantee
that every possible secret format has been detected. Local archives, dependencies,
build output and environment files are excluded from Git publication.
