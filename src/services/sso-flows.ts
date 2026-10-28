// Adapts kokoro-auth's one-use authorization flow and account token hashing to persisted client flows.
import * as oidc from "openid-client";
import type { Request } from "express";
import { config } from "../config.js";
import { prisma } from "./prisma.js";
import { newToken } from "./accounts.js";
import { hashApiKey } from "../crypto/apiKey.js";
import { encryptField, decryptField } from "../crypto/encryption.js";
import { verifyPassword } from "../crypto/password.js";
import { atomic, audit } from "./audit.js";
import { useSecondFactor } from "./mfa.js";
import { human } from "../middleware/access.js";
import { assert } from "../http.js";
import type { OidcRegistry } from "../providers/oidc.js";

export async function startSso(req: Request, registry: OidcRegistry, providerId: string, link?: { password: string; code?: string }) {
  const provider = registry.get(providerId), client = await registry.client(provider);
  const state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier(), flowToken = newToken();
  const url = oidc.buildAuthorizationUrl(client, { response_type: "code", redirect_uri: provider.redirectUri,
    scope: "openid email profile", state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256" });
  const expiresAt = new Date(Date.now() + config.SSO_FLOW_MINUTES * 60000);
  const data = { stateHash: await hashApiKey(state), bindingHash: await hashApiKey(flowToken), providerId,
    configHash: registry.fingerprint(provider), nonce, encryptedVerifier: await encryptField(verifier), expiresAt };
  await atomic(req, async db => {
    if (link) {
      const user = await db.user.findUniqueOrThrow({ where: { id: human(req) } });
      assert(user.passwordHash && user.emailVerified && await verifyPassword(link.password, user.passwordHash),
        401, "REAUTHENTICATION_REQUIRED", "Verified local account and current password required");
      await useSecondFactor(db, user, link.code);
    }
    await db.ssoFlow.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    await db.ssoFlow.create({ data: { ...data, linkSessionId: link ? req.identity.sessionId : null } });
    if (link) await audit(db, req, "sso.link_started", providerId);
  });
  return { authorizationUrl: url.href, flowToken, expiresAt };
}
export async function consumeSso(registry: OidcRegistry, providerId: string,
  input: { state: string; code: string; flowToken: string; iss?: string }) {
  const provider = registry.get(providerId), stateHash = await hashApiKey(input.state), bindingHash = await hashApiKey(input.flowToken);
  const flow = await prisma.ssoFlow.findUnique({ where: { stateHash } });
  assert(flow && flow.providerId === providerId && flow.bindingHash === bindingHash && flow.expiresAt > new Date()
    && flow.configHash === registry.fingerprint(provider), 400, "SSO_INVALID_FLOW", "Sign-in flow expired or invalid");
  // Burn the flow before network IO. Any failure requires a fresh start; no callback replay.
  const claimed = await prisma.ssoFlow.deleteMany({ where: { id: flow.id, bindingHash, expiresAt: { gt: new Date() } } });
  assert(claimed.count === 1, 400, "SSO_INVALID_FLOW", "Sign-in flow already used");
  const identity = await registry.exchange(provider, { code: input.code, state: input.state, iss: input.iss },
    await decryptField(flow.encryptedVerifier), flow.nonce);
  return { flow, identity };
}
