import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import type { Db } from "../services/audit.js";
import type { DomainEvent } from "../services/events.js";
import type { PermissionDefinition } from "./policy.js";

export type JsonSchema = Record<string, unknown>;
export type LifecycleType = "organization.created" | "organization.suspended" | "organization.resumed"
  | "membership.added" | "membership.removed" | "user.suspended" | "user.resumed";
export type LifecycleHook = (db: Db, event: DomainEvent) => Promise<void>;
export interface ProductContext {
  db: Db;
  organizationId: string;
  userId?: string;
  emit(type: string, resourceId?: string, data?: Prisma.InputJsonObject): Promise<void>;
}
export interface ProductRoute {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  permission: string;
  feature?: string;
  summary: string;
  status?: 200 | 201 | 204;
  requestSchema?: JsonSchema;
  responseSchema: JsonSchema;
  handle(context: ProductContext, request: Request): Promise<unknown>;
}
export interface ProductExtension {
  id: string;
  permissions: readonly PermissionDefinition[];
  routes: readonly ProductRoute[];
  lifecycle?: Partial<Record<LifecycleType, LifecycleHook>>;
}
// Adapted from pipeline plan-gate: the product owns plans/limits, the core asks for a feature.
// Use local persisted entitlements here; synchronize billing/SSO via an adapter outside the transaction.
export interface EntitlementProvider {
  contractVersion: 1;
  allows(db: Db, organizationId: string, feature: string): Promise<boolean>;
}
