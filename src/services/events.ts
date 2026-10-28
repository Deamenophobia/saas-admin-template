// Transactional enqueue adapted from crypto-payment-core/src/events.ts (MIT).
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import type { Db } from "./audit.js";

export interface DomainEvent {
  id: string;
  version: 1;
  type: string;
  occurredAt: string;
  organizationId: string | null;
  actorId: string | null;
  data: Prisma.JsonObject;
}
export async function enqueue(db: Db, event: DomainEvent) {
  await db.integrationEvent.create({ data: { id: event.id, orgId: event.organizationId, type: event.type,
    body: event as unknown as Prisma.InputJsonObject } });
}
export type EventSender = (event: DomainEvent, context: { signal: AbortSignal }) => Promise<void>;
// One logical subscriber, at-least-once delivery. Call from your worker/CLI; no scheduler is installed.
// Consumers deduplicate by event.id. Expired leases can deliver again, even after a successful send.
export async function dispatchEvents(send: EventSender, options: { limit?: number; leaseMs?: number; retryMs?: number } = {}) {
  const { limit = 25, leaseMs = 30000, retryMs = 5000 } = options;
  if (![limit, leaseMs, retryMs].every(Number.isSafeInteger) || limit < 1 || limit > 100 || leaseMs < 100 || retryMs < 0) {
    throw new Error("Invalid event dispatch options");
  }
  const eligible = () => ({ deliveredAt: null, availableAt: { lte: new Date() },
    OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] });
  const rows = await prisma.integrationEvent.findMany({ where: eligible(), orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limit });
  let delivered = 0, failed = 0;
  for (const row of rows) {
    const leaseToken = randomUUID();
    const claimed = await prisma.integrationEvent.updateMany({ where: { id: row.id, ...eligible() },
      data: { leaseToken, leaseUntil: new Date(Date.now() + leaseMs), attempts: { increment: 1 } } });
    if (!claimed.count) continue;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.resolve().then(() => send(row.body as unknown as DomainEvent, { signal: controller.signal })),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Delivery timed out")); }, leaseMs); })]);
      const result = await prisma.integrationEvent.updateMany({ where: { id: row.id, leaseToken, deliveredAt: null },
        data: { deliveredAt: new Date(), leaseUntil: null, leaseToken: null } });
      delivered += result.count;
    } catch {
      const result = await prisma.integrationEvent.updateMany({ where: { id: row.id, leaseToken, deliveredAt: null },
        data: { availableAt: new Date(Date.now() + retryMs), leaseUntil: null, leaseToken: null } });
      failed += result.count;
    } finally { if (timer) clearTimeout(timer); }
  }
  return { delivered, failed };
}
