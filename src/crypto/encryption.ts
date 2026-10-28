//! AES-256-GCM encryption for sensitive data at rest (e.g. TOTP secrets).
//!
//! Derives a 256-bit key from the mandatory ENCRYPTION_KEY
//! using HKDF-SHA256 with a fixed info string. Each encryption produces a
//! random 12-byte IV prepended to the ciphertext+tag.

// Extracted from kokoro-auth. Dedicated mandatory encryption key; no dev fallback.
import { config } from "../config.js";

const ALG = "AES-GCM";
const IV_BYTES = 12;
const INFO = new TextEncoder().encode("saas-admin-field-encryption-v1");

let _derivedKey: CryptoKey | null = null;

/** Derive an AES-256-GCM key from the configured encryption key using HKDF. */
async function getDerivedKey(): Promise<CryptoKey> {
  if (_derivedKey) return _derivedKey;

  const raw = config.encryptionKey;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not configured — cannot encrypt sensitive fields",
    );
  }

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(raw),
    "HKDF",
    false,
    ["deriveKey"],
  );

  _derivedKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: INFO },
    keyMaterial,
    { name: ALG, length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return _derivedKey;
}

/**
 * Encrypt a plaintext string. Returns a base64-encoded string containing
 * IV (12 bytes) + ciphertext + GCM tag.
 */
export async function encryptField(plaintext: string): Promise<string> {
  const key = await getDerivedKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALG, iv },
    key,
    encoded,
  );

  // Prepend IV to ciphertext
  const combined = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_BYTES);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a base64-encoded string produced by encryptField.
 * Returns the original plaintext.
 */
export async function decryptField(encrypted: string): Promise<string> {
  const key = await getDerivedKey();
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));

  const iv = combined.slice(0, IV_BYTES);
  const ciphertext = combined.slice(IV_BYTES);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: ALG, iv },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(plainBuffer);
}

/** Check whether a string looks like an encrypted field (base64, not plain base32 TOTP secret). */
export function isEncrypted(value: string): boolean {
  // Encrypted values are base64 with mixed case and special chars.
  // Raw TOTP secrets are base32 (uppercase A-Z, 2-7 only).
  if (/^[A-Z2-7]+=*$/.test(value)) return false;
  try {
    const decoded = atob(value);
    // Must be at least IV (12) + 1 byte ciphertext + 16 byte tag = 29 bytes
    return decoded.length >= 29;
  } catch {
    return false;
  }
}

/** Reset derived key cache (for testing). */
export function _resetKeyCache(): void {
  _derivedKey = null;
}
