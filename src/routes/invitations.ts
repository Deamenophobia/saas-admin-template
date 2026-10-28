// Completes kokoro-pipeline's invitation flow using kokoro-account one-time token patterns.
import type { Express } from "express";
import { z } from "zod";
import { prisma } from "../services/prisma.js";
import { config } from "../config.js";
import { endpoint, assert, emailSchema, tokenSchema, nameSchema, passwordSchema } from "../http.js";
import { human, permit } from "../middleware/access.js";
import { newToken } from "../services/accounts.js";
import { hashApiKey } from "../crypto/apiKey.js";
import { hashPassword } from "../crypto/password.js";
import { atomic, audit, type Db } from "../services/audit.js";
import type { MailSender } from "../services/email.js";
import { roleSchema } from "./members.js";

async function pendingInvitation(db: Db, token: string) {
  const invite = await db.invitation.findUnique({ where: { tokenHash: await hashApiKey(token) } });
  assert(invite && !invite.acceptedAt && invite.expiresAt > new Date(), 400, "INVALID_INVITATION", "Invitation expired or already used");
  const org = await db.organization.findUnique({ where: { id: invite.orgId } });
  assert(org && !org.suspended, 403, "ORGANIZATION_SUSPENDED", "Organization is suspended");
  return invite;
}
export function invitationRegistration(app: Express) {
  endpoint(app, "post", "/api/v1/auth/invitations/register", async (req, res) => {
    const body = z.object({ token: tokenSchema, name: nameSchema, password: passwordSchema }).strict().parse(req.body);
    const passwordHash = await hashPassword(body.password);
    const user = await atomic(req, async db => {
      const invite = await pendingInvitation(db, body.token);
      const existing = await db.user.findUnique({ where: { email: invite.email } });
      assert(!existing, 409, "SIGN_IN_REQUIRED", "Sign in to accept this invitation");
      const result = await db.user.create({ data: { email: invite.email, name: body.name, passwordHash, emailVerified: true } });
      const member = await db.membership.create({ data: { userId: result.id, orgId: invite.orgId, role: invite.role } });
      await db.invitation.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
      req.orgId = invite.orgId; req.identity = { userId: result.id };
      await audit(db, req, "invitation.accepted", invite.id);
      await audit(db, req, "membership.added", member.id, { userId: result.id, role: invite.role });
      return { userId: result.id, orgId: invite.orgId };
    });
    res.status(201).json(user);
  });
}
export function invitationRoutes(app: Express, send: MailSender) {
  endpoint(app, "post", "/api/v1/invitations/accept", async (req, res) => {
    const userId = human(req);
    const { token } = z.object({ token: tokenSchema }).parse(req.body);
    await atomic(req, async db => {
      const invite = await pendingInvitation(db, token);
      const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
      assert(user.email === invite.email, 403, "FORBIDDEN", "Invitation belongs to another account");
      const member = await db.membership.create({ data: { userId, orgId: invite.orgId, role: invite.role } });
      await db.invitation.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
      req.orgId = invite.orgId;
      await audit(db, req, "invitation.accepted", invite.id);
      await audit(db, req, "membership.added", member.id, { userId, role: invite.role });
    });
    res.status(204).end();
  });
  endpoint(app, "post", "/api/v1/orgs/:orgId/invitations", async (req, res) => {
    human(req); permit(req, "members.write");
    const body = z.object({ email: emailSchema, role: roleSchema.default("MEMBER") }).strict().parse(req.body);
    assert(body.role !== "OWNER" || req.role === "OWNER", 403, "FORBIDDEN", "Only owners can invite owners");
    const token = newToken();
    const invite = await atomic(req, async db => {
      const result = await db.invitation.create({ data: { orgId: req.orgId, ...body,
        tokenHash: await hashApiKey(token), expiresAt: new Date(Date.now() + config.invitationMs) } });
      await audit(db, req, "invitation.created", result.id);
      return result;
    });
    await send({ to: body.email, template: "invite", token });
    res.status(201).json({ id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt });
  });
  endpoint(app, "get", "/api/v1/orgs/:orgId/invitations", async (req, res) => {
    permit(req, "members.write");
    res.json(await prisma.invitation.findMany({ where: { orgId: req.orgId, acceptedAt: null }, take: 100,
      select: { id: true, email: true, role: true, expiresAt: true } }));
  });
  endpoint(app, "delete", "/api/v1/orgs/:orgId/invitations/:id", async (req, res) => {
    human(req); permit(req, "members.write");
    await atomic(req, async db => {
      const deleted = await db.invitation.deleteMany({ where: { id: req.params.id, orgId: req.orgId, acceptedAt: null } });
      assert(deleted.count, 404, "NOT_FOUND", "Invitation not found");
      await audit(db, req, "invitation.cancelled", req.params.id);
    });
    res.status(204).end();
  });
}
