import type { Express } from "express";
import { z } from "zod";
import { prisma } from "../services/prisma.js";
import { endpoint, assert, nameSchema, pagination } from "../http.js";
import { human, permit } from "../middleware/access.js";
import { decryptField } from "../crypto/encryption.js";
import { atomic, audit } from "../services/audit.js";
import { provision, operationView } from "../services/provisioning.js";
import type { CredentialProvider } from "../providers/credentials.js";

const idempotencyKey = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export function credentialRoutes(app: Express, provider: CredentialProvider) {
  endpoint(app, "post", "/api/v1/orgs/:orgId/credentials", async (req, res) => {
    permit(req, "credentials.write");
    const { name } = z.object({ name: nameSchema }).strict().parse(req.body);
    const result = await provision(req, { kind: "issue", name }, idempotencyKey.parse(req.header("Idempotency-Key")), provider);
    res.status(result.status === "SUCCEEDED" ? 200 : result.status === "PENDING" ? 202 : 502).json(result);
  });
  endpoint(app, "get", "/api/v1/orgs/:orgId/credentials", async (req, res) => {
    permit(req, "credentials.read");
    const { page, limit } = pagination.parse(req.query);
    res.json({ items: await prisma.credential.findMany({ where: { orgId: req.orgId },
      select: { id: true, name: true, provider: true, revokedAt: true, createdAt: true },
      orderBy: { id: "asc" }, skip: (page - 1) * limit, take: limit }), page, limit });
  });
  endpoint(app, "post", "/api/v1/orgs/:orgId/credentials/:id/reveal", async (req, res) => {
    human(req); permit(req, "secrets.read");
    const secret = await atomic(req, async db => {
      const credential = await db.credential.findFirst({ where: { id: req.params.id, orgId: req.orgId, revokedAt: null } });
      assert(credential?.encryptedSecret, 404, "NOT_FOUND", "Active secret not found");
      await audit(db, req, "external_credential.revealed", credential.id);
      return decryptField(credential.encryptedSecret);
    });
    res.json({ secret });
  });
  endpoint(app, "post", "/api/v1/orgs/:orgId/credentials/:id/revoke", async (req, res) => {
    permit(req, "credentials.write");
    const result = await provision(req, { kind: "revoke", credentialId: req.params.id }, idempotencyKey.parse(req.header("Idempotency-Key")), provider);
    res.status(result.status === "SUCCEEDED" ? 200 : result.status === "PENDING" ? 202 : 502).json(result);
  });
  endpoint(app, "get", "/api/v1/orgs/:orgId/operations/:id", async (req, res) => {
    permit(req, "credentials.read");
    const op = await prisma.operation.findFirst({ where: { id: req.params.id, orgId: req.orgId } });
    assert(op, 404, "NOT_FOUND", "Operation not found");
    res.json(operationView(op));
  });
}
