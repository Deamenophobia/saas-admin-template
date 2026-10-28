//! TOTP (Time-based One-Time Password) for 2FA.

import { TOTP, Secret } from "otpauth";

// Extracted from kokoro-auth; use the configured product issuer.
import { config } from "../config.js";
const ISSUER = config.APP_NAME;
const PERIOD = 30;
const DIGITS = 6;
const ALGORITHM = "SHA1";

/** Generate a new TOTP secret (base32 encoded). */
export function generateSecret(): string {
  const secret = new Secret({ size: 20 });
  return secret.base32;
}

/** Build an otpauth:// URI for QR code scanning. */
export function buildOtpauthUri(email: string, secretBase32: string): string {
  const totp = new TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD,
    secret: Secret.fromBase32(secretBase32),
  });
  return totp.toString();
}

/** Verify a TOTP code. Allows +/- 1 period window. */
export function verifyCode(secretBase32: string, code: string): boolean {
  const totp = new TOTP({
    issuer: ISSUER,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD,
    secret: Secret.fromBase32(secretBase32),
  });

  // delta = 0 means exact match, null means invalid
  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}
