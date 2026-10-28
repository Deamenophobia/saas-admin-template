import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TOTP } from "otpauth";
import { api, account, organization, mail, password, prisma, cleanup } from "./fixtures.js";
import { oidcProvider } from "./oidc-provider.js";

let server: Server | undefined, upstream: Server | undefined;
after(async () => {
  for (const instance of [server, upstream]) if (instance) await new Promise<void>(resolve => instance.close(() => resolve()));
  await cleanup();
});
const provider = await oidcProvider(); upstream = provider.server;
const { createApp } = await import("../src/app.js");
server = createApp({ oidcProviders: [provider.provider] }).listen(0, "127.0.0.1");
await new Promise<void>(resolve => server!.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, root = "/api/v1/auth/sso";
async function request(method: string, path: string, body?: object, token?: string) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function start(link?: { token: string; code?: string }) {
  const started = link ? await request("POST", "/api/v1/me/sso/fixture/link/start", { password, code: link.code }, link.token)
    : await request("POST", root + "/fixture/start", {});
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const authorize = await fetch(started.body.authorizationUrl, { redirect: "manual" });
  assert.equal(authorize.status, 302);
  const callback = new URL(authorize.headers.get("location")!);
  return { code: callback.searchParams.get("code")!, state: callback.searchParams.get("state")!, iss: callback.searchParams.get("iss")!, flowToken: started.body.flowToken };
}
const complete = (flow: Awaited<ReturnType<typeof start>>) => request("POST", root + "/fixture/complete", flow);

test("OIDC validates signed claims and one-use bound flows without merging email identities or granting tenant roles", async () => {
  assert.deepEqual((await request("GET", root + "/providers")).body, [{ id: "fixture", label: "Local identity provider" }]);
  assert.equal((await request("POST", root + "/missing/start", {})).status, 404);
  assert.equal((await request("POST", root + "/fixture/start", { redirectUri: "https://evil.example/callback" })).status, 422);
  const flow = await start(), calls = provider.state.tokenCalls;
  assert.equal((await complete({ ...flow, state: "x".repeat(43) })).status, 400);
  assert.equal((await complete({ ...flow, flowToken: "x".repeat(64) })).status, 400);
  assert.equal(provider.state.tokenCalls, calls);
  const signed = await complete(flow);
  assert.equal(signed.status, 200, JSON.stringify(signed.body)); assert.ok(signed.body.token);
  assert.equal((await complete(flow)).status, 400);
  const me = await api("GET", "/api/v1/me", signed.body.token);
  assert.equal(me.body.email, provider.state.email); assert.equal(me.body.isSuperAdmin, false);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: me.body.id } });
  assert.equal(user.passwordHash, null);
  assert.equal((await api("GET", "/api/v1/orgs", signed.body.token)).body.items.length, 0);
  assert.equal((await api("POST", "/api/v1/auth/login", undefined, { email: user.email, password })).status, 401);
  const mailCount = mail.length;
  await api("POST", "/api/v1/auth/forgot-password", undefined, { email: user.email });
  assert.equal(mail.length, mailCount);
  const local = await account("local-collision"), org = await organization(local.token, "sso-isolation");
  assert.equal((await api("GET", `/api/v1/orgs/${org}`, signed.body.token)).status, 404);
  assert.equal((await api("GET", "/api/v1/admin/users", signed.body.token)).status, 403);
  const identity = await prisma.externalIdentity.findFirstOrThrow({ where: { userId: user.id } });
  const storedSession = await prisma.session.findFirstOrThrow({ where: { ssoIdentityId: identity.id } });
  assert.notEqual(storedSession.tokenHash, signed.body.token);
  assert.equal((await request("DELETE", `/api/v1/me/sso/${identity.id}`, { password }, signed.body.token)).status, 401);
  // Identity remains issuer/sub even after the provider changes the email claim.
  provider.state.email = local.email;
  const again = await complete(await start());
  assert.equal((await api("GET", "/api/v1/me", again.body.token)).body.id, user.id);
  provider.state.subject = "different-external-subject";
  assert.equal((await complete(await start())).body.error.code, "SSO_LINK_REQUIRED");
  provider.state.email = "unverified@example.test"; provider.state.emailVerified = false;
  assert.equal((await complete(await start())).body.error.code, "SSO_VERIFIED_EMAIL_REQUIRED");
  assert.equal(await prisma.user.count({ where: { email: provider.state.email } }), 0);
  provider.state.emailVerified = true;
  for (const failure of ["signature", "nonce", "issuer", "audience", "expired"]) {
    provider.state.failure = failure;
    assert.equal((await complete(await start())).body.error.code, "SSO_INVALID_RESPONSE", failure);
  }
  provider.state.failure = "";
  const expired = await start();
  await prisma.ssoFlow.updateMany({ data: { expiresAt: new Date(0) } });
  assert.equal((await complete(expired)).status, 400);
  provider.state.subject = identity.subject;
  await prisma.user.update({ where: { id: user.id }, data: { disabled: true } });
  assert.equal((await complete(await start())).status, 401);
  assert.equal((await api("GET", "/api/v1/me", signed.body.token)).status, 401);
});

test("explicit linking requires local proof; SSO preserves MFA and unlinking revokes only linked SSO sessions", async () => {
  const local = await account("linking"), other = await account("link-other");
  provider.state.subject = "linkable-subject"; provider.state.email = local.email;
  assert.equal((await complete(await start())).status, 409);
  assert.equal((await request("POST", "/api/v1/me/sso/fixture/link/start", { password: "wrong" }, local.token)).status, 401);
  const revokedFlow = await start({ token: other.token });
  await api("POST", "/api/v1/logout", other.token);
  assert.equal((await complete(revokedFlow)).status, 400);
  const linked = await complete(await start({ token: local.token }));
  assert.deepEqual(linked.body, { linked: true });
  const identities = await request("GET", "/api/v1/me/sso", undefined, local.token);
  assert.equal(identities.body.length, 1);
  const identityId = identities.body[0].id;
  const withoutMfa = await complete(await start());
  assert.equal((await api("GET", "/api/v1/me", withoutMfa.body.token)).body.id, local.id);
  const enrolled = await api("POST", "/api/v1/me/mfa/enroll", local.token, { password });
  const totp = new TOTP({ secret: new URL(enrolled.body.uri).searchParams.get("secret")! });
  const confirmed = await api("POST", "/api/v1/me/mfa/confirm", local.token, { code: totp.generate() });
  assert.equal(confirmed.status, 200);
  const codes = confirmed.body.recoveryCodes;
  const challenge = await complete(await start());
  assert.equal(challenge.status, 202); assert.equal(challenge.body.token, undefined);
  assert.equal((await request("POST", root + "/mfa", { challengeToken: challenge.body.challengeToken, code: "bad-recovery-code" })).status, 401);
  const signed = await request("POST", root + "/mfa", { challengeToken: challenge.body.challengeToken, code: codes[0] });
  assert.equal(signed.status, 200);
  assert.equal((await request("POST", root + "/mfa", { challengeToken: challenge.body.challengeToken, code: codes[1] })).status, 401);
  const exhausted = await complete(await start());
  for (let i = 0; i < 5; i++) assert.equal((await request("POST", root + "/mfa", { challengeToken: exhausted.body.challengeToken, code: "bad" })).status, 401);
  assert.equal((await request("POST", root + "/mfa", { challengeToken: exhausted.body.challengeToken, code: codes[1] })).body.error.code, "SSO_CHALLENGE_INVALID");
  const pending = await complete(await start());
  assert.equal((await request("DELETE", `/api/v1/me/sso/${identityId}`, { password }, local.token)).status, 401);
  assert.equal((await request("DELETE", `/api/v1/me/sso/${identityId}`, { password, code: codes[1] }, local.token)).status, 204);
  assert.equal((await api("GET", "/api/v1/me", signed.body.token)).status, 401);
  assert.equal((await api("GET", "/api/v1/me", local.token)).status, 200);
  assert.equal((await request("POST", root + "/mfa", { challengeToken: pending.body.challengeToken, code: codes[2] })).status, 401);
  assert.equal((await complete(await start())).status, 409);
});
