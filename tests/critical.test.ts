import { test, after } from "node:test";
import assert from "node:assert/strict";
import { TOTP } from "otpauth";
import { api, account, organization, mail, password, prisma, providerState, providerHooks, cleanup } from "./fixtures.js";
after(cleanup);

test("verification/reset tokens are single-use; password reset revokes sessions; MFA prevents replay", async () => {
  const user = await account("auth");
  const verify = mail.findLast(m => m.to === user.email)!;
  assert.equal((await api("POST", "/api/v1/auth/verify", undefined, { token: verify.token })).status, 400);
  await api("POST", "/api/v1/auth/forgot-password", undefined, { email: user.email });
  const reset = mail.findLast(m => m.to === user.email)!;
  assert.equal((await api("POST", "/api/v1/auth/reset-password", undefined, { token: reset.token, password })).status, 200);
  assert.equal((await api("GET", "/api/v1/me", user.token)).status, 401);
  assert.equal((await api("POST", "/api/v1/auth/reset-password", undefined, { token: reset.token, password })).status, 400);
  const login = await api("POST", "/api/v1/auth/login", undefined, { email: user.email, password });
  const enrolled = await api("POST", "/api/v1/me/mfa/enroll", login.body.token, { password });
  assert.equal(enrolled.status, 200);
  const uri = new URL(enrolled.body.uri);
  const totp = new TOTP({ secret: uri.searchParams.get("secret")! });
  const code = totp.generate();
  const confirmed = await api("POST", "/api/v1/me/mfa/confirm", login.body.token, { code });
  assert.equal(confirmed.status, 200);
  assert.equal((await api("POST", "/api/v1/me/mfa/enroll", login.body.token, { password })).status, 400);
  assert.equal((await api("POST", "/api/v1/auth/login", undefined, { email: user.email, password })).status, 401);
  assert.equal((await api("POST", "/api/v1/auth/login", undefined, { email: user.email, password, code })).status, 401);
  const recovery = confirmed.body.recoveryCodes[0];
  assert.equal((await api("POST", "/api/v1/auth/login", undefined, { email: user.email, password, code: recovery })).status, 200);
  assert.equal((await api("POST", "/api/v1/auth/login", undefined, { email: user.email, password, code: recovery })).status, 401);
});

test("tenant isolation, invitation ownership, role limits, last-owner protection and scoped offboarding", async () => {
  const owner = await account("owner"), other = await account("other");
  const org = await organization(owner.token, "tenant-a"), orgB = await organization(other.token, "tenant-b");
  const root = `/api/v1/orgs/${org}`;
  for (const suffix of ["", "/members", "/api-keys", "/credentials", "/audit"]) {
    assert.equal((await api("GET", root + suffix, other.token)).status, 404);
  }
  const members = await api("GET", root + "/members", owner.token);
  assert.equal((await api("DELETE", root + `/members/${members.body.items[0].id}`, owner.token)).body.error.code, "LAST_OWNER");
  assert.equal((await api("POST", root + "/invitations", owner.token, { email: other.email, role: "VIEWER" })).status, 201);
  const invite = mail.findLast(m => m.to === other.email)!;
  assert.equal((await api("POST", "/api/v1/invitations/accept", owner.token, { token: invite.token })).status, 403);
  assert.equal((await api("POST", "/api/v1/invitations/accept", other.token, { token: invite.token })).status, 204);
  assert.equal((await api("POST", "/api/v1/invitations/accept", other.token, { token: invite.token })).status, 400);
  assert.equal((await api("PATCH", root, other.token, { name: "takeover" })).status, 403);
  const list = await api("GET", root + "/members", owner.token);
  const memberId = list.body.items.find((m: any) => m.user.id === other.id).id;
  await api("PATCH", root + `/members/${memberId}`, owner.token, { role: "ADMIN" });
  const key = await api("POST", root + "/api-keys", other.token, { name: "member key", scopes: ["organizations.read"] });
  assert.equal(key.status, 201);
  assert.equal((await api("GET", root, key.body.key)).status, 200);
  assert.equal((await api("DELETE", root + `/members/${memberId}`, owner.token)).status, 204);
  assert.equal((await api("GET", root, key.body.key)).status, 401);
  assert.equal((await api("GET", `/api/v1/orgs/${orgB}`, other.token)).status, 200);
  const invalid = await api("GET", root + "/members?limit=-1", owner.token);
  assert.equal(invalid.status, 422);
});

test("service-account keys enforce scopes, rotation, expiry and revocation without exposing hashes", async () => {
  const owner = await account("keys"), org = await organization(owner.token, "keys");
  const root = `/api/v1/orgs/${org}`;
  const sa = await api("POST", root + "/service-accounts", owner.token, { name: "automation" });
  const key = await api("POST", root + "/api-keys", owner.token, { name: "scoped", serviceAccountId: sa.body.id, scopes: ["organizations.read"] });
  assert.equal(key.status, 201);
  assert.equal((await api("GET", root, key.body.key)).status, 200);
  assert.equal((await api("GET", root + "/members", key.body.key)).status, 403);
  assert.equal((await api("GET", "/api/v1/admin/users", key.body.key)).status, 403);
  const stored = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.body.id } });
  assert.notEqual(stored.keyHash, key.body.key);
  const listed = await api("GET", root + "/api-keys", owner.token);
  assert.ok(!JSON.stringify(listed.body).includes(stored.keyHash));
  const rotated = await api("POST", root + `/api-keys/${key.body.id}/rotate`, owner.token, {});
  assert.equal(rotated.status, 201);
  assert.equal((await api("GET", root, key.body.key)).status, 401);
  assert.equal((await api("GET", root, rotated.body.key)).status, 200);
  await api("PATCH", root + `/service-accounts/${sa.body.id}`, owner.token, { disabled: true });
  assert.equal((await api("GET", root, rotated.body.key)).status, 401);
  await api("PATCH", root + `/service-accounts/${sa.body.id}`, owner.token, { disabled: false });
  assert.equal((await api("GET", root, rotated.body.key)).status, 401);
  const expired = await api("POST", root + "/api-keys", owner.token, { name: "expired", scopes: ["organizations.read"], expiresAt: "2020-01-01T00:00:00.000Z" });
  assert.equal(expired.status, 422);
});

test("HTTP provisioning retries are idempotent and failed revocation is never reported as successful", async () => {
  const owner = await account("provider"), stranger = await account("stranger");
  const org = await organization(owner.token, "provider"), root = `/api/v1/orgs/${org}`;
  const headers = { "Idempotency-Key": "issue-example-1" };
  providerState.failIssue = true;
  const failure = await api("POST", root + "/credentials", owner.token, { name: "External access" }, headers);
  assert.equal(failure.status, 502); assert.equal(failure.body.status, "FAILED");
  providerState.failIssue = false;
  const success = await api("POST", root + "/credentials", owner.token, { name: "External access" }, headers);
  assert.equal(success.body.status, "SUCCEEDED");
  const calls = providerState.issueCalls;
  const repeated = await api("POST", root + "/credentials", owner.token, { name: "External access" }, headers);
  assert.equal(repeated.body.credentialId, success.body.credentialId); assert.equal(providerState.issueCalls, calls);
  assert.equal((await api("POST", root + "/credentials", owner.token, { name: "different" }, headers)).status, 409);
  const id = success.body.credentialId;
  assert.equal((await api("GET", root + `/operations/${success.body.id}`, stranger.token)).status, 404);
  const revealed = await api("POST", root + `/credentials/${id}/reveal`, owner.token, {});
  assert.equal(revealed.status, 200);
  const stored = await prisma.credential.findUniqueOrThrow({ where: { id } });
  assert.notEqual(stored.encryptedSecret, revealed.body.secret);
  providerState.failRevoke = true;
  const revokeHeaders = { "Idempotency-Key": "revoke-example-1" };
  assert.equal((await api("POST", root + `/credentials/${id}/revoke`, owner.token, {}, revokeHeaders)).status, 502);
  assert.equal((await prisma.credential.findUniqueOrThrow({ where: { id } })).revokedAt, null);
  providerState.failRevoke = false;
  assert.equal((await api("POST", root + `/credentials/${id}/revoke`, owner.token, {}, revokeHeaders)).body.status, "SUCCEEDED");
  assert.equal((await api("POST", root + `/credentials/${id}/reveal`, owner.token, {})).status, 404);
  const logs = await api("GET", root + "/audit", owner.token);
  assert.ok(!JSON.stringify(logs.body).includes(revealed.body.secret));
  // An accepted provider effect must still be recorded if its caller logs out in flight.
  providerHooks.afterIssue = async () => { await prisma.session.deleteMany({ where: { userId: owner.id } }); };
  const completed = await api("POST", root + "/credentials", owner.token, { name: "Accepted operation" }, { "Idempotency-Key": "logout-in-flight" });
  assert.equal(completed.body.status, "SUCCEEDED");
  assert.ok(await prisma.credential.findUnique({ where: { id: completed.body.credentialId } }));
  assert.equal((await api("GET", root, owner.token)).status, 401);
});

test("platform suspension invalidates user sessions/keys and organization admins cannot grant platform access", async () => {
  const admin = await account("platform"), user = await account("suspend");
  await prisma.user.update({ where: { id: admin.id }, data: { isSuperAdmin: true } });
  const org = await organization(user.token, "suspend"), root = `/api/v1/orgs/${org}`;
  const key = await api("POST", root + "/api-keys", user.token, { name: "personal", scopes: ["organizations.read"] });
  assert.equal((await api("GET", "/api/v1/admin/users", user.token)).status, 403);
  assert.equal((await api("PATCH", "/api/v1/me", user.token, { name: "x", isSuperAdmin: true })).status, 422);
  const changed = await api("PATCH", `/api/v1/admin/users/${user.id}`, admin.token, { disabled: true });
  assert.equal(changed.status, 200); assert.ok(!("passwordHash" in changed.body));
  assert.equal((await api("GET", "/api/v1/me", user.token)).status, 401);
  assert.equal((await api("GET", root, key.body.key)).status, 401);
  await api("PATCH", `/api/v1/admin/users/${user.id}`, admin.token, { disabled: false });
  assert.equal((await api("GET", root, key.body.key)).status, 401);
});
