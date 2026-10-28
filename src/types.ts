import type { MemberRole } from "@prisma/client";
import type { AccessPolicy } from "./extensions/policy.js";
import type { ProductExtension } from "./extensions/contracts.js";
import type { DomainEvent } from "./services/events.js";
export interface Identity {
  apiKeyId?: string;
  userId?: string;
  serviceAccountId?: string;
  sessionId?: string;
  orgId?: string;
  scopes?: string[];
}
declare global {
  namespace Express {
    interface Request {
      identity: Identity;
      orgId: string;
      role: MemberRole;
      requestId: string;
      accessPolicy: AccessPolicy;
      extensions: readonly ProductExtension[];
      auditEvents?: DomainEvent[];
      onEvent?: (event: DomainEvent) => void | Promise<void>;
    }
  }
}
