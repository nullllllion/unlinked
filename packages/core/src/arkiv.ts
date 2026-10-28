// Arkiv over raw JSON-RPC: query strings, request bodies and response parsing.
//
// The extension reads with plain `arkiv_query` calls rather than the SDK, so
// every lookup can be sent through an anon-rpc worker's fetch like any other
// JSON-RPC body (and the bundle stays small). The attester writes with the SDK.

export const ARKIV_PROJECT = "unlinked";

export type ArkivAttributes = Record<string, string | number | boolean>;

export type ArkivEntity = {
  key: string;
  owner: string;
  expiresAt: bigint;
  attributes: ArkivAttributes;
};

export type ArkivPage = { entities: ArkivEntity[]; blockNumber: bigint; cursor?: string };

const HEX32 = /^0x[0-9a-f]{64}$/;

export function bytes32Literal(hex: string): string {
  const h = hex.toLowerCase();
  if (!HEX32.test(h)) throw new Error(`not a bytes32: ${hex}`);
  return `bytes32(${h})`;
}

function anyOf(attribute: string, hexes: string[]): string {
  if (hexes.length === 0) throw new Error("anyOf needs at least one value");
  return `(${hexes.map((h) => `${attribute} = ${bytes32Literal(h)}`).join(" OR ")})`;
}

/** Asset attestations for any of these file hashes. */
export function assetsByHashQuery(sha256s: string[]): string {
  return `project = str('${ARKIV_PROJECT}') AND type = str('asset') AND ${anyOf("sha256", sha256s)}`;
}

/** Build attestations for any of these manifest roots. */
export function buildsByRootQuery(roots: string[]): string {
  return `project = str('${ARKIV_PROJECT}') AND type = str('build') AND ${anyOf("root", roots)}`;
}

/** The JSON-RPC body for one `arkiv_query` page. Arkiv caps pages at 200. */
export function arkivQueryRequest(id: number, query: string, cursor?: string): object {
  const options: Record<string, unknown> = {
    limit: "0xc8",
    select: { key: true, owner: true, expiresAt: true, attributes: true },
  };
  if (cursor) options.cursor = cursor;
  return { jsonrpc: "2.0", id, method: "arkiv_query", params: [query, options] };
}

/**
 * Parse an `arkiv_query` result. Attributes arrive as `{name, type, value}`;
 * hex-typed values are lowercased so they compare as plain strings.
 */
export function parseArkivPage(result: unknown): ArkivPage {
  const r = result as { data?: unknown[]; blockNumber?: string; cursor?: string } | null;
  if (!r || !Array.isArray(r.data)) throw new Error("arkiv: malformed query result");
  const entities = r.data.map((raw): ArkivEntity => {
    const e = raw as { key?: string; owner?: string; expiresAt?: string; attributes?: unknown };
    const attributes: ArkivAttributes = {};
    const list = Array.isArray(e.attributes) ? e.attributes : [];
    for (const a of list as { name?: string; type?: string; value?: unknown }[]) {
      if (typeof a.name !== "string") continue;
      const v = a.value;
      attributes[a.name] =
        typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : (v as string | number | boolean);
    }
    return {
      key: String(e.key ?? "").toLowerCase(),
      owner: String(e.owner ?? "").toLowerCase(),
      expiresAt: BigInt(e.expiresAt ?? 0),
      attributes,
    };
  });
  return { entities, blockNumber: BigInt(r.blockNumber ?? 0), cursor: r.cursor };
}

/** Arkiv produces a block every 2 seconds. */
export const ARKIV_BLOCK_SECONDS = 2;
