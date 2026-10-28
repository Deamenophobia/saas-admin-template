// Adapted from kokoro-account/auth/passport.ts: subject mapping, disabled-user checks,
// and transactional account creation. Email never implicitly links local accounts.
import type { ExternalIdentity, SsoFlow } from "@prisma/client";
import type { Request } from "express";
import { config } from "../config.js";
import { assert, emailSchema, nameSchema } from "../http.js";
import { atomic, audit, type Db } from "./audit.js";
import { newToken } from "./accounts.js";
import { hashApiKey } from "../crypto/apiKey.js";
import type { OidcIdentity } from "../providers/oidc.js";

export async function ssoSession(db: Db, req: Request, identity: ExternalIdentity) {
  const token = newToken();
  const session = await db.session.create({ data: { userId: identity.userId, ssoIdentityId: identity.id,
    tokenHash: await hashApiKey(token), expiresAt: new Date(Date.now() + config.sessionMs) } });
  req.identity = { userId: identity.userId };
  await audit(db, req, "sso.login", session.id, { providerId: identity.providerId });
  return { token, tokenType: "Bearer" as const, expiresAt: session.expiresAt };
}
export async function acceptSsoIdentity(req: Request, flow: SsoFlow, identity: OidcIdentity) {
  return atomic(req, async db => {
    const existing = await db.externalIdentity.findUnique({ where: { issuer_subject: { issuer: identity.issuer, subject: identity.subject } }, include: { user: true } });
    assert(!existing || existing.providerId === flow.providerId, 409, "SSO_IDENTITY_CONFLICT", "Identity belongs to another provider configuration");
    if (flow.linkSessionId) {
      const session = await db.session.findUnique({ where: { id: flow.linkSessionId }, include: { user: true } });
      assert(session && !session.user.disabled && session.user.emailVerified && session.expiresAt > new Date(),
        401, "SESSION_REVOKED", "Linking session no longer active");
      assert(!existing || existing.userId === session.userId, 409, "SSO_IDENTITY_CONFLICT", "Identity is already linked to another user");
      const linked = existing ?? await db.externalIdentity.create({ data: { userId: session.userId, providerId: flow.providerId,
        issuer: identity.issuer, subject: identity.subject } });
      req.identity = { userId: session.userId };
      await audit(db, req, "sso.linked", linked.id, { providerId: flow.providerId });
      return { linked: true as const };
    }
    let linked = existing;
    if (!linked) {
      assert(config.ALLOW_REGISTRATION === "true", 403, "REGISTRATION_DISABLED", "New account registration is disabled");
      const email = emailSchema.safeParse(identity.email);
      assert(identity.emailVerified && email.success, 403, "SSO_VERIFIED_EMAIL_REQUIRED", "Provider must supply a verified email to create an account");
      const byEmail = await db.user.findUnique({ where: { email: email.data } });
      assert(!byEmail, 409, "SSO_LINK_REQUIRED", "Sign in with the existing method and explicitly link this provider");
      const name = nameSchema.safeParse(identity.name);
      const user = await db.user.create({ data: { email: email.data, name: name.success ? name.data : email.data.slice(0, 100), emailVerified: true } });
      linked = await db.externalIdentity.create({ data: { userId: user.id, providerId: flow.providerId,
        issuer: identity.issuer, subject: identity.subject }, include: { user: true } });
      req.identity = { userId: user.id };
      await audit(db, req, "user.created", user.id);
      await audit(db, req, "sso.linked", linked.id, { providerId: flow.providerId });
    }
    assert(!linked.user.disabled, 401, "ACCOUNT_DISABLED", "Account is disabled");
    if (linked.user.totpSecret) {
      const challengeToken = newToken(), expiresAt = new Date(Date.now() + config.SSO_MFA_MINUTES * 60000);
      await db.ssoMfaChallenge.deleteMany({ where: { expiresAt: { lte: new Date() } } });
      await db.ssoMfaChallenge.create({ data: { tokenHash: await hashApiKey(challengeToken), identityId: linked.id,
        configHash: flow.configHash, attemptsLeft: config.SSO_MFA_ATTEMPTS, expiresAt } });
      return { mfaRequired: true as const, challengeToken, expiresAt };
    }
    return ssoSession(db, req, linked);
  });
}
