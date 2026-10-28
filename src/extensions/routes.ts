import type { Express } from "express";
import { ApiError, assert, endpoint } from "../http.js";
import { permit } from "../middleware/access.js";
import { atomic, audit } from "../services/audit.js";
import type { AccessPolicy } from "./policy.js";
import type { EntitlementProvider, ProductExtension } from "./contracts.js";

export function validateExtensions(extensions: readonly ProductExtension[], policy: AccessPolicy) {
  const names = new Set<string>(), routes = new Set<string>();
  for (const extension of extensions) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(extension.id) || names.has(extension.id)) throw new Error("Invalid or duplicate extension id");
    names.add(extension.id);
    const lifecycleTypes = ["organization.created", "organization.suspended", "organization.resumed", "membership.added", "membership.removed", "user.suspended", "user.resumed"];
    if (Object.keys(extension.lifecycle ?? {}).some(type => !lifecycleTypes.includes(type))) throw new Error("Unsupported lifecycle hook");
    for (const route of extension.routes) {
      const key = `${extension.id}:${route.method}:${route.path}`;
      if (!/^\/(?:[a-z][a-z0-9-]*|:id)(?:\/(?:[a-z][a-z0-9-]*|:id))*$/.test(route.path)
        || routes.has(key) || !policy.scopes.includes(route.permission)) throw new Error("Invalid product route or permission");
      routes.add(key);
    }
  }
}
export function productRoutes(app: Express, extensions: readonly ProductExtension[], entitlements?: EntitlementProvider) {
  for (const extension of extensions) for (const route of extension.routes) {
    endpoint(app, route.method, `/api/v1/orgs/:orgId/extensions/${extension.id}${route.path}`, async (req, res) => {
      permit(req, route.permission);
      const result = await atomic(req, async db => {
        if (route.feature) {
          let allowed = false;
          try { allowed = await entitlements?.allows(db, req.orgId, route.feature) ?? false; }
          catch { throw new ApiError(503, "ENTITLEMENTS_UNAVAILABLE", "Feature access could not be checked"); }
          assert(allowed, 403, "FEATURE_DISABLED", "This feature is not enabled for the organization");
        }
        return route.handle({ db, organizationId: req.orgId, userId: req.identity.userId,
          emit: async (type, id, data) => {
            assert(type.startsWith(`${extension.id}.`), 422, "INVALID_EVENT_TYPE", "Product events must use their extension namespace");
            await audit(db, req, type, id, data);
          } }, req);
      });
      if (route.status === 204) res.status(204).end();
      else res.status(route.status ?? 200).json(result);
    });
  }
}
