import type { Express } from "express";
import type { ProductExtension } from "../extensions/contracts.js";
import type { CredentialProvider } from "../providers/credentials.js";
import { endpoint, pagination } from "../http.js";
import { permit } from "../middleware/access.js";
import { prisma } from "../services/prisma.js";

export function capabilityRoutes(app: Express, extensions: readonly ProductExtension[], provider: CredentialProvider, entitlements: boolean) {
  endpoint(app, "get", "/api/v1/orgs/:orgId/capabilities", async (req, res) => {
    permit(req, "organizations.read");
    res.json({ contractVersion: 1, permissions: req.accessPolicy.roles[req.role].filter(scope => !req.identity.scopes || req.identity.scopes.includes(scope)),
      extensions: extensions.map(e => e.id), entitlements,
      credentialProvisioning: { contractVersion: provider.contractVersion, capabilities: provider.capabilities } });
  });
  endpoint(app, "get", "/api/v1/orgs/:orgId/events", async (req, res) => {
    permit(req, "audit.read");
    const { page, limit } = pagination.parse(req.query);
    const events = await prisma.integrationEvent.findMany({ where: { orgId: req.orgId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit });
    res.json({ items: events.map(event => event.body), page, limit });
  });
}
