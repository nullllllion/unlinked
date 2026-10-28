// The Code row: hash the scripts a page ran, ask Arkiv who attested them.
//
// Every lookup goes through the anon worker under the site's own isolation
// key, so no Arkiv node can assemble a browsing history from them, and all of
// a page's hashes go out as one OR query: one Tor round trip, not sixty.

import {
  arkivQueryRequest,
  assetsByHashQuery,
  buildsByRootQuery,
  parseArkivPage,
  type ArkivEntity,
} from "../../../core/src/arkiv.ts";
import { TtlCache } from "../../../core/src/cache.ts";
import { opaqueKey } from "../../../core/src/isolation.ts";
import { computeVerdict, type AssetHash, type CodeVerdict } from "../../../core/src/verdict.ts";
import { WIRE_HEADERS } from "../config.ts";
import { message, workerFor } from "./anon.ts";
import { getSettings, installSalt } from "./settings.ts";
import { mutateReport } from "./state.ts";

const HASHES_PER_QUERY = 40;
const MAX_PAGES = 5;
const verdicts = new TtlCache<CodeVerdict>(200);

export async function verifyAssets(tabId: number, site: string, assets: AssetHash[]): Promise<void> {
  const hashes = [...new Set(assets.map((a) => a.sha256).filter((h): h is string => h !== null))].sort();
  const memo = `${site}\u0000${hashes.join(",")}`;
  let verdict = verdicts.get(memo);
  if (!verdict) {
    verdict = await lookUp(site, assets, hashes);
    if (verdict.state !== "error") verdicts.set(memo, verdict, 10 * 60_000);
  }
  const settled = verdict;
  await mutateReport(tabId, (r) => {
    r.code = settled;
  }).catch(() => {});
}

async function lookUp(site: string, assets: AssetHash[], hashes: string[]): Promise<CodeVerdict> {
  const settings = await getSettings();
  const trusted = new Set(settings.trustedAttesters.map((a) => a.toLowerCase()));
  if (hashes.length === 0) return computeVerdict({ assets, assetEntities: [], buildEntities: [], trusted, headBlock: 0n });
  try {
    const key = opaqueKey(site, await installSalt());
    const assetEntities: ArkivEntity[] = [];
    let headBlock = 0n;
    for (let i = 0; i < hashes.length; i += HASHES_PER_QUERY) {
      const page = await queryAll(settings.arkivRpc, assetsByHashQuery(hashes.slice(i, i + HASHES_PER_QUERY)), key);
      assetEntities.push(...page.entities);
      if (page.blockNumber > headBlock) headBlock = page.blockNumber;
    }
    const roots = [...new Set(assetEntities.map((e) => String(e.attributes.root ?? "")).filter((r) => /^0x[0-9a-f]{64}$/.test(r)))];
    const buildEntities = roots.length ? (await queryAll(settings.arkivRpc, buildsByRootQuery(roots), key)).entities : [];
    return computeVerdict({ assets, assetEntities, buildEntities, trusted, headBlock });
  } catch (err) {
    return { state: "error", message: message(err) };
  }
}

async function queryAll(rpc: string, query: string, key: string): Promise<{ entities: ArkivEntity[]; blockNumber: bigint }> {
  const entities: ArkivEntity[] = [];
  let blockNumber = 0n;
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const worker = await workerFor(key);
    const res = await worker.fetch(rpc, {
      method: "POST",
      headers: WIRE_HEADERS,
      body: JSON.stringify(arkivQueryRequest(i + 1, query, cursor)),
      anonOptions: { isolationKey: key },
    });
    if (!res.ok) throw new Error(`Arkiv answered HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`Arkiv: ${body.error.message ?? "query failed"}`);
    const page = parseArkivPage(body.result);
    entities.push(...page.entities);
    if (page.blockNumber > blockNumber) blockNumber = page.blockNumber;
    if (!page.cursor || page.entities.length === 0) break;
    cursor = page.cursor;
  }
  return { entities, blockNumber };
}

export function clearVerdicts(): void {
  verdicts.clear();
}
