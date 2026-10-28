import type { ProductExtension, EntitlementProvider } from "../../src/extensions/contracts.js";
import { assert } from "../../src/http.js";

const usageSchema = { type: "object", required: ["calls", "quota"], additionalProperties: false,
  properties: { calls: { type: "integer", minimum: 0 }, quota: { type: "integer", minimum: 1 } } };
export function apiServiceExtension(quota = 100): ProductExtension {
  if (!Number.isSafeInteger(quota) || quota < 1 || quota > 2147483647) throw new Error("Invalid example quota");
  return {
    id: "api-service",
    permissions: [
      { name: "usage.read", roles: ["OWNER", "ADMIN", "MEMBER", "VIEWER"] },
      { name: "requests.execute", roles: ["OWNER", "ADMIN", "MEMBER"] },
    ],
    lifecycle: { "organization.created": async (db, event) => {
      await db.$executeRaw`INSERT INTO demo_api_usage (organization_id, quota) VALUES (${event.organizationId}::uuid, ${quota})`;
    } },
    routes: [
      { method: "get", path: "/usage", permission: "usage.read", summary: "Read API service usage", responseSchema: usageSchema,
        handle: async ({ db, organizationId }) => {
          const rows = await db.$queryRaw<{ calls: number; quota: number }[]>`SELECT calls, quota FROM demo_api_usage
            WHERE organization_id = ${organizationId}::uuid`;
          assert(rows[0], 404, "NOT_FOUND", "Product is not initialized"); return rows[0];
        } },
      { method: "post", path: "/requests", permission: "requests.execute", feature: "api.execute",
        summary: "Consume one example API call", responseSchema: usageSchema,
        handle: async ({ db, organizationId, emit }) => {
          const rows = await db.$queryRaw<{ calls: number; quota: number }[]>`UPDATE demo_api_usage
            SET calls = calls + 1, updated_at = CURRENT_TIMESTAMP
            WHERE organization_id = ${organizationId}::uuid AND calls < quota RETURNING calls, quota`;
          assert(rows[0], 409, "QUOTA_EXCEEDED", "API call allowance exhausted");
          await emit("api-service.request_used", organizationId); return rows[0];
        } },
    ],
  };
}
export const exampleEntitlements: EntitlementProvider = {
  contractVersion: 1,
  allows: async (db, organizationId, feature) => {
    if (feature !== "api.execute") return false;
    const rows = await db.$queryRaw<{ enabled: boolean }[]>`SELECT enabled FROM demo_api_usage WHERE organization_id = ${organizationId}::uuid`;
    return rows[0]?.enabled === true;
  },
};
