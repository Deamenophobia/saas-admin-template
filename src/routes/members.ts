// Adapted from kokoro-pipeline organization membership routes.
import type { Express } from "express";
import { z } from "zod";
import { prisma } from "../services/prisma.js";
import { endpoint, assert, pagination } from "../http.js";
import { human, permit } from "../middleware/access.js";
import { atomic, audit } from "../services/audit.js";

export const roleSchema = z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
export function memberRoutes(app: Express) {
  endpoint(app, "get", "/api/v1/orgs/:orgId/members", async (req, res) => {
    permit(req, "members.read");
    const { page, limit, search } = pagination.parse(req.query);
    const where = { orgId: req.orgId, ...(search ? { user: { OR: [
      { name: { contains: search, mode: "insensitive" as const } }, { email: { contains: search, mode: "insensitive" as const } }] } } : {}) };
    const [items, total] = await Promise.all([prisma.membership.findMany({ where,
      include: { user: { select: { id: true, name: true, email: true, disabled: true } } },
      orderBy: { id: "asc" }, skip: (page - 1) * limit, take: limit }), prisma.membership.count({ where })]);
    res.json({ items, total, page, limit });
  });
  for (const method of ["patch", "delete"] as const) {
    endpoint(app, method, "/api/v1/orgs/:orgId/members/:id", async (req, res) => {
      human(req); permit(req, "members.write");
      const role = method === "patch" ? z.object({ role: roleSchema }).strict().parse(req.body).role : undefined;
      await atomic(req, async db => {
        const caller = await db.membership.findUniqueOrThrow({ where: { userId_orgId: { userId: req.identity.userId!, orgId: req.orgId } } });
        assert(["ADMIN", "OWNER"].includes(caller.role), 403, "FORBIDDEN", "Insufficient role");
        const member = await db.membership.findFirst({ where: { id: req.params.id, orgId: req.orgId } });
        assert(member, 404, "NOT_FOUND", "Member not found");
        assert((member.role !== "OWNER" && role !== "OWNER") || caller.role === "OWNER", 403, "FORBIDDEN", "Owner role required");
        if (member.role === "OWNER" && role !== "OWNER") {
          const owners = await db.membership.count({ where: { orgId: req.orgId, role: "OWNER" } });
          assert(owners > 1, 409, "LAST_OWNER", "Assign another owner first");
        }
        if (role) await db.membership.update({ where: { id: member.id }, data: { role } });
        else {
          await db.apiKey.updateMany({ where: { orgId: req.orgId, userId: member.userId }, data: { revokedAt: new Date() } });
          await db.membership.delete({ where: { id: member.id } });
        }
        await audit(db, req, role ? "membership.updated" : "membership.removed", member.id, { userId: member.userId, role: role ?? member.role });
      });
      res.status(204).end();
    });
  }
}
