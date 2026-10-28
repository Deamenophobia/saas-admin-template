# Extraction provenance

All source repositories were read without modifying their working trees. This template
is released under MIT with the owner's authorization, retaining the Kokoro copyright
and licenses/crypto-payment-core-MIT.txt notice. This release does not change the
licenses of the original source repositories. Better Auth,
Keycloak and ZITADEL remain design references; their implementation was not copied.

| Source | Pinned revision | Reused / adapted areas |
|---|---|---|
| [kokoro-account](https://gitlab.com/kokoro-tech/platform/kokoro-account) | `ce874c7c79bebbdf863d086d87dad3c1cecbe044` | Express startup, Prisma client, registration/verification/reset flow, email transports, safe user selection/admin routes, audit; OauthAccount mapping and transactional external-user creation adapted for OIDC |
| [kokoro-pipeline](https://github.com/happykokoro/kokoro-pipeline) | `84172148e81b64400e21abb29b6447375b0f8163` | Organization/membership model, org creation/list/update, membership authorization and roles |
| [kokoro-auth](https://gitlab.com/kokoro-tech/platform/kokoro-auth) | `40cf49866790d21726421ed0cae8c3f88c9d7323` | Direct crypto helpers; API-key lifecycle; one-use authorization-code pattern adapted to persisted client flows; provider discovery/JWT implementation checked for compatibility |
| [crypto-payment-core](https://gitlab.com/kokoro-tech/platform/crypto-payment-core) | `a28a06cbb3478943ee257e1abd524db12a5930ec` | Direct canonicalJson helper reuse; transactional event enqueue adapted from src/events.ts; credential purposes, key lifecycle, idempotent commands and URL-validation patterns |
| kokoro-pipeline local snapshot | `2eafb8bbe83535bda5cda2753aeee4c58c42c23d` | Reviewed middleware/plan-gate.ts, resource-limit.ts and services/plan-limits.ts; generalized the tenant feature gate into EntitlementProvider, leaving plan names/limits in product code |

The account source itself attributes earlier extraction to pipeline commits
`5df9f43` and `b0f7632`. Those historical references are preserved here.

OIDC protocol validation uses the pinned openid-client 6.8.8 dependency (MIT), not a
handwritten protocol implementation. Existing hashing, encryption, MFA, sessions and
audit remain reused. The new client adapter/flow storage and explicit-linking policy
are template additions. The original auth provider needs PKCE changes before use;
pipeline's local SSO configuration endpoints were inspected but not mistaken for a
complete client login implementation. See SSO.md for the concrete compatibility gaps.

## Changes necessary for generalization

- Configurable issuer, key prefix, application URLs, mail sender, expiry and provider endpoint.
- No product-name whitelist, product subscriptions or brand-specific role checks.
- Tenant-owned credentials and organization-scoped roles; human identity stays global.
- Hashed one-time tokens, atomic consumption, replay-resistant MFA, revocable sessions.
- Validated request bodies, scoped queries, transactional audits and last-owner protection.
- The account source's supplied external-key storage and auth source's issued API keys
  are separate credential types; they are not treated as interchangeable.
- Source routes/services are adapted rather than copied unchanged. The repository makes
  no percentage-reuse claim; the crypto files are the largest unchanged code portion.

## Standards consulted

Kokoro constitution, API-STANDARDS.md, DATA-STANDARDS.md, and source CLAUDE.md files.
The user's explicit direction narrows validation to a few critical integration flows.
CI activation and production deployment remain separate operator decisions.
