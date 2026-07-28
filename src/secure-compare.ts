/**
 * Length-independent string comparison, so a secret cannot be recovered byte by
 * byte from response timing. Shared by the MCP secret path and the sync token.
 */
export function secureEquals(actual: string, expected: string): boolean {
  const a = new TextEncoder().encode(actual);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
