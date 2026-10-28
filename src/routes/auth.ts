// Adapted from kokoro-account/routes/auth-local.ts and kokoro-auth session/2FA flows.
import type { Express } from "express";
import { z } from "zod";
import { prisma } from "../services/prisma.js";
import { config } from "../config.js";
import { endpoint, emailSchema, nameSchema, passwordSchema, tokenSchema, assert } from "../http.js";
import { register, consumeToken, issueAccountToken, newToken } from "../services/accounts.js";
import { verifyPassword } from "../crypto/password.js";
import { hashApiKey } from "../crypto/apiKey.js";
import { atomic, audit } from "../services/audit.js";
import { useSecondFactor } from "../services/mfa.js";
import type { MailSender } from "../services/email.js";

export function authRoutes(app: Express, send: MailSender) {
  endpoint(app, "post", "/api/v1/auth/register", async (req, res) => {
    const body = z.object({ email: emailSchema, name: nameSchema, password: passwordSchema }).strict().parse(req.body);
    res.status(201).json(await register(body, req, send));
  });
  endpoint(app, "post", "/api/v1/auth/verify", async (req, res) => {
    await consumeToken(z.object({ token: tokenSchema }).parse(req.body), "VERIFY", req);
    res.json({ success: true });
  });
  for (const [path, purpose] of [["forgot-password", "RESET"], ["resend-verification", "VERIFY"]] as const) {
    endpoint(app, "post", `/api/v1/auth/${path}`, async (req, res) => {
      const { email } = z.object({ email: emailSchema }).parse(req.body);
      const user = await prisma.user.findUnique({ where: { email } });
      if (user && !user.disabled && (purpose === "RESET" ? !!user.passwordHash : !user.emailVerified)) {
        // Delivery outcome must not reveal account existence. EmailLog records failure.
        await issueAccountToken(user.id, purpose, send).catch(() => undefined);
      }
      res.status(202).json({ message: "If eligible, an email will be sent" });
    });
  }
  endpoint(app, "post", "/api/v1/auth/reset-password", async (req, res) => {
    await consumeToken(z.object({ token: tokenSchema, password: passwordSchema }).parse(req.body), "RESET", req);
    res.json({ success: true });
  });
  endpoint(app, "post", "/api/v1/auth/login", async (req, res) => {
    const body = z.object({ email: emailSchema, password: z.string().max(256), code: z.string().max(128).optional() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    assert(user && !user.disabled && user.passwordHash && await verifyPassword(body.password, user.passwordHash), 401, "INVALID_LOGIN", "Invalid credentials");
    assert(user.emailVerified, 403, "EMAIL_UNVERIFIED", "Verify email before signing in");
    const token = newToken();
    const session = await atomic(req, async db => {
      const current = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      assert(!current.disabled && current.passwordHash === user.passwordHash, 401, "INVALID_LOGIN", "Account changed; retry login");
      await useSecondFactor(db, current, body.code);
      const s = await db.session.create({ data: { userId: user.id, tokenHash: await hashApiKey(token), expiresAt: new Date(Date.now() + config.sessionMs) } });
      req.identity = { userId: user.id };
      await audit(db, req, "user.login", s.id);
      return s;
    });
    res.json({ token, tokenType: "Bearer", expiresAt: session.expiresAt });
  });
}
