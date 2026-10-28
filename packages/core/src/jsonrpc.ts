// JSON-RPC parsing, request planning and response reassembly. Pure: no I/O.
//
// The planning step is where unlinkability is won or lost. A batch naming two
// of the user's accounts is one HTTP body, so it links them no matter how many
// circuits exist; and viem numbers requests from one counter per client, so
// ids 41, 43, 45 on one exit and 42, 44, 46 on another stitch back together.
// So calls are grouped by isolation key, and every group gets fresh wire ids.

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcError = { code: number; message: string; data?: unknown };

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

export type ParsedBody = { batch: boolean; requests: JsonRpcRequest[] };

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.jsonrpc === "2.0" && typeof v.method === "string";
}

/** A JSON-RPC request or batch, or null if the text is anything else. */
export function parseJsonRpc(text: string): ParsedBody | null {
  const t = text.trimStart();
  // Cheap pre-checks: most POST bodies on a page are not JSON-RPC.
  if ((t[0] !== "{" && t[0] !== "[") || !t.includes('"jsonrpc"')) return null;
  let value: unknown;
  try {
    value = JSON.parse(t);
  } catch {
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || !value.every(isJsonRpcRequest)) return null;
    return { batch: true, requests: value };
  }
  return isJsonRpcRequest(value) ? { batch: false, requests: [value] } : null;
}

/** A call that still has to go over the network, tagged with its isolation key. */
export type PlannedCall = { index: number; request: JsonRpcRequest; key: string };

export type WireGroup = { key: string; calls: PlannedCall[] };

/** Group calls by isolation key, keeping first-seen key order and call order. */
export function groupByKey(calls: PlannedCall[]): WireGroup[] {
  const groups = new Map<string, WireGroup>();
  for (const call of calls) {
    let group = groups.get(call.key);
    if (!group) groups.set(call.key, (group = { key: call.key, calls: [] }));
    group.calls.push(call);
  }
  return [...groups.values()];
}

/** Serialise a group with fresh wire ids. One call goes out unbatched. */
export function encodeGroup(group: WireGroup, nextId: () => number): { body: string; wireIds: number[] } {
  const wireIds = group.calls.map(() => nextId());
  const payload = group.calls.map((call, i) => {
    const out: Record<string, unknown> = { jsonrpc: "2.0", id: wireIds[i], method: call.request.method };
    if ("params" in call.request) out.params = call.request.params;
    return out;
  });
  return { body: JSON.stringify(payload.length === 1 ? payload[0] : payload), wireIds };
}

/**
 * Match a wire response back to its calls, keyed by wire id.
 *
 * A node that rejects the whole body answers with one error object and no
 * usable id; that error then applies to every call in the group.
 */
export function decodeGroup(text: string, wireIds: number[]): Map<number, JsonRpcResponse> {
  const out = new Map<number, JsonRpcResponse>();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    for (const id of wireIds) out.set(id, rpcError(id, -32700, "Unlinked: upstream sent invalid JSON"));
    return out;
  }
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as JsonRpcResponse;
    const id = typeof r.id === "string" ? Number(r.id) : r.id;
    if (typeof id === "number" && wireIds.includes(id)) out.set(id, r);
  }
  if (out.size === 0 && items.length === 1) {
    const only = items[0] as Partial<JsonRpcResponse> | null;
    if (only && typeof only === "object" && only.error) {
      for (const id of wireIds) out.set(id, { jsonrpc: "2.0", id, error: only.error });
    }
  }
  return out;
}

/** Rebuild the body the page asked for: original order, original ids, no notifications. */
export function reassemble(parsed: ParsedBody, results: (JsonRpcResponse | undefined)[]): string {
  const out: JsonRpcResponse[] = [];
  parsed.requests.forEach((request, i) => {
    if (!("id" in request)) return; // a notification expects no response
    const id = request.id ?? null;
    const r = results[i];
    if (!r) out.push(rpcError(id, -32603, "Unlinked: no response for this call"));
    else if (r.error) out.push({ jsonrpc: "2.0", id, error: r.error });
    else out.push({ jsonrpc: "2.0", id, result: r.result });
  });
  return JSON.stringify(parsed.batch ? out : (out[0] ?? null));
}

export function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Methods a node answers identically forever for a given URL. */
export const CHAIN_ID_METHODS: ReadonlySet<string> = new Set(["eth_chainId", "net_version"]);

/** Wallet-side methods: not reads, never cached, not counted as leaks. */
const NON_READ_METHODS: ReadonlySet<string> = new Set([
  "eth_accounts",
  "eth_requestAccounts",
  "eth_chainId",
  "eth_coinbase",
  "eth_sendTransaction",
  "eth_sendRawTransaction",
  "eth_sign",
  "eth_signTransaction",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "eth_subscribe",
  "eth_unsubscribe",
]);

/** True for an `eth_*` read that a wallet forwards to its own RPC provider. */
export function isChainRead(method: string): boolean {
  return method.startsWith("eth_") && !NON_READ_METHODS.has(method);
}
