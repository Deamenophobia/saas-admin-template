import type { Express } from "express";
import { z } from "zod";
import { prisma } from "../services/prisma.js";
import { endpoint, nameSchema, assert, pagination } from "../http.js";
import { human, permit } from "../middleware/access.js";
import { atomic, audit } from "../services/audit.js";

export function serviceAccountRoutes(app: Express) {
  endpoint(app, "post", "/api/v1/orgs/:orgId/service-accounts", async (req, res) => {
    human(req); permit(req, "service_accounts.write");
    const body = z.object({ name: nameSchema }).strict().parse(req.body);
    const account = await atomic(req, async db => {
      const result = await db.serviceAccount.create({ data: { name: body.name, orgId: req.orgId } });
      await audit(db, req, "service_account.created", result.id);
      return result;
    });
    res.status(201).json(account);
  });
  endpoint(app, "get", "/api/v1/orgs/:orgId/service-accounts", async (req, res) => {
    permit(req, "service_accounts.read");
    const { page, limit } = pagination.parse(req.query);
    res.json({ items: await prisma.serviceAccount.findMany({ where: { orgId: req.orgId },
      orderBy: { id: "asc" }, skip: (page - 1) * limit, take: limit }), page, limit });
  });
  endpoint(app, "patch", "/api/v1/orgs/:orgId/service-accounts/:id", async (req, res) => {
    human(req); permit(req, "service_accounts.write");
    const data = z.object({ name: nameSchema.optional(), disabled: z.boolean().optional() }).strict().parse(req.body);
    await atomic(req, async db => {
      const result = await db.serviceAccount.updateMany({ where: { id: req.params.id, orgId: req.orgId }, data });
      assert(result.count, 404, "NOT_FOUND", "Service account not found");
      if (data.disabled) await db.apiKey.updateMany({ where: { serviceAccountId: req.params.id, orgId: req.orgId }, data: { revokedAt: new Date() } });
      await audit(db, req, "service_account.updated", req.params.id);
    });
    res.status(204).end();
  });
}
