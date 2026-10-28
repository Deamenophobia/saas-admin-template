import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { SignJWT, generateKeyPair, exportJWK } from "jose";

// Local protocol simulator: real discovery, S256 checking and signed ID tokens.
// No identity-provider account, secret or external network is involved.
export async function oidcProvider() {
  const keys = await generateKeyPair("RS256"), wrongKeys = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(keys.publicKey), kid: "fixture-key", alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string }>();
  const state = { subject: "external-user", email: "external@example.test", emailVerified: true, failure: "", tokenCalls: 0 };
  let issuer = "";
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, issuer);
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/.well-known/openid-configuration") {
        res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
          authorization_response_iss_parameter_supported: true }));
      } else if (url.pathname === "/jwks") res.end(JSON.stringify({ keys: [jwk] }));
      else if (url.pathname === "/authorize") {
        if (url.searchParams.get("code_challenge_method") !== "S256") { res.writeHead(400).end(); return; }
        const code = randomUUID(), redirectUri = url.searchParams.get("redirect_uri")!;
        codes.set(code, { nonce: url.searchParams.get("nonce")!, challenge: url.searchParams.get("code_challenge")!, redirectUri });
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", code); callback.searchParams.set("state", url.searchParams.get("state")!); callback.searchParams.set("iss", issuer);
        res.writeHead(302, { Location: callback.href }).end();
      } else if (url.pathname === "/token") {
        state.tokenCalls++;
        let raw = ""; for await (const chunk of req) raw += chunk;
        const body = new URLSearchParams(raw), code = body.get("code")!, flow = codes.get(code);
        const basic = req.headers.authorization === `Basic ${Buffer.from("fixture-client:fixture-secret").toString("base64")}`;
        if ((!basic && (body.get("client_id") !== "fixture-client" || body.get("client_secret") !== "fixture-secret"))
          || !flow || body.get("redirect_uri") !== flow.redirectUri || body.get("grant_type") !== "authorization_code"
          || createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url") !== flow.challenge) {
          res.writeHead(400).end(JSON.stringify({ error: "invalid_grant" })); return;
        }
        codes.delete(code);
        const token = await new SignJWT({ nonce: state.failure === "nonce" ? "wrong-nonce" : flow.nonce,
          email: state.email, email_verified: state.emailVerified, name: "External user", role: "OWNER", isSuperAdmin: true })
          .setSubject(state.subject).setIssuer(state.failure === "issuer" ? `${issuer}/wrong` : issuer)
          .setAudience(state.failure === "audience" ? "different-client" : "fixture-client")
          .setIssuedAt().setExpirationTime(state.failure === "expired" ? Math.floor(Date.now() / 1000) - 300 : "5m")
          .setProtectedHeader({ alg: "RS256", kid: "fixture-key" }).sign(state.failure === "signature" ? wrongKeys.privateKey : keys.privateKey);
        res.end(JSON.stringify({ access_token: "unused-upstream-access-token", token_type: "Bearer", expires_in: 300, id_token: token }));
      } else res.writeHead(404).end();
    } catch { res.writeHead(500).end(JSON.stringify({ error: "fixture_failed" })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, state, issuer,
    provider: { id: "fixture", label: "Local identity provider", issuer, clientId: "fixture-client", clientSecret: "fixture-secret",
      redirectUri: "http://localhost:3000/auth/callback", allowInsecureLocalhost: true } };
}
