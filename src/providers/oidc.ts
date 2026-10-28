import * as oidc from "openid-client";
import { z } from "zod";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { ApiError, assert } from "../http.js";
import { canonicalJson } from "../crypto/canonicalJson.js";

const providerSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), label: z.string().min(1).max(100),
  issuer: z.string().url().max(2048), clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(4096), redirectUri: z.string().url().max(2048),
  tokenAuthMethod: z.enum(["client_secret_post", "client_secret_basic"]).default("client_secret_post"),
  allowInsecureLocalhost: z.boolean().default(false),
}).strict();
export type OidcProviderInput = z.input<typeof providerSchema>;
export type OidcProvider = z.output<typeof providerSchema>;
export interface OidcIdentity { issuer: string; subject: string; email?: unknown; emailVerified: boolean; name?: unknown }

function checkedUrl(value: string, local: boolean) {
  const url = new URL(value);
  const allowedHttp = local && process.env.NODE_ENV !== "production" && url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !allowedHttp)) throw new Error("OIDC URLs require HTTPS; local HTTP is development-only");
  return url;
}
export class OidcRegistry {
  private providers = new Map<string, OidcProvider>();
  private clients = new Map<string, Promise<oidc.Configuration>>();
  constructor(input?: readonly OidcProviderInput[]) {
    let parsed: OidcProvider[];
    try { parsed = z.array(providerSchema).max(10).parse(input ?? JSON.parse(config.OIDC_PROVIDERS)); }
    catch { throw new Error("Invalid OIDC provider configuration"); }
    for (const provider of parsed) {
      for (const value of [provider.issuer, provider.redirectUri]) {
        if (checkedUrl(value, provider.allowInsecureLocalhost).search) throw new Error("OIDC issuer/redirect URLs cannot include queries");
      }
      if (this.providers.has(provider.id)) throw new Error("Duplicate OIDC provider id");
      this.providers.set(provider.id, provider);
    }
  }
  list() { return [...this.providers.values()].map(({ id, label }) => ({ id, label })); }
  get(id: string) {
    const provider = this.providers.get(id);
    assert(provider, 404, "SSO_PROVIDER_NOT_FOUND", "SSO provider is not configured"); return provider;
  }
  fingerprint(provider: OidcProvider) { return createHash("sha256").update(canonicalJson(provider)).digest("hex"); }
  async client(provider: OidcProvider) {
    let promise = this.clients.get(provider.id);
    if (!promise) {
      promise = this.discover(provider).catch(() => {
        this.clients.delete(provider.id);
        throw new ApiError(503, "SSO_PROVIDER_UNAVAILABLE", "OIDC discovery or provider requirements failed");
      });
      this.clients.set(provider.id, promise);
    }
    return promise;
  }
  private async discover(provider: OidcProvider) {
    const client = await oidc.discovery(new URL(provider.issuer), provider.clientId,
      { client_secret: provider.clientSecret, id_token_signed_response_alg: "RS256" },
      provider.tokenAuthMethod === "client_secret_basic" ? oidc.ClientSecretBasic(provider.clientSecret) : oidc.ClientSecretPost(provider.clientSecret), {
        timeout: config.OIDC_TIMEOUT_SECONDS,
        execute: [oidc.enableNonRepudiationChecks, ...(provider.allowInsecureLocalhost ? [oidc.allowInsecureRequests] : [])],
        [oidc.customFetch]: async (url, options) => {
          checkedUrl(String(url), provider.allowInsecureLocalhost);
          const body = options.body instanceof Uint8Array ? new Uint8Array(options.body).buffer : options.body;
          return fetch(url, { ...options, body, redirect: "error" });
        },
      });
    const metadata = client.serverMetadata();
    for (const value of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) {
      if (!value) throw new Error("Required OIDC endpoint missing");
      checkedUrl(value, provider.allowInsecureLocalhost);
    }
    if (!metadata.supportsPKCE("S256")) throw new Error("Provider must advertise S256 PKCE");
    return client;
  }
  async exchange(provider: OidcProvider, response: { code: string; state: string; iss?: string }, verifier: string, nonce: string): Promise<OidcIdentity> {
    const client = await this.client(provider);
    const url = new URL(provider.redirectUri);
    for (const [key, value] of Object.entries(response)) if (value !== undefined) url.searchParams.set(key, value);
    try {
      const tokens = await oidc.authorizationCodeGrant(client, url, {
        expectedState: response.state, expectedNonce: nonce, pkceCodeVerifier: verifier, idTokenExpected: true,
      });
      const claims = tokens.claims();
      assert(claims && typeof claims.sub === "string" && claims.sub.length > 0 && claims.sub.length <= 255,
        401, "SSO_INVALID_RESPONSE", "Invalid identity response");
      return { issuer: claims.iss, subject: claims.sub, email: claims.email, emailVerified: claims.email_verified === true, name: claims.name };
    } catch { throw new ApiError(401, "SSO_INVALID_RESPONSE", "Identity response could not be verified; restart sign-in"); }
  }
}
