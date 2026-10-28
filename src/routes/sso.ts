import type { Express } from "express";
import { z } from "zod";
import { endpoint, tokenSchema, assert } from "../http.js";
import { human } from "../middleware/access.js";
import { startSso, consumeSso } from "../services/sso-flows.js";
import { acceptSsoIdentity } from "../services/sso-identities.js";
import { finishSsoMfa } from "../services/sso-mfa.js";
import { prisma } from "../services/prisma.js";
import { atomic, audit } from "../services/audit.js";
import { verifyPassword } from "../crypto/password.js";
import { useSecondFactor } from "../services/mfa.js";
import type { OidcRegistry } from "../providers/oidc.js";

const reauthenticate = z.object({ password: z.string().max(256), code: z.string().max(128).optional() }).strict();
export function publicSsoRoutes(app: Express, registry: OidcRegistry) {
  endpoint(app, "get", "/api/v1/auth/sso/providers", async (_req, res) => { res.json(registry.list()); });
  endpoint(app, "post", "/api/v1/auth/sso/:provider/start", async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    res.json(await startSso(req, registry, req.params.provider));
  });
  endpoint(app, "post", "/api/v1/auth/sso/:provider/complete", async (req, res) => {
    const input = z.object({ state: tokenSchema, code: z.string().min(1).max(4096), flowToken: tokenSchema,
      iss: z.string().url().max(2048).optional() }).strict().parse(req.body);
    const { flow, identity } = await consumeSso(registry, req.params.provider, input);
    const result = await acceptSsoIdentity(req, flow, identity);
    res.status("mfaRequired" in result ? 202 : 200).json(result);
  });
  endpoint(app, "post", "/api/v1/auth/sso/mfa", async (req, res) => {
    const { challengeToken, code } = z.object({ challengeToken: tokenSchema, code: z.string().min(1).max(128) }).strict().parse(req.body);
    res.json(await finishSsoMfa(req, registry, challengeToken, code));
  });
}
export function privateSsoRoutes(app: Express, registry: OidcRegistry) {
  endpoint(app, "get", "/api/v1/me/sso", async (req, res) => {
    res.json(await prisma.externalIdentity.findMany({ where: { userId: human(req) },
      select: { id: true, providerId: true, issuer: true, createdAt: true }, orderBy: { createdAt: "asc" } }));
  });
  endpoint(app, "post", "/api/v1/me/sso/:provider/link/start", async (req, res) => {
    human(req);
    res.json(await startSso(req, registry, req.params.provider, reauthenticate.parse(req.body)));
  });
  endpoint(app, "delete", "/api/v1/me/sso/:id", async (req, res) => {
    const userId = human(req), input = reauthenticate.parse(req.body);
    await atomic(req, async db => {
      const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
      assert(user.passwordHash && user.emailVerified && await verifyPassword(input.password, user.passwordHash),
        401, "REAUTHENTICATION_REQUIRED", "Verified local account and current password required");
      await useSecondFactor(db, user, input.code);
      // FK cascades revoke SSO sessions/challenges; a usable local login remains.
      const removed = await db.externalIdentity.deleteMany({ where: { id: req.params.id, userId } });
      assert(removed.count === 1, 404, "NOT_FOUND", "Linked identity not found");
      await audit(db, req, "sso.unlinked", req.params.id);
    });
    res.status(204).end();
  });
}
