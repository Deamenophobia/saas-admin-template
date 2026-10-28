// Adapted from kokoro-account/services/auth.ts: retain Prisma transactions and email-token flow.
// Password hashing comes from kokoro-auth; tokens are hashed and consumed atomically.
import { randomBytes } from "node:crypto";
import type { Request } from "express";
import type { TokenPurpose } from "@prisma/client";
import { prisma } from "./prisma.js";
import { hashPassword } from "../crypto/password.js";
import { hashApiKey } from "../crypto/apiKey.js";
import { config } from "../config.js";
import { assert } from "../http.js";
import { atomic, audit } from "./audit.js";
import type { MailSender } from "./email.js";

export const newToken = () => randomBytes(32).toString("hex");
export async function issueAccountToken(userId: string, purpose: TokenPurpose, send: MailSender) {
  const token = newToken();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await prisma.accountToken.create({ data: { userId, purpose, tokenHash: await hashApiKey(token),
    expiresAt: new Date(Date.now() + config.tokenMs) } });
  await send({ to: user.email, template: purpose === "VERIFY" ? "verify" : "reset", token });
}
export async function register(input: { email: string; name: string; password: string }, req: Request, send: MailSender) {
  assert(config.ALLOW_REGISTRATION === "true", 403, "REGISTRATION_DISABLED", "Registration disabled");
  const passwordHash = await hashPassword(input.password);
  const user = await atomic(req, async db => {
    const result = await db.user.create({ data: { email: input.email, name: input.name, passwordHash } });
    await audit(db, req, "user.created", result.id);
    return result;
  });
  await issueAccountToken(user.id, "VERIFY", send);
  return { userId: user.id };
}
export async function consumeToken(input: { token: string; password?: string }, purpose: TokenPurpose, req: Request) {
  const tokenHash = await hashApiKey(input.token);
  const passwordHash = input.password ? await hashPassword(input.password) : undefined;
  await atomic(req, async db => {
    const record = await db.accountToken.findUnique({ where: { tokenHash }, include: { user: true } });
    assert(record && record.purpose === purpose && record.expiresAt > new Date() && !record.user.disabled,
      400, "INVALID_TOKEN", "Invalid or expired token");
    assert(purpose !== "RESET" || record.user.passwordHash, 400, "INVALID_TOKEN", "Password recovery is not available for this account");
    const claimed = await db.accountToken.deleteMany({ where: { id: record.id } });
    assert(claimed.count === 1, 400, "INVALID_TOKEN", "Token already used");
    await db.user.update({ where: { id: record.userId }, data: purpose === "VERIFY" ? { emailVerified: true } : { passwordHash } });
    if (purpose === "RESET") {
      await db.accountToken.deleteMany({ where: { userId: record.userId, purpose } });
      await db.session.deleteMany({ where: { userId: record.userId } });
    }
    await audit(db, req, purpose === "VERIFY" ? "user.verified" : "user.password_reset", record.userId);
  });
}
