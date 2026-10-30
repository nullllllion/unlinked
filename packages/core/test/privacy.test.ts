import { test } from "node:test";
import assert from "node:assert/strict";
import { findOwnAddresses, firstOwnAddress, normalizeAddress } from "../src/addresses.ts";
import { isolationIdentity, opaqueKey } from "../src/isolation.ts";
import { isThirdParty, siteOf } from "../src/site.ts";
import { trackerCategory } from "../src/trackers.ts";
import { cacheKey, cacheTtl, Inflight, TtlCache } from "../src/cache.ts";
import { guessChainId } from "../src/chains.ts";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const own = new Set([ALICE, BOB]);

test("an address padded inside calldata is still the user's address", () => {
  const balanceOfAlice = "0x70a08231000000000000000000000000" + ALICE.slice(2).toUpperCase();
  assert.equal(firstOwnAddress([{ to: "0xtoken", data: balanceOfAlice }, "latest"], own), ALICE);
  assert.equal(firstOwnAddress(["0x" + "3".repeat(40), "latest"], own), null);
});

test("leak scanning matches any casing and URL-embedded forms", () => {
  assert.deepEqual(findOwnAddresses(`https://t.example/e?w=${BOB.toUpperCase().replace("0X", "0x")}`, own), [BOB]);
  assert.deepEqual(findOwnAddresses("nothing here", own), []);
  assert.equal(normalizeAddress("0xAbCdEf0000000000000000000000000000000001"), "0xabcdef0000000000000000000000000000000001");
  assert.equal(normalizeAddress("0x123"), null);
});

test("isolation identity is per site, then per account", () => {
  const read = (params: unknown) => ({ jsonrpc: "2.0" as const, id: 1, method: "eth_call", params });
  assert.equal(isolationIdentity("app.xyz", read([]), own), "app.xyz");
  assert.equal(isolationIdentity("app.xyz", read([ALICE]), own), `app.xyz#${ALICE}`);
  assert.notEqual(opaqueKey(`app.xyz#${ALICE}`, "salt"), opaqueKey(`app.xyz#${BOB}`, "salt"));
  assert.notEqual(opaqueKey("app.xyz", "salt-1"), opaqueKey("app.xyz", "salt-2"));
  assert.match(opaqueKey("app.xyz", "s"), /^[0-9a-f]{16}$/);
});

test("siteOf groups hosts the way first-party checks need", () => {
  assert.equal(siteOf("app.uniswap.org"), "uniswap.org");
  assert.equal(siteOf("quietswap.eth.limo"), "quietswap.eth.limo");
  assert.equal(siteOf("my-dapp.vercel.app"), "my-dapp.vercel.app");
  assert.equal(siteOf("bafy.ipfs.dweb.link"), "bafy.ipfs.dweb.link");
  assert.equal(siteOf("www.bbc.co.uk"), "bbc.co.uk");
  assert.equal(siteOf("127.0.0.1"), "127.0.0.1");
  assert.equal(isThirdParty("api.segment.io", "uniswap.org"), true);
  assert.equal(isThirdParty("interface.gateway.uniswap.org", "uniswap.org"), false);
});

test("the chain is read from well-known provider URLs, and never guessed when ambiguous", () => {
  assert.equal(guessChainId("https://eth-mainnet.g.alchemy.com/v2/KEY"), "0x1");
  assert.equal(guessChainId("https://mainnet.infura.io/v3/KEY"), "0x1");
  assert.equal(guessChainId("https://ethereum-rpc.publicnode.com"), "0x1");
  assert.equal(guessChainId("https://eth.drpc.org"), "0x1");
  assert.equal(guessChainId("https://rpc.ankr.com/eth"), "0x1");
  assert.equal(guessChainId("https://sepolia.infura.io/v3/KEY"), "0xaa36a7");
  assert.equal(guessChainId("https://rpc.ankr.com/eth_sepolia"), "0xaa36a7");
  assert.equal(guessChainId("https://base-mainnet.g.alchemy.com/v2/KEY"), "0x2105");
  assert.equal(guessChainId("https://opt-mainnet.g.alchemy.com/v2/KEY"), "0xa");
  assert.equal(guessChainId("https://arb-mainnet.g.alchemy.com/v2/KEY"), "0xa4b1");
  assert.equal(guessChainId("https://base-sepolia.g.alchemy.com/v2/KEY"), undefined, "an L2 testnet is not Sepolia");
  assert.equal(guessChainId("https://polygon-mainnet.infura.io/v3/KEY"), undefined);
  assert.equal(guessChainId("https://eth-holesky.g.alchemy.com/v2/KEY"), undefined);
  assert.equal(guessChainId("https://rpc.example.org"), undefined);
  assert.equal(guessChainId("not a url"), undefined);
});

test("trackers are named by host or parent domain", () => {
  assert.equal(trackerCategory("www.google-analytics.com"), "analytics");
  assert.equal(trackerCategory("o123.ingest.sentry.io"), "error monitoring");
  assert.equal(trackerCategory("rpc.ankr.com"), null);
});

test("cache policy: pinned reads last, latest reads only dedupe, sends never cache", () => {
  assert.equal(cacheTtl("eth_sendRawTransaction", ["0x"], "0xhash"), 0);
  assert.equal(cacheTtl("eth_getBalance", [ALICE, "0x10"], "0x1"), 300_000);
  assert.equal(cacheTtl("eth_getBalance", [ALICE, "latest"], "0x1"), 1_500);
  assert.equal(cacheTtl("eth_getTransactionCount", [ALICE, "pending"], "0x1"), 0);
  assert.equal(cacheTtl("eth_getTransactionReceipt", ["0xh"], null), 0);
  assert.ok(cacheTtl("eth_getTransactionReceipt", ["0xh"], { status: "0x1" }) > 0);
  assert.equal(cacheTtl("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }], []), 300_000);
  assert.equal(cacheTtl("eth_getLogs", [{ fromBlock: "0x1", toBlock: "latest" }], []), 1_500);
  assert.equal(cacheTtl("wallet_switchEthereumChain", [], null), 0);
});

test("TtlCache expires and evicts; Inflight collapses concurrent work", async () => {
  const c = new TtlCache<number>(2);
  c.set("a", 1, 100, 0);
  assert.equal(c.get("a", 50), 1);
  assert.equal(c.get("a", 100), undefined);
  c.set("a", 1, 1000, 0);
  c.set("b", 2, 1000, 0);
  c.set("c", 3, 1000, 0);
  assert.equal(c.get("a", 1), undefined, "oldest evicted when full");
  assert.notEqual(cacheKey("u", "m", [1]), cacheKey("u", "m", [2]));

  const inflight = new Inflight<number>();
  let runs = 0;
  const work = () => new Promise<number>((r) => setTimeout(() => r(++runs), 5));
  const [x, y] = await Promise.all([inflight.run("k", work), inflight.run("k", work)]);
  assert.equal(x, 1);
  assert.equal(y, 1);
  assert.equal(runs, 1);
});
