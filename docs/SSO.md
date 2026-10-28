# OIDC sign-in (0.3)

This template is an OIDC client: an existing identity provider authenticates the user,
and the backend issues its normal revocable bearer session. It is not an OIDC issuer.
Providers are configured by the operator for the whole application, not by customer
organizations. Default configuration enables no providers and makes no discovery calls.

## Configuration

Register a confidential authorization-code client with your provider. Configure its
exact redirect URI to your frontend's callback page. Put the following JSON in the
`OIDC_PROVIDERS` environment variable, or pass the same array as `createApp({ oidcProviders })`:

```json
[
  {
    "id": "company",
    "label": "Company SSO",
    "issuer": "https://id.example.com",
    "clientId": "registered-client-id",
    "clientSecret": "replace-with-secret-from-provider",
    "redirectUri": "https://app.example.com/auth/callback",
    "tokenAuthMethod": "client_secret_post"
  }
]
```

`tokenAuthMethod` also supports `client_secret_basic`. Provider IDs must remain stable.
Keep client secrets in deployment secret storage; there is no HTTP configuration API.
Issuer URLs must match discovery exactly. Use a specific tenant issuer for enterprise
providers; wildcard/common-tenant issuer substitution is not implemented.

This adapter requires discovery, an advertised S256 PKCE capability, a JWKS endpoint,
and RS256 ID tokens. New-account creation additionally requires an ID-token email and
`email_verified: true`. Providers that omit these claims can authenticate identities
explicitly linked to existing local accounts. There is no implicit email trust override
or UserInfo fallback. Review each provider's actual metadata/claims before enabling it.

All URLs require HTTPS. For local development only, `allowInsecureLocalhost: true`
permits HTTP on localhost/127.0.0.1/::1; it never permits remote HTTP or production HTTP.
Discovery/token/JWKS redirects are refused. Client secrets and upstream tokens never
appear in API responses, audit payloads or persisted identity rows.

## API flow

1. `GET /api/v1/auth/sso/providers` returns provider IDs and labels.
2. `POST /api/v1/auth/sso/{provider}/start` with `{}` returns `authorizationUrl`,
   `flowToken`, and `expiresAt`. Keep `flowToken` in the initiating browser tab or your
   trusted application session; never put it in a URL or accept it from callback query data.
3. Navigate to `authorizationUrl`. The provider returns `code`, `state` and possibly
   `iss` to the configured frontend callback. This is a frontend page, not the completion API.
4. The frontend posts `{ code, state, flowToken, iss? }` to
   `/api/v1/auth/sso/{provider}/complete`. A normal result is the existing
   `{ token, tokenType: "Bearer", expiresAt }` response. Local sessions remain hash-only
   at rest. No token is placed in a redirect URL.
5. If local MFA is enrolled, completion returns HTTP 202 with
   `{ mfaRequired: true, challengeToken, expiresAt }`. Post `{ challengeToken, code }`
   to `/api/v1/auth/sso/mfa` using a TOTP or unused recovery code. No usable session is
   issued until MFA succeeds. The challenge has a persisted attempt budget and expiry.

`examples/sso-client.mjs` demonstrates browser-tab binding and callback parameter
removal using the existing API client. It returns the login result for your frontend
to handle; it does not store the bearer session or provide a login UI. Handle provider
cancel/error responses locally and start again. Set a restrictive referrer policy on
the callback page and remove callback parameters before loading third-party resources.

SSO flows are one-use, including a failed exchange. After a timeout, invalid response
or changed provider configuration, restart sign-in rather than retrying the old code.
Flows survive API process restarts in PostgreSQL; PKCE verifiers use the existing
AES-GCM field encryption. State and browser-binding secrets are stored only as hashes.
Expired flows/challenges are pruned opportunistically when new flows/challenges are
created. Deployments may add a scheduled cleanup using their retention policy.

## Linking and account boundaries

External identities are keyed by issuer and subject, following the original account
repo's provider-account mapping. Provider email changes never move an existing identity
to another local account, nor do provider role/admin claims grant local permissions.

For an existing local user:

- Sign in normally, then call `POST /api/v1/me/sso/{provider}/link/start` with a bearer
  user session and `{ password, code? }`. Current local password, verified local email
  and any enrolled MFA are required. Finish the same redirect/completion flow; the
  response is `{ linked: true }`, with no new login session. The initiating local
  session must still be active at completion.
- `GET /api/v1/me/sso` lists your linked identities.
- `DELETE /api/v1/me/sso/{id}` with `{ password, code? }` unlinks your identity and
  revokes sessions and pending MFA challenges issued from that identity. Your verified
  local password login remains usable. SSO-only users cannot unlink their sole method.

There is no same-email auto-linking. If a new external subject claims an existing
local email, login returns `SSO_LINK_REQUIRED`. An identity already linked to someone
else cannot be reassigned. One account per provider per local user is supported.

Automatic SSO signup follows `ALLOW_REGISTRATION`. A new SSO user has no local password,
no organizations and no elevated role. Invitations and membership APIs remain the only
normal ways to join a tenant. Suspended users cannot sign in, and tenant suspension and
membership checks apply to SSO sessions exactly as they do to password sessions.

For SSO-only accounts, password login/recovery and password-protected local MFA/linking
management are unavailable. Configure MFA/recovery at the identity provider. Linked
local accounts retain their local MFA requirement even if the provider reports MFA.
With registration disabled, onboard through the existing invitation/local-account flow
and explicitly link SSO. SSO-only invitation signup is not implemented in this phase.

## Session and protocol limits

Logout revokes the local session; it does not log out of the provider. Disabling a
provider configuration stops new SSO logins, but existing local sessions retain their
configured expiry unless revoked. Changes made only at the provider do not push local
revocation. OIDC logout notifications, upstream refresh tokens, SAML, SCIM, per-tenant
connections, domain discovery, mandatory SSO and automatic organization provisioning
are outside this phase.

Identity and protocol requirements are based on [OIDC claim stability](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability).
The adapter uses [openid-client](https://github.com/panva/openid-client) for protocol
validation, with [signature verification enabled](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md),
state, nonce, PKCE and fixed configured redirect URIs. It reuses existing template
session, hashing, encryption, MFA and audit services instead of adding another session stack.

## Original-repository compatibility and verification

The pinned Kokoro Auth revision has discovery, authorization-code exchange, nonce and
RS256 ID-token generation. Its code does not process PKCE challenges/verifiers or
advertise S256, and its ID tokens omit `email_verified`. Therefore it does not yet meet
this adapter's requirements. Upgrade that provider separately before connecting it;
do not disable verification to make the old snapshot appear compatible. The pipeline
snapshot's SSO routes configure metadata but do not implement this client login flow.
Neither source repository was changed by this phase.

Two integration scenarios use PostgreSQL and a local signed OIDC simulator. They cover
binding/state, replay/expiry, signature/nonce/issuer/audience checks, email collisions,
account suspension, tenant/privilege isolation, linking, local MFA attempts/recovery and
unlink revocation. No live Google, Entra or Kokoro login has been performed. Deploy
migration 004 before starting 0.3; existing password accounts retain their behavior.
