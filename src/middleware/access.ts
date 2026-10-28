// Adapted from kokoro-pipeline/middleware/{auth,membership}.ts.
import type { Request } from "express";
import { prisma } from "../services/prisma.js";
import { hashApiKey } from "../crypto/apiKey.js";
import { assert, uuidSchema } from "../http.js";

export async function authenticate(req: Request) {
  const raw = req.header("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
  assert(raw && raw.length <= 512, 401, "UNAUTHENTICATED", "Bearer token required");
  const tokenHash = await hashApiKey(raw);
  const session = await prisma.session.findUnique({ where: { tokenHash }, include: { user: true } });
  if (session && session.expiresAt > new Date() && !session.user.disabled) {
    req.identity = { userId: session.userId, sessionId: session.id };
    return;
  }
  const key = await prisma.apiKey.findUnique({ where: { keyHash: tokenHash }, include: { user: true, serviceAccount: true } });
  assert(key && !key.revokedAt && key.expiresAt > new Date(), 401, "INVALID_CREDENTIAL", "Credential expired or revoked");
  if (key.userId) {
    assert(key.user && !key.user.disabled, 401, "INVALID_CREDENTIAL", "Account disabled");
    const member = await prisma.membership.findUnique({ where: { userId_orgId: { userId: key.userId, orgId: key.orgId } } });
    assert(member, 401, "INVALID_CREDENTIAL", "Membership revoked");
  } else assert(key.serviceAccount && !key.serviceAccount.disabled, 401, "INVALID_CREDENTIAL", "Service account disabled");
  req.identity = { apiKeyId: key.id, userId: key.userId ?? undefined, serviceAccountId: key.serviceAccountId ?? undefined, orgId: key.orgId, scopes: key.scopes };
}

export function human(req: Request) {
  assert(req.identity.sessionId && req.identity.userId, 403, "HUMAN_SESSION_REQUIRED", "A user session is required");
  return req.identity.userId;
}
export async function tenant(req: Request) {
  const orgId = uuidSchema.parse(req.params.orgId);
  assert(!req.identity.orgId || req.identity.orgId === orgId, 404, "NOT_FOUND", "Organization not found");
  req.orgId = orgId;
  if (req.identity.serviceAccountId) req.role = "ADMIN";
  else {
    const member = await prisma.membership.findUnique({ where: { userId_orgId: { userId: req.identity.userId!, orgId } } });
    assert(member, 404, "NOT_FOUND", "Organization not found");
    req.role = member.role;
  }
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  assert(org && !org.suspended, 403, "ORGANIZATION_SUSPENDED", "Organization is suspended");
}
export function permit(req: Request, scope: string) {
  assert(req.accessPolicy.roles[req.role].includes(scope), 403, "FORBIDDEN", "Insufficient role");
  assert(!req.identity.scopes || req.identity.scopes.includes(scope), 403, "FORBIDDEN", "Insufficient credential scope");
}
export async function platformAdmin(req: Request) {
  const id = human(req);
  const user = await prisma.user.findUnique({ where: { id } });
  assert(user?.isSuperAdmin, 403, "FORBIDDEN", "Platform administrator required");
}
