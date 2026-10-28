import type { Express, Request, Response, NextFunction, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z, ZodError } from "zod";
import { prisma } from "./services/prisma.js";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function assert(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new ApiError(status, code, message);
}
export const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { Promise.resolve(fn(req, res)).catch(next); };
export const nameSchema = z.string().trim().min(1).max(100);
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(12).max(256);
export const tokenSchema = z.string().min(32).max(512);
export const uuidSchema = z.string().uuid();
export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().max(100).optional(),
});
export const safeUser = { id: true, email: true, name: true, emailVerified: true,
  disabled: true, isSuperAdmin: true, createdAt: true } as const;

export function requestContext(req: Request, res: Response, next: NextFunction) {
  req.requestId = `req_${randomUUID()}`;
  res.setHeader("X-Request-ID", req.requestId);
  res.setHeader("Cache-Control", "no-store");
  next();
}
export async function errors(err: unknown, req: Request, res: Response, _next: NextFunction) {
  let error = err instanceof ApiError ? err : new ApiError(500, "INTERNAL_ERROR", "Request failed");
  if (err instanceof ZodError) error = new ApiError(422, "INVALID_PARAMETER", "Invalid request fields");
  if (err instanceof SyntaxError) error = new ApiError(400, "INVALID_JSON", "Malformed JSON");
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") error = new ApiError(409, "CONFLICT", "Record already exists");
    if (err.code === "P2025") error = new ApiError(404, "NOT_FOUND", "Record not found");
    if (err.code === "P2034") error = new ApiError(409, "RETRY_TRANSACTION", "Concurrent change; retry request");
  }
  if (error.status === 500) console.error(JSON.stringify({ request_id: req.requestId, code: error.code }));
  if (error.status === 401 || error.status === 403) {
    await prisma.auditLog.create({ data: { orgId: req.orgId ?? null,
      actorId: req.identity?.userId ?? req.identity?.serviceAccountId ?? null,
      action: `access.denied.${error.code}`, resourceId: req.requestId } }).catch(() => undefined);
  }
  res.status(error.status).json({ error: { type: error.status >= 500 ? "internal_error" : "request_error",
    code: error.code, message: error.message, status: error.status, request_id: req.requestId,
    timestamp: new Date().toISOString(), ...(err instanceof ZodError ? {
      details: err.issues.map(i => ({ field: i.path.join("."), reason: i.message })) } : {}) } });
}

export function endpoint(app: Express, method: "get" | "post" | "patch" | "delete", path: string,
  handler: (req: Request, res: Response) => Promise<unknown>) {
  app[method](path, asyncRoute(async (req, res) => {
    for (const [key, value] of Object.entries(req.params)) {
      if (key === "id" || key.endsWith("Id")) uuidSchema.parse(value);
    }
    return handler(req, res);
  }));
}
