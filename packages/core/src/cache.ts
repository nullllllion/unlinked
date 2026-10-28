// Response caching for JSON-RPC reads.
//
// Every call through Tor costs ~1.5 s, so the cheapest privacy win is not
// asking twice. Answers pinned to a block are stable for minutes; "latest"
// answers are only deduplicated across a burst. Anything that mutates state or
// depends on the mempool is never cached.

const NEVER: ReadonlySet<string> = new Set([
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "eth_uninstallFilter",
  "eth_subscribe",
  "eth_unsubscribe",
]);

/** Index of the block-tag parameter for methods that take one. */
const BLOCK_PARAM: Readonly<Record<string, number>> = {
  eth_getBalance: 1,
  eth_getCode: 1,
  eth_getTransactionCount: 1,
  eth_call: 1,
  eth_estimateGas: 1,
  eth_getStorageAt: 2,
  eth_getProof: 2,
  eth_getBlockByNumber: 0,
  eth_getBlockTransactionCountByNumber: 0,
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const BURST = 1_500;

/** How long a successful result may be served from cache, in ms. 0 = never. */
export function cacheTtl(method: string, params: unknown, result: unknown): number {
  if (NEVER.has(method)) return 0;
  if (method === "eth_chainId" || method === "net_version") return DAY;
  if (method === "eth_blockNumber") return 1_000;
  if (method === "eth_gasPrice" || method === "eth_maxPriorityFeePerGas" || method === "eth_feeHistory") return 3_000;
  if (method === "eth_getTransactionReceipt" || method === "eth_getTransactionByHash") {
    return result == null ? 0 : 10 * MINUTE; // null means "not mined yet": ask again
  }
  if (method === "eth_getBlockByHash" || method === "eth_getTransactionByBlockHashAndIndex") return 10 * MINUTE;
  if (method === "eth_getLogs") return logsPinned(params) ? 5 * MINUTE : BURST;

  const at = BLOCK_PARAM[method];
  if (at === undefined) return method.startsWith("eth_") ? BURST : 0;
  const tag = Array.isArray(params) ? params[at] : undefined;
  if (method === "eth_getTransactionCount" && tag === "pending") return 0; // nonces move
  return isPinnedTag(tag) ? 5 * MINUTE : BURST;
}

function isPinnedTag(tag: unknown): boolean {
  if (typeof tag === "string") return /^0x[0-9a-f]+$/i.test(tag) && tag.length < 66;
  if (tag && typeof tag === "object") return "blockHash" in tag || "blockNumber" in tag; // EIP-1898
  return false;
}

function logsPinned(params: unknown): boolean {
  const filter = Array.isArray(params) ? (params[0] as Record<string, unknown> | undefined) : undefined;
  if (!filter || typeof filter !== "object") return false;
  if (typeof filter.blockHash === "string") return true;
  return isPinnedTag(filter.fromBlock) && isPinnedTag(filter.toBlock);
}

export function cacheKey(url: string, method: string, params: unknown): string {
  return `${url}\u0000${method}\u0000${JSON.stringify(params ?? null)}`;
}

/** A bounded TTL map. Oldest entries go first when full. */
export class TtlCache<V> {
  #entries = new Map<string, { value: V; expires: number }>();
  readonly max: number;

  constructor(max = 2_000) {
    this.max = max;
  }

  get(key: string, now = Date.now()): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= now) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number, now = Date.now()): void {
    if (ttlMs <= 0) return;
    this.#entries.delete(key);
    this.#entries.set(key, { value, expires: now + ttlMs });
    while (this.#entries.size > this.max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** Collapses identical concurrent work into one promise. */
export class Inflight<V> {
  #running = new Map<string, Promise<V>>();

  run(key: string, work: () => Promise<V>): Promise<V> {
    const existing = this.#running.get(key);
    if (existing) return existing;
    const p = work().finally(() => this.#running.delete(key));
    this.#running.set(key, p);
    return p;
  }
}
