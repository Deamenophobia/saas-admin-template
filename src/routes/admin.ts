// Adapted from kokoro-account/routes/admin/users.ts: retain safe selects/search;
// remove billing/impersonation and enforce session/key revocation on suspension.
import type { Express } from "express";
import { z } from "zod";
import { prisma } from "../services/prisma.js";
import { endpoint, assert, pagination, safeUser, nameSchema } from "../http.js";
import { platformAdmin } from "../middleware/access.js";
import { atomic, audit } from "../services/audit.js";

export function adminRoutes(app: Express) {
  endpoint(app, "get", "/api/v1/admin/users", async (req, res) => {
    await platformAdmin(req);
    const { page, limit, search } = pagination.parse(req.query);
    const where = search ? { OR: [{ name: { contains: search, mode: "insensitive" as const } },
      { email: { contains: search, mode: "insensitive" as const } }] } : {};
    const [items, total] = await Promise.all([prisma.user.findMany({ where, select: safeUser,
      skip: (page - 1) * limit, take: limit, orderBy: { id: "asc" } }), prisma.user.count({ where })]);
    res.json({ items, total, page, limit });
  });
  endpoint(app, "get", "/api/v1/admin/users/:id", async (req, res) => {
    await platformAdmin(req);
    res.json(await prisma.user.findUniqueOrThrow({ where: { id: req.params.id }, select: safeUser }));
  });
  endpoint(app, "patch", "/api/v1/admin/users/:id", async (req, res) => {
    await platformAdmin(req);
    const data = z.object({ name: nameSchema.optional(), disabled: z.boolean().optional() }).strict().parse(req.body);
    assert(!(req.params.id === req.identity.userId && data.disabled), 409, "SELF_SUSPENSION", "Cannot suspend yourself");
    res.json(await atomic(req, async db => {
      const target = await db.user.findUniqueOrThrow({ where: { id: req.params.id } });
      assert(!target.isSuperAdmin || !data.disabled, 409, "ADMIN_PROTECTED", "Platform administrators require operator management");
      const user = await db.user.update({ where: { id: target.id }, data, select: safeUser });
      if (data.disabled) {
        await db.session.deleteMany({ where: { userId: target.id } });
        await db.apiKey.updateMany({ where: { userId: target.id }, data: { revokedAt: new Date() } });
      }
      await audit(db, req, "admin.user_updated", target.id);
      if (data.disabled !== undefined && data.disabled !== target.disabled) {
        await audit(db, req, data.disabled ? "user.suspended" : "user.resumed", target.id, { userId: target.id });
      }
      return user;
    }));
  });
  endpoint(app, "patch", "/api/v1/admin/organizations/:id", async (req, res) => {
    await platformAdmin(req);
    const { suspended } = z.object({ suspended: z.boolean() }).strict().parse(req.body);
    res.json(await atomic(req, async db => {
      // Platform control endpoint intentionally has no tenant context until inside the transaction.
      const admin = await db.user.findUniqueOrThrow({ where: { id: req.identity.userId! } });
      assert(admin.isSuperAdmin, 403, "FORBIDDEN", "Platform administrator required");
      const old = await db.organization.findUniqueOrThrow({ where: { id: req.params.id } });
      const org = await db.organization.update({ where: { id: old.id }, data: { suspended } });
      if (old.suspended !== suspended) {
        req.orgId = old.id;
        await audit(db, req, suspended ? "organization.suspended" : "organization.resumed", old.id);
      }
      return org;
    }));
  });
}
