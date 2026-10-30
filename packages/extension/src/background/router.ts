// Every JSON-RPC body a page sends over fetch ends up here.
//
//   cache → group by isolation key → fresh wire ids → jitter → anon worker
//         → failover if the endpoint refuses anonymous traffic → reassemble
//
// Failing closed is the default: if the anonymity network is down, calls get
// an error rather than quietly going out with the user's IP. Fail-open is a
// setting, and the report counts what it sent directly.

import { firstOwnAddress } from "../../../core/src/addresses.ts";
import { cacheKey, cacheTtl, Inflight, TtlCache } from "../../../core/src/cache.ts";
import { guessChainId } from "../../../core/src/chains.ts";
import { isolationIdentity, opaqueKey } from "../../../core/src/isolation.ts";
import {
  decodeGroup,
  encodeGroup,
  groupByKey,
  parseJsonRpc,
  reassemble,
  rpcError,
  type JsonRpcResponse,
  type PlannedCall,
  type WireGroup,
} from "../../../core/src/jsonrpc.ts";
import { hostOf, siteOf } from "../../../core/src/site.ts";
import { CALL_TIMEOUT_MS, FALLBACK_RPCS, MAX_JITTER_MS, WIRE_HEADERS } from "../config.ts";
import type { RpcReply } from "../types.ts";
import { message, withTimeout, workerFor } from "./anon.ts";
import { getSettings, installSalt, ownAddresses } from "./settings.ts";
import { mutateReport } from "./state.ts";

const cache = new TtlCache<JsonRpcResponse>(4_000);
const inflight = new Inflight<{ response: JsonRpcResponse | undefined; failedOver: boolean }>();
const wireCounters = new Map<string, number>();
const chainIds = new Map<string, string>(); // endpoint URL -> chain id hex

const JSON_HEADERS: [string, string][] = [["content-type", "application/json"]];

class UpstreamError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(status ? `HTTP ${status} through the anonymity network` : detail);
    this.status = status;
  }
}

export async function handleRpc(tabId: number, site: string, url: string, body: string): Promise<RpcReply> {
  const settings = await getSettings();
  const parsed = parseJsonRpc(body);
  if (!parsed) return { passthrough: true };
  const n = parsed.requests.length;
  const providerHost = hostOf(url) ?? "unknown";

  if (settings.disabledSites.includes(site)) {
    await record(tabId, (r) => {
      r.rpc.calls += n;
      r.rpc.direct += n;
      r.rpc.providers[providerHost] = (r.rpc.providers[providerHost] ?? 0) + n;
    });
    return { passthrough: true };
  }

  const own = await ownAddresses();
  const salt = await installSalt();
  const results: (JsonRpcResponse | undefined)[] = new Array(n);
  const toSend: PlannedCall[] = [];
  let fromCache = 0;
  let withAddress = 0;

  parsed.requests.forEach((request, index) => {
    if (firstOwnAddress(request.params, own)) withAddress++;
    const hit = cache.get(cacheKey(url, request.method, request.params));
    if (hit) {
      results[index] = hit;
      fromCache++;
      return;
    }
    toSend.push({ index, request, key: opaqueKey(isolationIdentity(site, request, own), salt) });
  });

  const groups = groupByKey(toSend);
  const started = Date.now();
  let failed = 0;
  let failovers = 0;
  let upstreamRefused = false;

  await Promise.all(
    groups.map(async (group) => {
      try {
        const { responses, failedOver } = await sendDeduped(url, group);
        if (failedOver) failovers++;
        for (const call of group.calls) {
          const r = responses.get(call);
          results[call.index] = r;
          if (!r || r.error) continue;
          cache.set(cacheKey(url, call.request.method, call.request.params), r, cacheTtl(call.request.method, call.request.params, r.result));
          if (call.request.method === "eth_chainId" && typeof r.result === "string") chainIds.set(url, r.result.toLowerCase());
        }
      } catch (err) {
        failed += group.calls.length;
        if (err instanceof UpstreamError && (err.status === 401 || err.status === 403)) upstreamRefused = true;
        for (const call of group.calls) {
          results[call.index] = rpcError(call.request.id ?? null, -32603, `Unlinked: ${message(err)}`);
        }
      }
    }),
  );

  // A first-party endpoint that wants the page's cookies can't be reached
  // anonymously. The first party already knows the user's IP, so nothing new
  // leaks by letting the page talk to it directly.
  const firstParty = siteOf(hostOf(url) ?? "") === site;
  const direct = failed > 0 && (settings.failOpen || (firstParty && upstreamRefused));

  await record(tabId, (r) => {
    r.dapp = true;
    r.rpc.calls += n;
    r.rpc.cached += fromCache;
    r.rpc.withAddress += withAddress;
    r.rpc.failovers += failovers;
    r.rpc.providers[providerHost] = (r.rpc.providers[providerHost] ?? 0) + n;
    if (direct) r.rpc.direct += toSend.length;
    else {
      r.rpc.routed += toSend.length - failed;
      r.rpc.failed += failed;
    }
    for (const g of groups) if (!r.rpc.keys.includes(g.key)) r.rpc.keys.push(g.key);
    if (toSend.length > failed) {
      r.rpc.latencyTotal += Date.now() - started;
      r.rpc.latencyCount++;
    }
  });

  if (direct) return { passthrough: true };
  return { passthrough: false, status: 200, headers: JSON_HEADERS, body: reassemble(parsed, results) };
}

/** Identical single calls in flight at once (two components polling the same balance) share one trip. */
async function sendDeduped(url: string, group: WireGroup) {
  if (group.calls.length !== 1) return sendGroup(url, group);
  const only = group.calls[0];
  const key = `${group.key}\u0000${cacheKey(url, only.request.method, only.request.params)}`;
  const shared = await inflight.run(key, async () => {
    const out = await sendGroup(url, group);
    return { response: out.responses.get(only), failedOver: out.failedOver };
  });
  return { responses: new Map([[only, shared.response]]), failedOver: shared.failedOver };
}

async function sendGroup(url: string, group: WireGroup) {
  const nextId = () => {
    const id = (wireCounters.get(group.key) ?? 0) + 1;
    wireCounters.set(group.key, id);
    return id;
  };
  const { body, wireIds } = encodeGroup(group, nextId);
  await new Promise((r) => setTimeout(r, Math.random() * MAX_JITTER_MS));
  const worker = await workerFor(group.key);

  const attempt = async (target: string): Promise<{ status: number; text: string; error?: string }> => {
    try {
      const res = await withTimeout(
        worker.fetch(target, { method: "POST", headers: WIRE_HEADERS, body, anonOptions: { isolationKey: group.key } }),
        CALL_TIMEOUT_MS,
        "no response",
      );
      return { status: res.status, text: await res.text() };
    } catch (err) {
      return { status: 0, text: "", error: message(err) };
    }
  };

  let outcome = await attempt(url);
  let failedOver = false;
  if (!isOk(outcome.status)) {
    // Learned from the endpoint's own answers, else read from its URL: an
    // endpoint that refuses us from the first call never tells us its chain.
    const chainId = chainIds.get(url) ?? guessChainId(url);
    for (const alt of (chainId && FALLBACK_RPCS[chainId]) || []) {
      if (alt === url) continue;
      failedOver = true;
      outcome = await attempt(alt);
      if (isOk(outcome.status)) break;
    }
  }
  if (!isOk(outcome.status)) throw new UpstreamError(outcome.status, outcome.error ?? "no response");

  const decoded = decodeGroup(outcome.text, wireIds);
  const responses = new Map<PlannedCall, JsonRpcResponse | undefined>();
  group.calls.forEach((call, i) => responses.set(call, decoded.get(wireIds[i])));
  return { responses, failedOver };
}

const isOk = (status: number) => status >= 200 && status < 300;

function record(tabId: number, fn: Parameters<typeof mutateReport>[1]) {
  return mutateReport(tabId, fn).catch(() => {});
}

export function clearRouterCaches(): void {
  cache.clear();
  wireCounters.clear();
}
