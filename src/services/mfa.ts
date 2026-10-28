// Integrates kokoro-auth's TOTP/encryption helpers with atomic replay protection.
import { TOTP, Secret } from "otpauth";
import type { User } from "@prisma/client";
import { decryptField } from "../crypto/encryption.js";
import { hashApiKey } from "../crypto/apiKey.js";
import type { Db } from "./audit.js";
import { assert } from "../http.js";

export async function useSecondFactor(db: Db, user: User, code?: string) {
  if (!user.totpSecret) return;
  assert(code, 401, "MFA_REQUIRED", "Second factor required");
  if (/^\d{6}$/.test(code)) {
    const totp = new TOTP({ secret: Secret.fromBase32(await decryptField(user.totpSecret)), period: 30, digits: 6, algorithm: "SHA1" });
    const delta = totp.validate({ token: code, window: 1 });
    assert(delta !== null, 401, "INVALID_MFA", "Invalid second factor");
    const step = Math.floor(Date.now() / 30000) + delta;
    const result = await db.user.updateMany({ where: { id: user.id, totpLastStep: { lt: step } }, data: { totpLastStep: step } });
    assert(result.count === 1, 401, "INVALID_MFA", "Second factor already used");
  } else {
    const result = await db.recoveryCode.deleteMany({ where: { userId: user.id, codeHash: await hashApiKey(code) } });
    assert(result.count === 1, 401, "INVALID_MFA", "Invalid recovery code");
  }
}
