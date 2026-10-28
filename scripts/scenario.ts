// One complete scenario against built JS + real PostgreSQL, with captured local email.
// No payment node, provider service or live account is contacted.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ApiClient } from "../examples/api-client.mjs";
process.env.TEST_APP_BUILD = "true";
const { account, api, organization, mail, base, password, cleanup } = await import("../tests/fixtures.js");
const passed: string[] = [];
function step(message: string) { passed.push(message); console.log(`PASS ${message}`); }
try {
  const owner = await account("scenario-owner");
  const other = await account("scenario-other");
  const orgA = await organization(owner.token, "scenario-a");
  const orgB = await organization(other.token, "scenario-b");
  const ownerApi = new ApiClient(base, { token: owner.token });
  const root = `/api/v1/orgs/${orgA}`;
  step("Two independent organizations created");

  const email = `invited-${randomBytes(4).toString("hex")}@example.test`;
  await ownerApi.request("POST", root + "/invitations", { email, role: "ADMIN" });
  const invite = mail.findLast(m => m.to === email)!;
  const publicApi = new ApiClient(base);
  const invited = await publicApi.request("POST", "/api/v1/auth/invitations/register", { token: invite.token, name: "Invited operator", password });
  const login = await publicApi.request("POST", "/api/v1/auth/login", { email, password });
  const memberApi = new ApiClient(base, { token: login.token });
  step("Invitation accepted by a new user; sign-in succeeds");

  const membership = (await ownerApi.request("GET", root + "/members")).items.find((m: any) => m.user.id === invited.userId);
  const key = await memberApi.request("POST", root + "/api-keys", { name: "Merchant automation", scopes: ["organizations.read"] });
  const consumer = new ApiClient(base, { token: key.key });
  assert.equal((await consumer.request("GET", root)).id, orgA);
  await assert.rejects(consumer.request("GET", `/api/v1/orgs/${orgB}`), { status: 404 });
  await assert.rejects(consumer.request("GET", root + "/members"), { status: 403 });
  step("Issued API credential works only for its tenant and permitted scope");

  await ownerApi.request("DELETE", root + `/members/${membership.id}`);
  await assert.rejects(consumer.request("GET", root), { status: 401 });
  await assert.rejects(memberApi.request("GET", root), { status: 404 });
  assert.equal((await api("GET", `/api/v1/orgs/${orgB}`, other.token)).status, 200);
  step("Member removal revokes its credential; the other tenant remains accessible");

  const service = await ownerApi.request("POST", root + "/service-accounts", { name: "Merchant worker" });
  const serviceKey = await ownerApi.request("POST", root + "/api-keys", { name: "Worker key", serviceAccountId: service.id, scopes: ["organizations.read"] });
  const rotated = await ownerApi.request("POST", root + `/api-keys/${serviceKey.id}/rotate`);
  await assert.rejects(new ApiClient(base, { token: serviceKey.key }).request("GET", root), { status: 401 });
  const worker = new ApiClient(base, { token: rotated.key });
  assert.equal((await worker.request("GET", root)).id, orgA);
  await ownerApi.request("DELETE", root + `/api-keys/${rotated.id}`);
  await assert.rejects(worker.request("GET", root), { status: 401 });
  const audit = await ownerApi.request("GET", root + "/audit?limit=100");
  assert.ok(audit.items.some((e: any) => e.action === "credential.revoked"));
  step("Service credential rotation/revocation and durable audit verified");
  console.log(JSON.stringify({ result: "passed", steps: passed.length, backend: "compiled JavaScript", database: "PostgreSQL", liveIntegrations: false }));
} finally { await cleanup(); }
