import type { MemberRole } from "@prisma/client";

// Retains pipeline's membership roles; products register their own resource actions.
export const basePermissions: Record<MemberRole, readonly string[]> = {
  OWNER: ["organizations.read", "organizations.write", "members.read", "members.write", "credentials.read", "credentials.write", "secrets.read", "audit.read", "service_accounts.read", "service_accounts.write"],
  ADMIN: ["organizations.read", "organizations.write", "members.read", "members.write", "credentials.read", "credentials.write", "secrets.read", "audit.read", "service_accounts.read", "service_accounts.write"],
  MEMBER: ["organizations.read", "members.read", "credentials.read", "service_accounts.read"],
  VIEWER: ["organizations.read", "members.read"],
};
export interface PermissionDefinition { name: string; roles: readonly MemberRole[] }
export interface AccessPolicy { scopes: readonly string[]; roles: Record<MemberRole, readonly string[]> }
export function createPolicy(definitions: readonly PermissionDefinition[] = []): AccessPolicy {
  const scopes = new Set(basePermissions.OWNER);
  const roles = Object.fromEntries(Object.entries(basePermissions).map(([role, values]) => [role, [...values]])) as Record<MemberRole, string[]>;
  for (const definition of definitions) {
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(definition.name) || scopes.has(definition.name)) {
      throw new Error(`Invalid or duplicate product permission: ${definition.name}`);
    }
    scopes.add(definition.name);
    for (const role of new Set(definition.roles)) {
      if (!Object.hasOwn(roles, role)) throw new Error("Unknown membership role");
      roles[role].push(definition.name);
    }
  }
  for (const values of Object.values(roles)) Object.freeze(values);
  return Object.freeze({ scopes: Object.freeze([...scopes]), roles: Object.freeze(roles) });
}
