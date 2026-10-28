import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { account, mail, password, prisma, cleanup } from "./fixtures.js";
let server: Server | undefined;
after(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); await cleanup(); });

const { createApp } = await import("../src/app.js");
const { ApiError } = await import("../src/http.js");
const { dispatchEvents } = await import("../src/services/events.js");
const { teamExtension } = await import("../examples/extensions/team.js");
const { apiServiceExtension, exampleEntitlements } = await import("../examples/extensions/api-service.js");
for (const sql of readFileSync(new URL("../examples/extensions/schema.sql", import.meta.url), "utf8").split(";").filter(s => s.trim())) {
  await prisma.$executeRawUnsafe(sql);
}
let rejectSetup = false, entitlementFailure = false;
const app = createApp({ sendMail: async message => { mail.push(message); },
  extensions: [{ ...teamExtension, lifecycle: { ...teamExtension.lifecycle,
    "organization.created": async (db, event) => {
      await teamExtension.lifecycle!["organization.created"]!(db, event);
      if (rejectSetup) throw new ApiError(409, "PRODUCT_SETUP_FAILED", "Product setup rejected");
    } } }, apiServiceExtension(1)],
  entitlements: { contractVersion: 1, allows: async (...args) => {
    if (entitlementFailure) throw new Error("Simulated unavailable entitlement source");
    return exampleEntitlements.allows(...args);
  } } });
server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server!.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function request(method: string, path: string, token: string, body?: object) {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("two product extensions preserve tenant/role boundaries, transactional lifecycle and recoverable event delivery", async () => {
  const owner = await account("extension-owner"), member = await account("extension-member");
  const auditBefore = await prisma.auditLog.count(), eventsBefore = await prisma.integrationEvent.count();
  rejectSetup = true;
  const rejected = await request("POST", "/api/v1/orgs", owner.token, { name: "Rejected", slug: "rejected" });
  assert.equal(rejected.status, 409);
  assert.equal(await prisma.organization.count({ where: { slug: "rejected" } }), 0);
  assert.equal(await prisma.auditLog.count(), auditBefore);
  assert.equal(await prisma.integrationEvent.count(), eventsBefore);
  assert.deepEqual(await prisma.$queryRaw`SELECT name FROM demo_team_projects`, []);
  rejectSetup = false;
  const created = await request("POST", "/api/v1/orgs", owner.token, { name: "Team", slug: "team-product" });
  assert.equal(created.status, 201);
  const org = created.body.id, root = `/api/v1/orgs/${org}`;
  const other = await request("POST", "/api/v1/orgs", owner.token, { name: "Other", slug: "other-product" });
  assert.equal(other.status, 201);
  const team = `${root}/extensions/team/projects`, service = `${root}/extensions/api-service`;
  assert.equal((await request("GET", team, owner.token)).body[0].name, "Welcome");
  assert.equal((await request("GET", team, member.token)).status, 404);
  const invite = await request("POST", root + "/invitations", owner.token, { email: member.email, role: "VIEWER" });
  assert.equal(invite.status, 201);
  assert.equal((await request("POST", "/api/v1/invitations/accept", member.token, { token: mail.findLast(m => m.to === member.email)!.token })).status, 204);
  assert.equal((await request("GET", team, member.token)).status, 200);
  assert.equal((await request("POST", team, member.token, { name: "Denied" })).status, 403);
  const membership = await prisma.membership.findUniqueOrThrow({ where: { userId_orgId: { userId: member.id, orgId: org } } });
  assert.equal((await request("PATCH", root + `/members/${membership.id}`, owner.token, { role: "MEMBER" })).status, 204);
  const project = await request("POST", team, member.token, { name: "Member project" });
  assert.equal(project.status, 201); assert.equal(project.body.assignedUserId, member.id);
  const key = await request("POST", root + "/api-keys", owner.token, { name: "Product reader", scopes: ["projects.read"] });
  assert.equal(key.status, 201);
  assert.equal((await request("GET", team, key.body.key)).status, 200);
  assert.equal((await request("POST", team, key.body.key, { name: "Denied" })).status, 403);
  assert.equal((await request("GET", `/api/v1/orgs/${other.body.id}/extensions/team/projects`, key.body.key)).status, 404);
  assert.equal((await request("POST", root + "/api-keys", owner.token, { name: "Unknown", scopes: ["unknown.scope"] })).status, 422);
  assert.equal((await request("DELETE", root + `/members/${membership.id}`, owner.token)).status, 204);
  const projects = await request("GET", team, owner.token);
  assert.equal(projects.body.find((p: { id: string }) => p.id === project.body.id).assignedUserId, null);
  assert.equal((await request("GET", team, member.token)).status, 404);

  const sa = await request("POST", root + "/service-accounts", owner.token, { name: "API client" });
  const serviceKey = await request("POST", root + "/api-keys", owner.token,
    { name: "API key", serviceAccountId: sa.body.id, scopes: ["requests.execute", "usage.read"] });
  assert.equal(serviceKey.status, 201);
  assert.equal((await request("POST", service + "/requests", serviceKey.body.key)).body.error.code, "FEATURE_DISABLED");
  await prisma.$executeRaw`UPDATE demo_api_usage SET enabled = true WHERE organization_id = ${org}::uuid`;
  entitlementFailure = true;
  assert.equal((await request("POST", service + "/requests", serviceKey.body.key)).status, 503);
  entitlementFailure = false;
  assert.equal((await request("GET", service + "/usage", serviceKey.body.key)).body.calls, 0);
  assert.equal((await request("POST", service + "/requests", serviceKey.body.key)).body.calls, 1);
  assert.equal((await request("POST", service + "/requests", serviceKey.body.key)).body.error.code, "QUOTA_EXCEEDED");
  assert.equal((await request("GET", `/api/v1/orgs/${other.body.id}/extensions/api-service/usage`, owner.token)).body.calls, 0);
  const caps = await request("GET", root + "/capabilities", owner.token);
  assert.ok(caps.body.permissions.includes("projects.read")); assert.equal(caps.body.entitlements, true);
  const spec = await (await fetch(base + "/openapi.json")).json();
  assert.ok(spec.components.schemas.ApiKey.properties.scopes.items.enum.includes("projects.read"));
  assert.ok(spec.paths["/api/v1/orgs/{orgId}/extensions/team/projects"].post.responses[201].content["application/json"].schema.properties.id);

  assert.equal((await request("PATCH", `/api/v1/admin/organizations/${org}`, owner.token, { suspended: true })).status, 403);
  await prisma.user.update({ where: { id: owner.id }, data: { isSuperAdmin: true } });
  const newEmail = "pending-product@example.test";
  await request("POST", root + "/invitations", owner.token, { email: newEmail });
  assert.equal((await request("PATCH", `/api/v1/admin/organizations/${org}`, owner.token, { suspended: true })).status, 200);
  assert.equal((await request("GET", team, key.body.key)).status, 403);
  assert.equal((await request("GET", service + "/usage", serviceKey.body.key)).status, 403);
  assert.equal((await request("POST", "/api/v1/auth/invitations/register", "", { name: "Pending", password,
    token: mail.findLast(m => m.to === newEmail)!.token })).status, 403);
  assert.equal((await request("PATCH", `/api/v1/admin/organizations/${org}`, owner.token, { suspended: false })).status, 200);
  assert.equal((await request("GET", team, key.body.key)).status, 200);
  const events = await request("GET", root + "/events?limit=100", owner.token);
  assert.ok(events.body.items.every((e: { organizationId: string; version: number }) => e.organizationId === org && e.version === 1));
  const removed = events.body.items.find((e: { type: string }) => e.type === "membership.removed");
  assert.equal(removed.data.userId, member.id);
  const seen: string[] = [];
  const first = await dispatchEvents(async event => { seen.push(event.id); if (event.id === removed.id) throw new Error("Simulated delivery failure"); }, { limit: 100, retryMs: 0 });
  assert.equal(first.failed, 1);
  const second = await dispatchEvents(async event => { seen.push(event.id); }, { limit: 100 });
  assert.equal(second.delivered, 1); assert.equal(seen.filter(id => id === removed.id).length, 2);
  assert.equal((await prisma.integrationEvent.findUniqueOrThrow({ where: { id: removed.id } })).attempts, 2);
  // Simulate a crashed worker: a live lease cannot be stolen; an expired one is recoverable.
  await prisma.integrationEvent.update({ where: { id: removed.id }, data: { deliveredAt: null, leaseUntil: new Date(Date.now() + 60000) } });
  assert.equal((await dispatchEvents(async () => { throw new Error("Must not deliver"); })).failed, 0);
  await prisma.integrationEvent.update({ where: { id: removed.id }, data: { leaseUntil: new Date(0) } });
  const concurrent: string[] = [];
  await Promise.all([1, 2].map(() => dispatchEvents(async event => { concurrent.push(event.id); })));
  assert.deepEqual(concurrent, [removed.id]);
});
