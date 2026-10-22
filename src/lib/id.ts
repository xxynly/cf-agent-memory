const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Sortable, collision-resistant id: `mem_<base36 time><random>`. */
export function newId(prefix = "mem"): string {
  const time = Date.now().toString(36);
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let random = "";
  for (const byte of bytes) random += ALPHABET[byte % 32];
  return `${prefix}_${time}${random}`;
}

/** Deterministic short hash, used for dedupe fingerprints. */
export async function shortHash(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
