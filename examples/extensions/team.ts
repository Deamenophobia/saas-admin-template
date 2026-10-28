import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProductExtension } from "../../src/extensions/contracts.js";

const projectSchema = { type: "object", required: ["id", "name", "assignedUserId"], additionalProperties: false,
  properties: { id: { type: "string", format: "uuid" }, name: { type: "string" }, assignedUserId: { type: ["string", "null"], format: "uuid" } } };
export const teamExtension: ProductExtension = {
  id: "team",
  permissions: [
    { name: "projects.read", roles: ["OWNER", "ADMIN", "MEMBER", "VIEWER"] },
    { name: "projects.write", roles: ["OWNER", "ADMIN", "MEMBER"] },
  ],
  lifecycle: {
    "organization.created": async (db, event) => {
      await db.$executeRaw`INSERT INTO demo_team_projects (id, organization_id, name, assigned_user_id)
        VALUES (${randomUUID()}::uuid, ${event.organizationId}::uuid, 'Welcome', ${event.data.ownerId}::uuid)`;
    },
    "membership.removed": async (db, event) => {
      await db.$executeRaw`UPDATE demo_team_projects SET assigned_user_id = NULL
        WHERE organization_id = ${event.organizationId}::uuid AND assigned_user_id = ${event.data.userId}::uuid`;
    },
  },
  routes: [
    { method: "get", path: "/projects", permission: "projects.read", summary: "List up to 100 team projects",
      responseSchema: { type: "array", items: projectSchema },
      handle: async ({ db, organizationId }) => db.$queryRaw`SELECT id, name, assigned_user_id AS "assignedUserId"
        FROM demo_team_projects WHERE organization_id = ${organizationId}::uuid ORDER BY created_at, id LIMIT 100` },
    { method: "post", path: "/projects", permission: "projects.write", summary: "Create a team project", status: 201,
      requestSchema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 100 } } },
      responseSchema: projectSchema,
      handle: async ({ db, organizationId, userId, emit }, req) => {
        const { name } = z.object({ name: z.string().trim().min(1).max(100) }).strict().parse(req.body);
        const id = randomUUID(), assignedUserId = userId ?? null;
        await db.$executeRaw`INSERT INTO demo_team_projects (id, organization_id, name, assigned_user_id)
          VALUES (${id}::uuid, ${organizationId}::uuid, ${name}, ${assignedUserId}::uuid)`;
        await emit("team.project_created", id);
        return { id, name, assignedUserId };
      } },
  ],
};
