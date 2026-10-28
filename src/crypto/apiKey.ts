//! API key generation and hashing.
//!
//! Keys use a configurable prefix plus 32 random bytes encoded as hex.
//! Stored as SHA-256 hashes in the database.

// Extracted from kokoro-auth; configurable prefix removes product coupling.
import { config } from "../config.js";
const KEY_PREFIX = config.API_KEY_PREFIX;

/** Generate a raw API key (shown to user once). */
export function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${KEY_PREFIX}${hex}`;
}

/** SHA-256 hash of a raw API key (stored in database). */
export async function hashApiKey(rawKey: string): Promise<string> {
  const encoded = new TextEncoder().encode(rawKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Extract the configured prefix plus first 8 hex characters for display. */
export function keyPrefix(rawKey: string): string {
  return rawKey.slice(0, KEY_PREFIX.length + 8);
}
