# External credential provider contract

`createApp({ provider })` accepts `CredentialProvider` from src/providers/credentials.ts.
`createApp({ sendMail })` similarly accepts a custom transactional email delivery function.
Both are code-level extension interfaces; callers cannot change them through HTTP.
Providers declare `contractVersion: 1` and a `capabilities` array containing supported
`issue`/`revoke` actions. The default adapter advertises no actions when unconfigured.
An unsupported action returns 503 before creating a provisioning operation. There is
one operator-configured credential provider slot; drain/reconcile outstanding operations
before changing its upstream identity. No provider registry or automatic rotation is implied.

`createApp({ onEvent })` receives versioned mutation events after database commit.
Callbacks remain best-effort; reliable delivery uses `dispatchEvents` and the durable
outbox. See EXTENSIONS.md for leases, retry semantics and operator responsibilities.

The default adapter sends operator-configured bearer authorization and these requests:

```http
POST {PROVISIONER_URL}/issue
Idempotency-Key: <stable-operation-uuid>
Content-Type: application/json

{"contractVersion":1,"organizationId":"<tenant-uuid>","name":"External access"}
```

Successful JSON response:

```json
{"reference":"provider-unique-id","secret":"optional-retrievable-secret"}
```

```http
POST {PROVISIONER_URL}/revoke
Idempotency-Key: <stable-operation-uuid>
Content-Type: application/json

{"contractVersion":1,"organizationId":"<tenant-uuid>","reference":"provider-unique-id"}
```

Revoke must return 2xx only after the requested credential is inactive. It must be
safe to revoke an already-revoked credential. An error/timeout leaves the local
credential unrevoked and the operation visibly failed or pending.

The provider must deduplicate by operation UUID and return the same issue result
after retries, including when the first response was lost. References must be
tenant-bound; the provider must validate the organization on revocation. The adapter
uses a timeout, refuses redirects and requires HTTPS in production. It never logs
provider response bodies or tokens.

The client supplies its own Idempotency-Key (8–128 letters, digits, underscores or
hyphens). Reusing it with a different request returns 409. After a process crash,
retry the same request after the lease expires (3 times PROVIDER_TIMEOUT_MS).
The provider sees the stable operation UUID, not the caller's raw idempotency key.
Authorization is rechecked transactionally before accepting the operation. After an
external effect succeeds, its result is recorded even if the initiating session has
expired or been revoked during the call. This completion path is fenced by the saved
operation lease; it does not authorize any new operation or bypass access on later reads.

External secrets are encrypted with a mandatory ENCRYPTION_KEY. Back up that key
outside the repository; changing it without re-encryption makes existing secrets
unreadable. Issued API keys are separate: one-way hashes, never retrievable.

No actual payment, VPN or third-party accounts were provisioned during local validation.
The existing crypto-payment-core is the preferred future credential-lifecycle reference;
it is not assumed to implement this generic provider contract.
