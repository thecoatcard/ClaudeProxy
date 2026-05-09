/**
 * Shared FNV-1a 32-bit hash utility.
 *
 * BUG-010 FIX: The original stableHash in request.ts and ai-compactor.ts used
 * plain JavaScript arithmetic that overflows the safe integer range during
 * intermediate steps (particularly `hash << 24`). This file uses Math.imul for
 * correct 32-bit signed integer multiplication, matching the FNV-1a specification.
 *
 * Using a single shared implementation prevents divergence between the two callers.
 */

/**
 * FNV-1a 32-bit hash. Returns a lowercase hex string.
 * Deterministic across JS engines for the same input string.
 */
export function stableHash(input: string): string {
  // FNV-1a 32-bit parameters
  let hash = 2166136261; // FNV offset basis (unsigned 32-bit)

  for (let i = 0; i < input.length; i++) {
    // XOR with octet
    hash ^= input.charCodeAt(i);
    // Multiply by FNV prime (16777619) using Math.imul for correct 32-bit wrapping.
    // Math.imul(a, b) returns the C-style 32-bit integer result of a * b.
    hash = Math.imul(hash, 16777619);
  }

  // Convert to unsigned 32-bit then hex.
  return (hash >>> 0).toString(16).padStart(8, '0');
}
