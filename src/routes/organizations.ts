// Adapted from kokoro-pipeline/routes/orgs.ts; product quotas/stats removed.
import type { Express } from "express";
import { z } from "zod";
import { prisma } from "../services/prisma.js";
import { endpoint, nameSchema, pagination } from "../http.js";
import { human, permit } from "../middleware/access.js";
import { atomic, audit } from "../services/audit.js";

export function organizationRoutes(app: Express) {
  endpoint(app, "post", "/api/v1/orgs", async (req, res) => {
    const userId = human(req);
    const input = z.object({ name: nameSchema, slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80) }).strict().parse(req.body);
    const org = await atomic(req, async db => {
      const result = await db.organization.create({ data: { ...input, memberships: { create: { userId, role: "OWNER" } } } });
      req.orgId = result.id;
      await audit(db, req, "organization.created", result.id, { ownerId: userId });
      return result;
    });
    res.status(201).json(org);
  });
  endpoint(app, "get", "/api/v1/orgs", async (req, res) => {
    const userId = human(req);
    const { page, limit } = pagination.parse(req.query);
    const memberships = await prisma.membership.findMany({ where: { userId }, include: { organization: true },
      orderBy: { id: "asc" }, skip: (page - 1) * limit, take: limit });
    res.json({ items: memberships.map(m => ({ ...m.organization, role: m.role })), page, limit });
  });
  endpoint(app, "get", "/api/v1/orgs/:orgId", async (req, res) => {
    permit(req, "organizations.read");
    res.json(await prisma.organization.findUniqueOrThrow({ where: { id: req.orgId } }));
  });
  endpoint(app, "patch", "/api/v1/orgs/:orgId", async (req, res) => {
    permit(req, "organizations.write");
    const data = z.object({ name: nameSchema }).strict().parse(req.body);
    res.json(await atomic(req, async db => {
      const org = await db.organization.update({ where: { id: req.orgId }, data });
      await audit(db, req, "organization.updated", org.id);
      return org;
    }));
  });
  endpoint(app, "get", "/api/v1/orgs/:orgId/audit", async (req, res) => {
    permit(req, "audit.read");
    const { page, limit } = pagination.parse(req.query);
    res.json({ items: await prisma.auditLog.findMany({ where: { orgId: req.orgId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit }), page, limit });
  });
}
