import "dotenv/config";
import { z } from "zod";

const env = z.object({
  DATABASE_URL: z.string().url(),
  ENCRYPTION_KEY: z.string().min(32),
  PORT: z.coerce.number().int().min(1).max(65535).default(4050),
  HOST: z.string().default("127.0.0.1"),
  APP_NAME: z.string().default("SaaS Admin"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  SESSION_HOURS: z.coerce.number().positive().default(24),
  TOKEN_MINUTES: z.coerce.number().positive().default(60),
  INVITE_HOURS: z.coerce.number().positive().default(48),
  KEY_DAYS: z.coerce.number().positive().default(90),
  API_KEY_PREFIX: z.string().regex(/^[a-z][a-z0-9_]{1,15}$/).default("sk_"),
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),
  RATE_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  PROVISIONER_URL: z.string().default(""),
  PROVISIONER_TOKEN: z.string().default(""),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  ALLOW_REGISTRATION: z.enum(["true", "false"]).default("true"),
  OIDC_PROVIDERS: z.string().default("[]"),
  SSO_FLOW_MINUTES: z.coerce.number().int().min(1).max(15).default(5),
  SSO_MFA_MINUTES: z.coerce.number().int().min(1).max(5).default(5),
  SSO_MFA_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  OIDC_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(30).default(10),
}).parse(process.env);

if (env.PROVISIONER_URL) {
  const url = new URL(env.PROVISIONER_URL);
  // Same URL boundary as crypto-payment-core: operator secrets belong in headers/config.
  if (!env.PROVISIONER_TOKEN || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Provisioner requires HTTP(S), no embedded credentials, query or fragment");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") throw new Error("Provisioner requires HTTPS");
}

export const config = {
  ...env,
  encryptionKey: env.ENCRYPTION_KEY,
  sessionMs: env.SESSION_HOURS * 3600000,
  tokenMs: env.TOKEN_MINUTES * 60000,
  invitationMs: env.INVITE_HOURS * 3600000,
  keyMs: env.KEY_DAYS * 86400000,
};
