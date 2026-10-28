// Express/helmet/CORS bootstrapping extracted from kokoro-account/src/index.ts.
import "./types.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { requestContext, errors, ApiError } from "./http.js";
import { authenticate, tenant } from "./middleware/access.js";
import { sendMail, type MailSender } from "./services/email.js";
import { HttpCredentialProvider, type CredentialProvider } from "./providers/credentials.js";
import { authRoutes } from "./routes/auth.js";
import { profileRoutes } from "./routes/profile.js";
import { organizationRoutes } from "./routes/organizations.js";
import { memberRoutes } from "./routes/members.js";
import { invitationRegistration, invitationRoutes } from "./routes/invitations.js";
import { adminRoutes } from "./routes/admin.js";
import { keyRoutes } from "./routes/keys.js";
import { serviceAccountRoutes } from "./routes/service-accounts.js";
import { credentialRoutes } from "./routes/credentials.js";
import { prisma } from "./services/prisma.js";
import type { DomainEvent } from "./services/events.js";
import type { ProductExtension, EntitlementProvider } from "./extensions/contracts.js";
import { createPolicy } from "./extensions/policy.js";
import { productRoutes, validateExtensions } from "./extensions/routes.js";
import { openApiDocument } from "./extensions/openapi.js";
import { capabilityRoutes } from "./routes/capabilities.js";
import { OidcRegistry, type OidcProviderInput } from "./providers/oidc.js";
import { publicSsoRoutes, privateSsoRoutes } from "./routes/sso.js";

export interface AppOptions {
  sendMail?: MailSender;
  provider?: CredentialProvider;
  extensions?: readonly ProductExtension[];
  entitlements?: EntitlementProvider;
  oidcProviders?: readonly OidcProviderInput[];
  onEvent?: (event: DomainEvent) => void | Promise<void>;
}
export function createApp(options: AppOptions = {}) {
  const oidc = new OidcRegistry(options.oidcProviders);
  const extensions = options.extensions ?? [];
  const policy = createPolicy(extensions.flatMap(extension => [...extension.permissions]));
  validateExtensions(extensions, policy);
  const provider = options.provider ?? new HttpCredentialProvider();
  if (provider.contractVersion !== 1 || (options.entitlements && options.entitlements.contractVersion !== 1)) throw new Error("Unsupported provider contract version");
  const document = openApiDocument(extensions, policy);
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext, helmet(), cors({ origin: config.ALLOWED_ORIGINS.split(",") }), express.json({ limit: "32kb" }));
  app.use((req, _res, next) => {
    req.auditEvents = []; req.onEvent = options.onEvent;
    req.accessPolicy = policy; req.extensions = extensions; next();
  });
  const authLimit = rateLimit({ windowMs: config.RATE_WINDOW_MS, limit: config.AUTH_RATE_LIMIT,
    standardHeaders: "draft-7", legacyHeaders: false,
    handler: (_req, _res, next) => next(new ApiError(429, "RATE_LIMITED", "Too many attempts")) });
  app.use(["/api/v1/auth", "/api/v1/me/mfa", "/api/v1/me/password", "/api/v1/me/sso"], authLimit);
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/ready", (_req, res, next) => { prisma.$queryRaw`SELECT 1`.then(() => res.json({ status: "ready" })).catch(next); });
  app.get("/openapi.json", (_req, res) => res.json(document));
  const mail = options.sendMail ?? sendMail;
  authRoutes(app, mail);
  publicSsoRoutes(app, oidc);
  invitationRegistration(app);
  app.use("/api/v1", (req, _res, next) => { authenticate(req).then(() => next()).catch(next); });
  app.use("/api/v1/orgs/:orgId", (req, _res, next) => { tenant(req).then(() => next()).catch(next); });
  profileRoutes(app);
  privateSsoRoutes(app, oidc);
  organizationRoutes(app);
  memberRoutes(app);
  invitationRoutes(app, mail);
  adminRoutes(app);
  keyRoutes(app);
  serviceAccountRoutes(app);
  credentialRoutes(app, provider);
  capabilityRoutes(app, extensions, provider, !!options.entitlements);
  productRoutes(app, extensions, options.entitlements);
  app.use((_req, _res, next) => next(new ApiError(404, "NOT_FOUND", "Endpoint not found")));
  app.use(errors);
  return app;
}
