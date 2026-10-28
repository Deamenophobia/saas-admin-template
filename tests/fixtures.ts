import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Mail } from "../src/services/email.js";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a dedicated PostgreSQL test database");
const url = new URL(process.env.TEST_DATABASE_URL);
if (!url.pathname.includes("test")) throw new Error("TEST_DATABASE_URL must name a dedicated test database");
export const schema = `test_${randomBytes(8).toString("hex")}`;
url.searchParams.set("schema", schema);
process.env.DATABASE_URL = url.toString();
process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.AUTH_RATE_LIMIT = "1000";
process.env.NODE_ENV = "test";
process.env.PROVISIONER_TOKEN = "test-provider-token";
export const mail: Mail[] = [];
export const providerState = { issueCalls: 0, revokeCalls: 0, failIssue: false, failRevoke: false };
export const providerHooks: { afterIssue?: () => Promise<void> } = {};
const issued = new Map<string, object>();
export const upstream = createServer(async (req, res) => {
  if (req.headers.authorization !== "Bearer test-provider-token") { res.writeHead(401).end(); return; }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const data = JSON.parse(raw);
  const key = String(req.headers["idempotency-key"]);
  if (!data.organizationId || !key) { res.writeHead(400).end(); return; }
  if (req.url === "/issue") {
    providerState.issueCalls++;
    if (providerState.failIssue) { res.writeHead(503).end(); return; }
    if (!issued.has(key)) issued.set(key, { reference: `ref-${key}`, secret: `secret-${key}` });
    const hook = providerHooks.afterIssue;
    delete providerHooks.afterIssue;
    await hook?.();
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(issued.get(key)));
  } else {
    providerState.revokeCalls++;
    res.writeHead(providerState.failRevoke ? 503 : 204).end();
  }
});
await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
process.env.PROVISIONER_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: process.env, stdio: "pipe" });
export const { prisma } = await import("../src/services/prisma.js");
const { createApp } = await import(process.env.TEST_APP_BUILD === "true" ? "../dist/app.js" : "../src/app.js");
export const appServer = createApp({ sendMail: async message => { mail.push(message); } }).listen(0, "127.0.0.1");
await new Promise<void>(resolve => appServer.once("listening", resolve));
export const base = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
export async function api(method: string, path: string, token?: string, body?: object, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
export const password = "a-long-test-password-123";
export async function account(label: string) {
  const email = `${label}-${randomBytes(4).toString("hex")}@example.test`;
  const registered = await api("POST", "/api/v1/auth/register", undefined, { email, name: label, password });
  if (registered.status !== 201) throw new Error(JSON.stringify(registered));
  const verification = mail.findLast(m => m.to === email)!;
  const verified = await api("POST", "/api/v1/auth/verify", undefined, { token: verification.token });
  if (verified.status !== 200) throw new Error(JSON.stringify(verified));
  const signed = await api("POST", "/api/v1/auth/login", undefined, { email, password });
  return { id: registered.body.userId as string, email, token: signed.body.token as string };
}
export async function organization(token: string, label: string) {
  const result = await api("POST", "/api/v1/orgs", token, { name: label, slug: `${label}-${randomBytes(4).toString("hex")}` });
  if (result.status !== 201) throw new Error(JSON.stringify(result));
  return result.body.id as string;
}
export async function cleanup() {
  await Promise.all([new Promise<void>(resolve => appServer.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
  if (!/^test_[a-f0-9]{16}$/.test(schema)) throw new Error("Unsafe test schema");
  await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await prisma.$disconnect();
}
