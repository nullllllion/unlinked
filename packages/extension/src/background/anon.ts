// The anon-rpc workers.
//
// Isolation, two ways at once. Every call carries `anonOptions.isolationKey`
// (spec 0.4.0), which a worker MAY honour. Because the deployed tor-js worker
// may not yet, strict mode also spreads keys over a small pool of independent
// clients. The offscreen harness reuses a booted worker per address+config, so
// a slot marker in the config is what gives each slot its own client (and
// lets it survive the service worker being stopped). If a network rejects the
// marker, the pool degrades to one client and isolationKey alone.
//
// Bootstrap. Booting needs two reads of the specifier contract, and they can't
// be anonymous: there is no worker yet. They happen once per install; later
// boots answer them from storage, and every boot refreshes them through the
// worker it just verified. The hash pin still guards the bytes either way.

import { AnonRpcWorker } from "@anon-rpc/browser-extension-harness";
import { BOOT_TIMEOUT_MS, BOOTSTRAP_RPC, NETWORKS, POOL_SIZE, WIRE_HEADERS } from "../config.ts";
import type { NetworkId, Settings, WorkerStatus } from "../types.ts";
import { getSettings } from "./settings.ts";

type Slot = { worker: AnonRpcWorker; ready: Promise<void> };

type Pool = {
  id: string;
  network: NetworkId;
  size: number;
  slots: Map<number, Slot>;
  assignment: Map<string, number>;
  next: number;
  /** A slot failed to boot with a marker: fall back to slot 0 for everything. */
  singleOnly: boolean;
};

let pool: Pool | undefined;
let status: WorkerStatus = { network: "tor", state: "idle", specifier: NETWORKS.tor.specifier, slots: 0 };
let onStatus: () => void = () => {};

export function workerStatus(): WorkerStatus {
  return status;
}

export function setStatusListener(fn: () => void): void {
  onStatus = fn;
}

function setStatus(next: WorkerStatus): void {
  status = next;
  onStatus();
}

export async function workerFor(key: string): Promise<AnonRpcWorker> {
  const p = ensurePool(await getSettings());
  const slot = slotFor(p, key);
  try {
    return await slotWorker(p, slot);
  } catch (err) {
    if (slot === 0) throw err;
    p.singleOnly = true;
    p.assignment.set(key, 0);
    return slotWorker(p, 0);
  }
}

/** Tear down after a settings change; the next call boots fresh. */
export function resetPool(): void {
  if (pool) for (const s of pool.slots.values()) s.worker.close();
  pool = undefined;
}

/** One JSON-RPC call through a worker, for the extension's own reads. */
export async function anonJsonRpc(worker: AnonRpcWorker, url: string, method: string, params: unknown, isolationKey: string): Promise<unknown> {
  const res = await worker.fetch(url, {
    method: "POST",
    headers: WIRE_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    anonOptions: { isolationKey },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  return body.result;
}

function ensurePool(settings: Settings): Pool {
  const id = JSON.stringify([settings.network, settings.torGateways, settings.strictIsolation]);
  if (pool?.id === id) return pool;
  resetPool();
  pool = {
    id,
    network: settings.network,
    size: settings.strictIsolation ? POOL_SIZE : 1,
    slots: new Map(),
    assignment: new Map(),
    next: 0,
    singleOnly: false,
  };
  setStatus({ network: settings.network, state: "idle", specifier: NETWORKS[settings.network].specifier, slots: 0 });
  return pool;
}

function slotFor(p: Pool, key: string): number {
  if (p.singleOnly || p.size === 1) return 0;
  let slot = p.assignment.get(key);
  if (slot === undefined) {
    slot = p.next++ % p.size;
    p.assignment.set(key, slot);
  }
  return slot;
}

async function slotWorker(p: Pool, index: number): Promise<AnonRpcWorker> {
  let slot = p.slots.get(index);
  if (!slot) {
    slot = bootSlot(p, index, await getSettings());
    p.slots.set(index, slot);
  }
  await slot.ready;
  return slot.worker;
}

function bootSlot(p: Pool, index: number, settings: Settings): Slot {
  const network = NETWORKS[p.network];
  const base: Record<string, unknown> | undefined = p.network === "tor" ? { gateways: settings.torGateways } : undefined;
  const config = index === 0 ? base : { ...base, unlinkedSlot: index };
  const boot = bootstrapProvider(network.specifierChainId);
  const started = Date.now();
  if (index === 0) setStatus({ ...status, state: "booting", error: undefined });

  const worker = new AnonRpcWorker({
    address: network.specifier,
    config: config as never,
    preExisting: { rpcProvider: boot.provider },
  });
  const ready = withTimeout(worker.ready, BOOT_TIMEOUT_MS, "the worker did not become ready").then(
    () => {
      if (pool !== p) return;
      setStatus({
        ...status,
        state: "ready",
        slots: p.slots.size,
        bootMs: index === 0 ? Date.now() - started : status.bootMs,
        bootstrapCached: index === 0 ? boot.fromCache() : status.bootstrapCached,
        pinnedHash: boot.pinnedHash() ?? status.pinnedHash,
      });
      void boot.refreshVia(worker);
    },
    async (err: unknown) => {
      worker.close();
      p.slots.delete(index);
      // A cached pin that no longer boots is stale: read it fresh next time.
      if (boot.fromCache()) await boot.clear();
      if (index === 0 && pool === p) setStatus({ ...status, state: "error", error: message(err) });
      throw err;
    },
  );
  return { worker, ready };
}

function bootstrapProvider(chainId: number) {
  const url = BOOTSTRAP_RPC[chainId];
  const prefix = `boot:${chainId}:`;
  const keyOf = (method: string, params: unknown) => `${prefix}${method}:${JSON.stringify(params ?? [])}`;
  const calls: { method: string; params: unknown[]; result: unknown }[] = [];
  let hits = 0;
  let fresh = 0;

  return {
    provider: {
      async request({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
        const k = keyOf(method, params);
        const stored = (await chrome.storage.local.get(k))[k];
        if (stored !== undefined) {
          hits++;
          calls.push({ method, params, result: stored });
          return stored;
        }
        fresh++; // the one non-anonymous read this install makes
        const result = await directJsonRpc(url, method, params);
        await chrome.storage.local.set({ [k]: result });
        calls.push({ method, params, result });
        return result;
      },
    },
    fromCache: () => hits > 0 && fresh === 0,
    pinnedHash: () => calls.map((c) => c.result).find((r): r is string => typeof r === "string" && /^0x[0-9a-f]{64}$/i.test(r)),
    async refreshVia(worker: AnonRpcWorker): Promise<void> {
      for (const c of calls) {
        try {
          const latest = await anonJsonRpc(worker, url, c.method, c.params, "unlinked:bootstrap");
          if (JSON.stringify(latest) !== JSON.stringify(c.result)) await chrome.storage.local.set({ [keyOf(c.method, c.params)]: latest });
        } catch {
          // Keep the old pin; the next boot tries again.
        }
      }
    },
    async clear(): Promise<void> {
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith(prefix)));
    },
  };
}

async function directJsonRpc(url: string, method: string, params: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`bootstrap HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "bootstrap RPC error");
  return body.result;
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
