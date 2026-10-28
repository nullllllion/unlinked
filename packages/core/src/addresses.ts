// Finding the user's own addresses inside arbitrary request data.
//
// Matching is on the bare 40 hex digits, case-insensitively, because an
// address rarely appears as a tidy `0x…` field: `balanceOf(user)` puts it
// inside calldata left-padded to 32 bytes, and trackers lowercase, checksum or
// URL-encode it as they please.

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Lowercase `0x…` form, or null if the value is not an address. */
export function normalizeAddress(value: unknown): string | null {
  return typeof value === "string" && ADDRESS.test(value) ? value.toLowerCase() : null;
}

/** The user's addresses that occur anywhere in `haystack`, as lowercase `0x…`. */
export function findOwnAddresses(haystack: string, own: ReadonlySet<string>): string[] {
  if (own.size === 0 || haystack.length < 40) return [];
  const lower = haystack.toLowerCase();
  const found: string[] = [];
  for (const address of own) {
    if (lower.includes(address.slice(2))) found.push(address);
  }
  return found;
}

/**
 * The first of the user's addresses named anywhere in a JSON value (params,
 * typically), walking at most `maxNodes` nodes so a hostile payload can't make
 * this expensive.
 */
export function firstOwnAddress(value: unknown, own: ReadonlySet<string>, maxNodes = 512): string | null {
  if (own.size === 0) return null;
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length > 0 && visited++ < maxNodes) {
    const node = stack.pop();
    if (typeof node === "string") {
      const hit = findOwnAddresses(node, own)[0];
      if (hit) return hit;
    } else if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
    } else if (node && typeof node === "object") {
      for (const v of Object.values(node)) stack.push(v);
    }
  }
  return null;
}

/** Best-effort text view of a request body, for leak scanning only. */
export function bodyText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  try {
    return text + "\n" + decodeURIComponent(text);
  } catch {
    return text;
  }
}
