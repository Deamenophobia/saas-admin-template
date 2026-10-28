// Adapted from kokoro-account/services/audit-log.ts; writes join mutation transactions.
import type { Prisma } from "@prisma/client";
import type { Request } from "express";
import { prisma } from "./prisma.js";
import { assert } from "../http.js";
import { enqueue, type DomainEvent } from "./events.js";
import type { LifecycleType } from "../extensions/contracts.js";
export type Db = Prisma.TransactionClient;
export async function audit(db: Db, req: Request, action: string, resourceId?: string, details: Prisma.InputJsonObject = {}) {
  const data = { orgId: req.orgId ?? null,
    actorId: req.identity?.userId ?? req.identity?.serviceAccountId ?? null, action, resourceId };
  const event = await db.auditLog.create({ data });
  const envelope: DomainEvent = { id: event.id, version: 1, type: action, occurredAt: event.createdAt.toISOString(),
    organizationId: data.orgId, actorId: data.actorId, data: { ...details, ...(resourceId ? { resourceId } : {}) } as Prisma.JsonObject };
  for (const extension of req.extensions ?? []) await extension.lifecycle?.[action as LifecycleType]?.(db, envelope);
  await enqueue(db, envelope);
  req.auditEvents?.push(envelope);
  return event;
}
// Lifecycle hooks share the transaction. External side effects use the durable outbox.
// Low-level completion helper: only for an already-authorized durable operation.
export async function commitAudit<T>(req: Request, fn: (db: Db) => Promise<T>): Promise<T> {
  const offset = req.auditEvents?.length ?? 0;
  let result: T;
  try {
    result = await prisma.$transaction(fn, { isolationLevel: "Serializable", timeout: 10000 });
  } catch (error) {
    req.auditEvents?.splice(offset);
    throw error;
  }
  for (const event of req.auditEvents?.splice(offset) ?? []) {
    void Promise.resolve().then(() => req.onEvent?.(event)).catch(() => {
      console.error(JSON.stringify({ request_id: req.requestId, code: "EVENT_HOOK_FAILED" }));
    });
  }
  return result;
}

export async function atomic<T>(req: Request, fn: (db: Db) => Promise<T>): Promise<T> {
  return commitAudit(req, async db => {
    const actor = req.identity;
    if (req.orgId) {
      const org = await db.organization.findUnique({ where: { id: req.orgId } });
      assert(org && !org.suspended, 403, "ORGANIZATION_SUSPENDED", "Organization is suspended");
    }
    if (actor?.sessionId) {
      const session = await db.session.findUnique({ where: { id: actor.sessionId }, include: { user: true } });
      assert(session && !session.user.disabled && session.expiresAt > new Date(), 401, "SESSION_REVOKED", "Session no longer active");
    }
    if (actor?.apiKeyId) {
      const key = await db.apiKey.findUnique({ where: { id: actor.apiKeyId }, include: { user: true, serviceAccount: true } });
      assert(key && !key.revokedAt && key.expiresAt > new Date() && !key.user?.disabled && !key.serviceAccount?.disabled,
        401, "KEY_REVOKED", "Key no longer active");
    }
    if (req.orgId && actor?.userId && req.role) {
      const membership = await db.membership.findUnique({ where: { userId_orgId: { userId: actor.userId, orgId: req.orgId } } });
      assert(membership && membership.role === req.role, 409, "ACCESS_CHANGED", "Organization access changed; retry request");
    }
    return fn(db);
  });
}
