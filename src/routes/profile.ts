import type { Express } from "express";
import { z } from "zod";
import { prisma } from "../services/prisma.js";
import { endpoint, nameSchema, passwordSchema, safeUser, assert } from "../http.js";
import { human } from "../middleware/access.js";
import { verifyPassword, hashPassword } from "../crypto/password.js";
import { hashApiKey } from "../crypto/apiKey.js";
import { encryptField, decryptField } from "../crypto/encryption.js";
import { buildOtpauthUri, generateSecret, verifyCode } from "../crypto/totp.js";
import { newToken } from "../services/accounts.js";
import { useSecondFactor } from "../services/mfa.js";
import { atomic, audit } from "../services/audit.js";

export function profileRoutes(app: Express) {
  endpoint(app, "get", "/api/v1/me", async (req, res) => {
    res.json(await prisma.user.findUniqueOrThrow({ where: { id: human(req) }, select: { ...safeUser, totpSecret: false } }));
  });
  endpoint(app, "patch", "/api/v1/me", async (req, res) => {
    const data = z.object({ name: nameSchema }).strict().parse(req.body);
    const id = human(req);
    res.json(await atomic(req, async db => {
      const user = await db.user.update({ where: { id }, data, select: safeUser });
      await audit(db, req, "user.updated", id);
      return user;
    }));
  });
  endpoint(app, "post", "/api/v1/me/password", async (req, res) => {
    const id = human(req);
    const input = z.object({ currentPassword: z.string().max(256), password: passwordSchema, code: z.string().max(128).optional() }).parse(req.body);
    const passwordHash = await hashPassword(input.password);
    await atomic(req, async db => {
      const user = await db.user.findUniqueOrThrow({ where: { id } });
      assert(user.passwordHash && await verifyPassword(input.currentPassword, user.passwordHash), 401, "INVALID_LOGIN", "Local password required");
      await useSecondFactor(db, user, input.code);
      await db.user.update({ where: { id }, data: { passwordHash } });
      await db.session.deleteMany({ where: { userId: id } });
      await audit(db, req, "user.password_changed", id);
    });
    res.json({ success: true, signInRequired: true });
  });
  endpoint(app, "get", "/api/v1/me/sessions", async (req, res) => {
    res.json(await prisma.session.findMany({ where: { userId: human(req) }, select: { id: true, createdAt: true, expiresAt: true } }));
  });
  endpoint(app, "delete", "/api/v1/me/sessions/:id", async (req, res) => {
    const userId = human(req);
    await atomic(req, async db => {
      const result = await db.session.deleteMany({ where: { id: req.params.id, userId } });
      assert(result.count, 404, "NOT_FOUND", "Session not found");
      await audit(db, req, "session.revoked", req.params.id);
    });
    res.status(204).end();
  });
  endpoint(app, "post", "/api/v1/logout", async (req, res) => {
    human(req);
    await atomic(req, async db => {
      await db.session.deleteMany({ where: { id: req.identity.sessionId } });
      await audit(db, req, "user.logout");
    });
    res.status(204).end();
  });
  mfaRoutes(app);
}

function mfaRoutes(app: Express) {
  endpoint(app, "post", "/api/v1/me/mfa/enroll", async (req, res) => {
    const id = human(req);
    const { password } = z.object({ password: z.string().max(256) }).parse(req.body);
    const secret = generateSecret();
    const email = await atomic(req, async db => {
      const user = await db.user.findUniqueOrThrow({ where: { id } });
      assert(!user.totpSecret && user.passwordHash && await verifyPassword(password, user.passwordHash), 400, "MFA_ENROLLMENT_DENIED", "Check local password and existing MFA enrollment");
      await db.user.update({ where: { id }, data: { pendingTotpSecret: await encryptField(secret) } });
      await audit(db, req, "user.mfa_enrollment_started", id);
      return user.email;
    });
    res.json({ uri: buildOtpauthUri(email, secret) });
  });
  endpoint(app, "post", "/api/v1/me/mfa/confirm", async (req, res) => {
    const id = human(req);
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const recoveryCodes = Array.from({ length: 8 }, () => newToken());
    await atomic(req, async db => {
      const user = await db.user.findUniqueOrThrow({ where: { id } });
      assert(!user.totpSecret && user.pendingTotpSecret && verifyCode(await decryptField(user.pendingTotpSecret), code),
        400, "INVALID_MFA", "Invalid enrollment code");
      await db.user.update({ where: { id }, data: { totpSecret: user.pendingTotpSecret, pendingTotpSecret: null, totpLastStep: -1 } });
      await useSecondFactor(db, { ...user, totpSecret: user.pendingTotpSecret }, code);
      await db.recoveryCode.deleteMany({ where: { userId: id } });
      await db.recoveryCode.createMany({ data: await Promise.all(recoveryCodes.map(async c => ({ userId: id, codeHash: await hashApiKey(c) }))) });
      await db.session.deleteMany({ where: { userId: id, id: { not: req.identity.sessionId } } });
      await audit(db, req, "user.mfa_enabled", id);
    });
    res.json({ recoveryCodes });
  });
  endpoint(app, "delete", "/api/v1/me/mfa", async (req, res) => {
    const id = human(req);
    const body = z.object({ password: z.string().max(256), code: z.string().max(128) }).parse(req.body);
    await atomic(req, async db => {
      const user = await db.user.findUniqueOrThrow({ where: { id } });
      assert(user.passwordHash && await verifyPassword(body.password, user.passwordHash), 401, "INVALID_LOGIN", "Local password required");
      await useSecondFactor(db, user, body.code);
      await db.user.update({ where: { id }, data: { totpSecret: null, pendingTotpSecret: null, totpLastStep: -1 } });
      await db.recoveryCode.deleteMany({ where: { userId: id } });
      await audit(db, req, "user.mfa_disabled", id);
    });
    res.status(204).end();
  });
}
