import { z } from "zod";
import { config } from "../config.js";
import { ApiError } from "../http.js";

export interface ProviderContext { contractVersion: 1; organizationId: string; operationId: string }
export interface CredentialProvider {
  contractVersion: 1;
  capabilities: readonly ("issue" | "revoke")[];
  issue(context: ProviderContext, name: string): Promise<{ reference: string; secret?: string }>;
  revoke(context: ProviderContext, reference: string): Promise<void>;
}
// Operator-configured endpoint; tenant input can never select the server or bearer secret.
// Providers must honor operationId as an idempotency key, including after timeouts.
export class HttpCredentialProvider implements CredentialProvider {
  readonly contractVersion = 1 as const;
  readonly capabilities: readonly ("issue" | "revoke")[] = config.PROVISIONER_URL ? ["issue", "revoke"] : [];
  private async call(context: ProviderContext, action: string, payload: object) {
    if (!config.PROVISIONER_URL) throw new ApiError(503, "PROVIDER_DISABLED", "External provisioning is not configured");
    const response = await fetch(`${config.PROVISIONER_URL.replace(/\/$/, "")}/${action}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(config.PROVIDER_TIMEOUT_MS),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.PROVISIONER_TOKEN}`,
        "Idempotency-Key": context.operationId },
      body: JSON.stringify({ contractVersion: context.contractVersion, organizationId: context.organizationId, ...payload }),
    });
    if (!response.ok) throw new ApiError(502, "PROVIDER_FAILED", "Credential provider rejected the operation");
    return response;
  }
  async issue(context: ProviderContext, name: string) {
    const response = await this.call(context, "issue", { name });
    return z.object({ reference: z.string().min(1).max(256), secret: z.string().max(8192).optional() }).parse(await response.json());
  }
  async revoke(context: ProviderContext, reference: string) {
    await this.call(context, "revoke", { reference });
  }
}
