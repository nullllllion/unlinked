// Build manifests: what an attester signs off on and what a verifier recomputes.
//
// The root is sha256 over a canonical manifest, so two attesters who rebuild
// the same commit independently publish the same root, and agreement between
// them is a string comparison.

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return "0x" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sorted-key JSON, so the same files always give the same bytes. */
export function canonicalManifest(files: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const path of Object.keys(files).sort()) sorted[path] = files[path];
  return JSON.stringify(sorted);
}

export async function manifestRoot(files: Record<string, string>): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalManifest(files)));
}

/** Files a browser executes or styles with: the ones worth an asset record. */
export function isCodeAsset(path: string): boolean {
  return /\.(m?js|css|html|wasm)$/i.test(path);
}

/** Keys a web store adds to an extension's manifest after it leaves the build. */
const STORE_ADDED_KEYS = ["update_url", "key", "differential_fingerprint"];

/**
 * The bytes to hash for a file. An extension's manifest.json is compared after
 * removing what the store adds, so a store install still matches its build;
 * everything else, including the rest of the manifest, is hashed exactly.
 */
export function hashableBytes(path: string, bytes: Uint8Array): Uint8Array {
  if (path !== "manifest.json") return bytes;
  try {
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    for (const k of STORE_ADDED_KEYS) delete manifest[k];
    return new TextEncoder().encode(JSON.stringify(manifest));
  } catch {
    return bytes;
  }
}

/** Store bookkeeping that is never part of a build. */
export function isStoreMetadata(path: string): boolean {
  return path.startsWith("_metadata/");
}
