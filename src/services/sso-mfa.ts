import type { Request } from "express";
import { prisma } from "./prisma.js";
import { atomic } from "./audit.js";
import { hashApiKey } from "../crypto/apiKey.js";
import { assert } from "../http.js";
import { useSecondFactor } from "./mfa.js";
import { ssoSession } from "./sso-identities.js";
import type { OidcRegistry } from "../providers/oidc.js";

export async function finishSsoMfa(req: Request, registry: OidcRegistry, token: string, code: string) {
  const tokenHash = await hashApiKey(token);
  // Persist the attempt budget even when factor validation rolls back below.
  const attempt = await prisma.ssoMfaChallenge.updateMany({ where: { tokenHash, attemptsLeft: { gt: 0 }, expiresAt: { gt: new Date() } },
    data: { attemptsLeft: { decrement: 1 } } });
  assert(attempt.count === 1, 401, "SSO_CHALLENGE_INVALID", "MFA challenge expired, exhausted or already used");
  return atomic(req, async db => {
    const challenge = await db.ssoMfaChallenge.findUnique({ where: { tokenHash }, include: { identity: { include: { user: true } } } });
    assert(challenge && challenge.expiresAt > new Date(), 401, "SSO_CHALLENGE_INVALID", "MFA challenge no longer active");
    const identity = challenge.identity, provider = registry.get(identity.providerId);
    assert(challenge.configHash === registry.fingerprint(provider), 401, "SSO_CHALLENGE_INVALID", "Provider configuration changed; restart sign-in");
    assert(!identity.user.disabled, 401, "ACCOUNT_DISABLED", "Account is disabled");
    // If local MFA was disabled after this challenge, demand a fresh external login.
    assert(identity.user.totpSecret, 401, "SSO_CHALLENGE_INVALID", "MFA configuration changed; restart sign-in");
    await useSecondFactor(db, identity.user, code);
    const consumed = await db.ssoMfaChallenge.deleteMany({ where: { id: challenge.id } });
    assert(consumed.count === 1, 401, "SSO_CHALLENGE_INVALID", "MFA challenge already used");
    return ssoSession(db, req, identity);
  });
}
