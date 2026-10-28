import { readFileSync } from "node:fs";
import type { ProductExtension } from "./contracts.js";
import type { AccessPolicy } from "./policy.js";

export function openApiDocument(extensions: readonly ProductExtension[], policy: AccessPolicy) {
  const document = JSON.parse(readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"));
  document.components.schemas.ApiKey.properties.scopes.items.enum = policy.scopes;
  for (const extension of extensions) for (const route of extension.routes) {
    const path = `/api/v1/orgs/{orgId}/extensions/${extension.id}${route.path.replace(/:id\b/g, "{id}")}`;
    document.paths[path] ??= {};
    const code = route.status ?? 200;
    const responses: Record<string, unknown> = { [code]: { description: "Success",
      ...(code === 204 ? {} : { content: { "application/json": { schema: route.responseSchema } } }) } };
    for (const status of [400, 401, 403, 404, 409, 422, 500, 503]) responses[status] = {
      description: "Structured API error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
    document.paths[path][route.method] = { summary: route.summary,
      operationId: `${extension.id}_${route.method}_${route.path.replace(/[^a-zA-Z0-9]+/g, "_")}`,
      security: [{ bearerAuth: [] }], "x-permission": route.permission, ...(route.feature ? { "x-feature": route.feature } : {}),
      parameters: [...path.matchAll(/\{(\w+)\}/g)].map(m => ({ name: m[1], in: "path", required: true, schema: { type: "string", format: "uuid" } })),
      ...(route.requestSchema ? { requestBody: { required: true, content: { "application/json": { schema: route.requestSchema } } } } : {}), responses };
  }
  return document;
}
