// Adapted from kokoro-auth/routes/apiKeys.ts: hash at rest, display once, revoke.
// Adds tenant ownership and bounded scopes; removes hardcoded Kokoro products.
import type { Express, Request } from "express";
import { z } from "zod";
import { prisma } from "../services/prisma.js";
import { config } from "../config.js";
import { endpoint, assert, nameSchema, uuidSchema, pagination } from "../http.js";
import { human, permit } from "../middleware/access.js";
import { generateApiKey, hashApiKey, keyPrefix } from "../crypto/apiKey.js";
import { atomic, audit, type Db } from "../services/audit.js";

const keySelect = { id: true, name: true, userId: true, serviceAccountId: true, prefix: true, scopes: true,
  expiresAt: true, revokedAt: true, createdAt: true } as const;
const keyBody = z.object({ name: nameSchema, serviceAccountId: uuidSchema.optional(),
  scopes: z.array(z.string().max(100)).min(1).max(20),
  expiresAt: z.string().datetime().optional() }).strict();

async function createKey(db: Db, req: Request, input: z.infer<typeof keyBody>, raw: string) {
  if (input.serviceAccountId) {
    const sa = await db.serviceAccount.findFirst({ where: { id: input.serviceAccountId, orgId: req.orgId, disabled: false } });
    assert(sa, 404, "NOT_FOUND", "Service account not found");
  }
  for (const scope of input.scopes) {
    assert(req.accessPolicy.scopes.includes(scope), 422, "UNKNOWN_SCOPE", "Unknown scope");
    permit(req, scope);
  }
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(Date.now() + config.keyMs);
  assert(expiresAt > new Date() && expiresAt.getTime() <= Date.now() + config.keyMs, 422, "INVALID_EXPIRY", "Expiry exceeds configured maximum");
  return db.apiKey.create({ data: { orgId: req.orgId, name: input.name, scopes: [...new Set(input.scopes)],
    userId: input.serviceAccountId ? null : human(req), serviceAccountId: input.serviceAccountId,
    keyHash: await hashApiKey(raw), prefix: keyPrefix(raw), expiresAt }, select: keySelect });
}
export function keyRoutes(app: Express) {
  endpoint(app, "post", "/api/v1/orgs/:orgId/api-keys", async (req, res) => {
    human(req); permit(req, "credentials.write");
    const input = keyBody.parse(req.body), raw = generateApiKey();
    const key = await atomic(req, async db => {
      const result = await createKey(db, req, input, raw);
      await audit(db, req, "credential.issued", result.id);
      return result;
    });
    res.status(201).json({ ...key, key: raw });
  });
  endpoint(app, "get", "/api/v1/orgs/:orgId/api-keys", async (req, res) => {
    permit(req, "credentials.read");
    const { page, limit } = pagination.parse(req.query);
    res.json({ items: await prisma.apiKey.findMany({ where: { orgId: req.orgId }, select: keySelect,
      orderBy: { id: "asc" }, skip: (page - 1) * limit, take: limit }), page, limit });
  });
  endpoint(app, "delete", "/api/v1/orgs/:orgId/api-keys/:id", async (req, res) => {
    permit(req, "credentials.write");
    await atomic(req, async db => {
      const result = await db.apiKey.updateMany({ where: { id: req.params.id, orgId: req.orgId }, data: { revokedAt: new Date() } });
      assert(result.count, 404, "NOT_FOUND", "Key not found");
      await audit(db, req, "credential.revoked", req.params.id);
    });
    res.status(204).end();
  });
  endpoint(app, "post", "/api/v1/orgs/:orgId/api-keys/:id/rotate", async (req, res) => {
    human(req); permit(req, "credentials.write");
    const raw = generateApiKey();
    const key = await atomic(req, async db => {
      const old = await db.apiKey.findFirst({ where: { id: req.params.id, orgId: req.orgId, revokedAt: null } });
      assert(old && (old.serviceAccountId || old.userId === req.identity.userId), 404, "NOT_FOUND", "Owned key not found");
      const result = await createKey(db, req, { name: old.name, scopes: old.scopes, serviceAccountId: old.serviceAccountId ?? undefined }, raw);
      await db.apiKey.update({ where: { id: old.id }, data: { revokedAt: new Date() } });
      await audit(db, req, "credential.rotated", result.id);
      return result;
    });
    res.status(201).json({ ...key, key: raw });
  });
}
