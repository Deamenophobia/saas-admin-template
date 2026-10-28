import type { Request } from "express";
import { Prisma, type Operation } from "@prisma/client";
import { prisma } from "./prisma.js";
import { atomic, audit, commitAudit } from "./audit.js";
import { hashApiKey } from "../crypto/apiKey.js";
import { canonicalJson } from "../crypto/canonicalJson.js";
import { encryptField } from "../crypto/encryption.js";
import { config } from "../config.js";
import { ApiError, assert } from "../http.js";
import type { CredentialProvider } from "../providers/credentials.js";

export type ProvisionInput = { kind: "issue"; name: string } | { kind: "revoke"; credentialId: string };
export const operationView = (op: Operation) => ({ id: op.id, status: op.status, kind: op.kind,
  credentialId: op.credentialId, errorCode: op.errorCode, updatedAt: op.updatedAt });

async function claim(req: Request, input: ProvisionInput, requestKey: string) {
  const requestHash = await hashApiKey(canonicalJson(input));
  const legacyHash = await hashApiKey(JSON.stringify(input));
  const leaseUntil = new Date(Date.now() + config.PROVIDER_TIMEOUT_MS * 3);
  // Recheck authorization while accepting work, before any external side effect.
  // One retry handles competing inserts for the same idempotency key.
  for (let attempt = 0; ; attempt++) {
    try {
      return await atomic(req, async db => {
        const op = await db.operation.findUnique({ where: { orgId_requestKey: { orgId: req.orgId, requestKey } } });
        if (!op) return { op: await db.operation.create({ data: { orgId: req.orgId, requestKey, requestHash,
          kind: input.kind, input, leaseUntil } }), owned: true };
        assert(op.requestHash === requestHash || op.requestHash === legacyHash, 409, "IDEMPOTENCY_CONFLICT", "This key belongs to a different request");
        if (op.status === "SUCCEEDED") return { op, owned: false };
        const result = await db.operation.updateMany({ where: { id: op.id, OR: [
          { status: "FAILED" }, { status: "PENDING", leaseUntil: { lt: new Date() } }] },
          data: { status: "PENDING", errorCode: null, leaseUntil } });
        return { op: result.count ? { ...op, status: "PENDING" as const, leaseUntil } : op, owned: result.count === 1 };
      });
    } catch (err) {
      if (attempt || !(err instanceof Prisma.PrismaClientKnownRequestError) || !["P2002", "P2034"].includes(err.code)) throw err;
    }
  }
}

export async function provision(req: Request, input: ProvisionInput, requestKey: string, provider: CredentialProvider) {
  assert(provider.capabilities.includes(input.kind), 503, "PROVIDER_CAPABILITY_UNAVAILABLE", "Provider does not support this operation");
  // Validate tenant ownership before recording or sending a revoke request.
  const existing = input.kind === "revoke" ? await prisma.credential.findFirst({
    where: { id: input.credentialId, orgId: req.orgId } }) : null;
  if (input.kind === "revoke") assert(existing, 404, "NOT_FOUND", "Credential not found");
  const { op, owned } = await claim(req, input, requestKey);
  if (!owned) return operationView(op);
  const context = { contractVersion: 1 as const, organizationId: req.orgId, operationId: op.id };
  try {
    const issued = input.kind === "issue" ? await provider.issue(context, input.name) : undefined;
    if (existing && !existing.revokedAt) await provider.revoke(context, existing.providerRef);
    const encryptedSecret = issued?.secret ? await encryptField(issued.secret) : null;
    // Persist the actual result of accepted work even if the initiating session
    // expires in flight. The operation lease still fences stale completions.
    await commitAudit(req, async db => {
      const fence = await db.operation.updateMany({ where: { id: op.id, status: "PENDING", leaseUntil: op.leaseUntil }, data: { status: "SUCCEEDED" } });
      assert(fence.count, 409, "OPERATION_RECLAIMED", "Another attempt owns this operation");
      let credentialId = existing?.id;
      if (issued && input.kind === "issue") {
        const credential = await db.credential.upsert({
          where: { orgId_provider_providerRef: { orgId: req.orgId, provider: "external", providerRef: issued.reference } },
          create: { orgId: req.orgId, name: input.name, provider: "external", providerRef: issued.reference, encryptedSecret },
          update: {},
        });
        credentialId = credential.id;
      } else if (existing) {
        await db.credential.update({ where: { id: existing.id }, data: { revokedAt: new Date(), encryptedSecret: null } });
      }
      await db.operation.update({ where: { id: op.id }, data: { credentialId } });
      await audit(db, req, input.kind === "issue" ? "external_credential.issued" : "external_credential.revoked", credentialId);
    });
  } catch (err) {
    const code = err instanceof ApiError ? err.code : "PROVIDER_UNAVAILABLE";
    await prisma.operation.updateMany({ where: { id: op.id, status: "PENDING", leaseUntil: op.leaseUntil }, data: { status: "FAILED", errorCode: code } });
  }
  return operationView(await prisma.operation.findUniqueOrThrow({ where: { id: op.id } }));
}
