// End to end, in real Chromium, with the real anon-rpc harness.
//
// The passthrough worker is used so the test needs no Tor gateway: it is the
// reference worker, hash-pinned on mainnet and booted through the same
// specifier read, bundle verification and sandbox as tor-js. Everything
// Unlinked does around the worker — interception, isolation, id rewriting,
// leak observation, Arkiv verification, the modal — runs for real.
//
// Mock servers stand in for an RPC provider, a tracker and Arkiv, and record
// what each would learn.
//
//   CHROME_PATH=/path/to/chrome node test/e2e.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const EXT = resolve(import.meta.dirname, "../dist/unpacked");
const ARTIFACTS = resolve(import.meta.dirname, "artifacts");
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CAROL = "0x3333333333333333333333333333333333333333";
const ATTESTER = "0x00000000000000000000000000000000000000c1";
const ROOT = "0x" + "a".repeat(64);
const sha = (s) => "0x" + createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --- the provider, the tracker and Arkiv, all on "localhost" ------------- */

const providerSaw = [];
const blockedSaw = [];
const trackerSaw = [];
const arkivSaw = [];
const attested = new Set();
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };

function answer(req) {
  switch (req.method) {
    case "eth_chainId":
      return { jsonrpc: "2.0", id: req.id, result: "0xaa36a7" };
    case "eth_getBalance":
      return { jsonrpc: "2.0", id: req.id, result: req.params[0].toLowerCase() === ALICE ? "0xa11ce" : "0xb0b" };
    case "eth_blockNumber":
      return { jsonrpc: "2.0", id: req.id, result: "0x10" };
    default:
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } };
  }
}

function arkiv(query) {
  const attrs = (o) => Object.entries(o).map(([name, value]) => ({ name, type: name === "sha256" || name === "root" ? "bytes32" : "str", value }));
  let data = [];
  if (query.includes("type = str('asset')")) {
    const hashes = [...query.matchAll(/bytes32\((0x[0-9a-f]{64})\)/g)].map((m) => m[1]);
    data = hashes.filter((h) => attested.has(h)).map((h) => ({
      key: "0x" + h.slice(2, 66),
      owner: ATTESTER,
      expiresAt: "0x" + (0x100000 + 43200 * 30).toString(16),
      attributes: attrs({ project: "unlinked", type: "asset", sha256: h, root: ROOT, path: "app.js" }),
    }));
  } else if (query.includes("type = str('build')")) {
    data = [{
      key: "0x" + "b".repeat(64),
      owner: ATTESTER,
      expiresAt: "0x" + (0x100000 + 43200 * 30).toString(16),
      attributes: attrs({ project: "unlinked", type: "build", root: ROOT, name: "test-dapp", repo: "github.com/unlinked/test-dapp", commit: "abcdef1234567", version: "0.1.0" }),
    }];
  }
  return { data, blockNumber: "0x100000" };
}

const thirdParty = createServer(async (req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.url.includes("blocked")) {
    blockedSaw.push(body);
    return res.writeHead(403, CORS).end("anonymous traffic refused");
  }
  if (req.url.startsWith("/rpc")) {
    providerSaw.push(body);
    const parsed = JSON.parse(body);
    const out = Array.isArray(parsed) ? parsed.map(answer) : answer(parsed);
    return res.writeHead(200, { ...CORS, "content-type": "application/json" }).end(JSON.stringify(out));
  }
  if (req.url.startsWith("/arkiv")) {
    const { id, params } = JSON.parse(body);
    arkivSaw.push(params[0]);
    return res.writeHead(200, { ...CORS, "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: arkiv(params[0]) }));
  }
  if (req.url.startsWith("/t")) {
    trackerSaw.push(req.url);
    return res.writeHead(204, { ...CORS, "set-cookie": "tid=1; SameSite=None; Secure" }).end();
  }
  if (req.url.startsWith("/plain")) return res.writeHead(200, CORS).end("plain ok");
  res.writeHead(404).end();
});
await new Promise((r) => thirdParty.listen(0, "localhost", r));
const TP = `http://localhost:${thirdParty.address().port}`;

/* --- the dapp, on 127.0.0.1 ---------------------------------------------- */

const APP_JS = `(async () => {
  const rpc = (body) => fetch("${TP}/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const out = {};
  out.chainId = await rpc({ jsonrpc: "2.0", id: 7, method: "eth_chainId", params: [] });
  out.batch = await rpc([
    { jsonrpc: "2.0", id: 41, method: "eth_getBalance", params: ["${ALICE}", "latest"] },
    { jsonrpc: "2.0", id: 42, method: "eth_getBalance", params: ["${BOB}", "latest"] },
    { jsonrpc: "2.0", id: 43, method: "eth_blockNumber", params: [] },
  ]);
  out.plain = await fetch("${TP}/plain").then((r) => r.text());
  new Image().src = "${TP}/t?wallet=${ALICE}";
  // The wallet: a read through window.ethereum goes to the wallet's own RPC.
  await new Promise((r) => (document.readyState === "complete" ? r() : addEventListener("load", r)));
  out.walletAccounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  out.walletBalance = await window.ethereum.request({ method: "eth_getBalance", params: ["${CAROL}", "latest"] });
  window.__results = out;
})().catch((e) => { window.__error = String((e && e.stack) || e); });`;
const INJECTED_JS = "window.__drainer = true;";
attested.add(sha(APP_JS));

const dapp = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/") {
    const extra = url.searchParams.has("tamper") ? '<script src="/assets/extra.js"></script>' : "";
    // A stand-in wallet, injected the way real ones are: before the dapp's code runs.
    const wallet = `<script>window.ethereum = { on() {}, request: async ({ method }) =>
      method === "eth_requestAccounts" || method === "eth_accounts" ? ["${CAROL}"] : method === "eth_getBalance" ? "0x5" : null };</script>`;
    return res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Test dapp</title>${wallet}<h1>Test dapp</h1><script src="/app.js"></script>${extra}`);
  }
  if (url.pathname === "/app.js") return res.writeHead(200, { "content-type": "text/javascript", "cache-control": "max-age=600" }).end(APP_JS);
  if (url.pathname === "/assets/extra.js") return res.writeHead(200, { "content-type": "text/javascript", "cache-control": "max-age=600" }).end(INJECTED_JS);
  res.writeHead(404).end();
});
await new Promise((r) => dapp.listen(0, "127.0.0.1", r));
const DAPP = `http://127.0.0.1:${dapp.address().port}`;

/* --- the browser --------------------------------------------------------- */

await mkdir(ARTIFACTS, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "unlinked-e2e-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
  viewport: { width: 1100, height: 700 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

async function poll(read, ok, what, timeout = 90_000) {
  const start = Date.now();
  let value;
  while (Date.now() - start < timeout) {
    value = await read();
    if (ok(value)) return value;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}; last value:\n${JSON.stringify(value, null, 2)}`);
}

let failed = false;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed = true;
    console.log(`  ✖ ${name}\n${err.stack ?? err}`);
    throw err;
  }
};

try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(sw.url()).host;
  await sw.evaluate(
    (s) => chrome.storage.local.set({ settings: s }),
    { network: "passthrough", torGateways: [], strictIsolation: true, alerts: "modal", failOpen: false, disabledSites: [], hiddenSites: [], trustedAttesters: [ATTESTER], manualAddresses: [ALICE, BOB], arkivRpc: `${TP}/arkiv` },
  );
  const reportOf = (tabId) => sw.evaluate(async (id) => (await chrome.storage.session.get(`report:${id}`))[`report:${id}`], tabId);
  const badgeOf = (tabId) => sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);

  console.log("unlinked e2e");
  const page = await context.newPage();
  const started = Date.now();
  await page.goto(DAPP);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "http://127.0.0.1/*" }))[0]?.id);

  await step("the dapp's own fetch calls are answered through the anon-rpc worker", async () => {
    await page.waitForFunction(() => window.__results || window.__error, null, { timeout: 120_000 });
    assert.equal(await page.evaluate(() => window.__error), undefined);
    const results = await page.evaluate(() => window.__results);
    assert.deepEqual(results.chainId, { jsonrpc: "2.0", id: 7, result: "0xaa36a7" });
    assert.deepEqual(results.batch.map((r) => [r.id, r.result]), [[41, "0xa11ce"], [42, "0xb0b"], [43, "0x10"]]);
    assert.equal(results.plain, "plain ok", "non-JSON-RPC fetches pass through untouched");
    console.log(`    (first answer after ${((Date.now() - started) / 1000).toFixed(1)} s, including worker boot)`);
  });

  await step("the provider never sees two accounts in one request, or the page's ids", () => {
    assert.equal(providerSaw.length, 4, `expected chainId + one request per identity, got ${providerSaw.length}`);
    for (const body of providerSaw) {
      assert.ok(!(body.includes(ALICE.slice(2)) && body.includes(BOB.slice(2))), `linked accounts in: ${body}`);
      assert.ok(!/"id":(7|41|42|43)\b/.test(body), `page id reached the provider: ${body}`);
    }
  });

  await step("the report counts routed calls, circuits, and the tracker that got the address", async () => {
    const r = await poll(() => reportOf(tabId), (r) => r?.rpc?.calls === 4 && r.thirdParties?.localhost?.gotAddress, "rpc + tracker report");
    assert.equal(r.rpc.routed, 4);
    assert.equal(r.rpc.keys.length, 3, `site, site#alice, site#bob; got ${JSON.stringify(r.rpc)} for bodies ${JSON.stringify(providerSaw)}`);
    assert.equal(r.rpc.withAddress, 2);
    assert.equal(r.thirdParties.localhost.cookies, 1);
    assert.equal(trackerSaw.length, 1);
  });

  await step("the wallet is observed, not rerouted: its account is learned and its reads are counted", async () => {
    const results = await page.evaluate(() => window.__results);
    assert.deepEqual(results.walletAccounts, [CAROL], "the wallet still answers the page");
    const r = await poll(() => reportOf(tabId), (r) => r?.rpc?.walletReads === 1, "wallet read counted");
    assert.equal(r.rpc.calls, 4, "wallet reads aren't counted as intercepted calls");
    const learned = await sw.evaluate(async () => (await chrome.storage.local.get("accounts")).accounts);
    assert.deepEqual(learned, [CAROL]);
  });

  await step("the page's script is verified against its Arkiv attestation, looked up through the worker", async () => {
    const r = await poll(() => reportOf(tabId), (r) => r?.code && r.code.state !== "pending", "code verdict");
    assert.equal(r.code.state, "verified", JSON.stringify(r.code));
    assert.equal(r.code.build.commit, "abcdef1234567");
    assert.equal(r.code.build.expiresInDays, 30);
    assert.equal(arkivSaw.length, 2, "one asset query, one build query");
    assert.match(arkivSaw[0], /^project = str\('unlinked'\) AND type = str\('asset'\)/);
  });

  await step("the short summary appears on the page and the badge reports the issues", async () => {
    await page.waitForSelector("unlinked-summary", { state: "attached", timeout: 15_000 });
    await sleep(400);
    await page.screenshot({ path: join(ARTIFACTS, "modal.png") });
    assert.match(await badgeOf(tabId), /^\d$/, "a warn count: the tracker got the address");
  });

  await step("the details view renders the same rows", async () => {
    const details = await context.newPage();
    await details.setViewportSize({ width: 520, height: 640 });
    await details.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
    await details.waitForSelector('.u-row[data-row="code"][data-tone="good"]');
    const text = await details.locator(".u-rows").innerText();
    assert.match(text, /4 calls → 1 provider/);
    assert.match(text, /100% via Passthrough · 3 circuits/);
    assert.match(text, /localhost got your address/);
    assert.match(text, /unlinked\/test-dapp @abcdef1/);
    await details.locator('.u-row[data-row="trackers"]').click();
    await details.screenshot({ path: join(ARTIFACTS, "details.png") });
    await details.emulateMedia({ colorScheme: "dark" });
    await details.screenshot({ path: join(ARTIFACTS, "details-dark.png") });
    await details.close();
  });

  await step("with no trusted attesters, an attestation is amber, never a green check (anyone can attest on Arkiv)", async () => {
    const setTrusted = (list) =>
      sw.evaluate(async (l) => {
        const { settings } = await chrome.storage.local.get("settings");
        await chrome.storage.local.set({ settings: { ...settings, trustedAttesters: l } });
      }, list);
    await setTrusted([]);
    const details = await context.newPage();
    await details.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
    await details.waitForSelector('.u-row[data-row="code"][data-tone="warn"]');
    assert.match(await details.locator('.u-row[data-row="code"]').innerText(), /unvetted/);
    await details.close();
    await setTrusted([ATTESTER]);
  });

  await step("an injected script next to the attested one turns the verdict red and forces the summary back", async () => {
    await page.goto(`${DAPP}/?tamper=1`);
    await page.waitForFunction(() => window.__results, null, { timeout: 60_000 });
    const r = await poll(() => reportOf(tabId), (r) => r?.code?.state === "mismatch", "mismatch verdict");
    assert.deepEqual(r.code.unknown, [`${DAPP}/assets/extra.js`]);
    await poll(() => badgeOf(tabId), (b) => b === "!", "red badge");
    await page.waitForSelector("unlinked-summary", { state: "attached", timeout: 15_000 });
    await sleep(400);
    await page.screenshot({ path: join(ARTIFACTS, "modal-mismatch.png") });
  });

  const pageRpc = (url, id, method = "eth_blockNumber") =>
    page.evaluate(
      async ([u, i, m]) => {
        const res = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: i, method: m, params: [] }) });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      [url, id, method],
    );

  await step("an RPC that refuses anonymous traffic from its first call fails over, using the chain in its URL", async () => {
    const before = (await reportOf(tabId)).rpc.failovers;
    // Never answered eth_chainId, so the chain comes from "sepolia" in the URL.
    const { body } = await pageRpc(`${TP}/eth-sepolia-blocked/rpc`, 90);
    assert.equal(blockedSaw.length, 1, "the refusing endpoint was tried first");
    assert.equal(body.id, 90);
    assert.ok(parseInt(body.result, 16) > 5_000_000, `a real Sepolia block from the fallback provider: ${JSON.stringify(body)}`);
    await poll(() => reportOf(tabId), (r) => r.rpc.failovers === before + 1, "failover counted");
  });

  await step("turning protection off for a site sends its calls directly, and the report says so", async () => {
    const details = await context.newPage();
    await details.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
    await details.locator('.u-switch[aria-checked="true"]').click();
    await details.waitForSelector('.u-switch[aria-checked="false"]');
    const before = (await reportOf(tabId)).rpc.direct;
    const { body } = await pageRpc(`${TP}/rpc`, 91);
    assert.equal(body.result, "0x10");
    assert.ok(providerSaw.some((b) => /"id":91\b/.test(b)), "the page's own request reached the provider unchanged");
    await poll(() => reportOf(tabId), (r) => r.rpc.direct === before + 1, "direct call counted");
    await details.waitForSelector('.u-row[data-row="rpc"][data-tone="warn"]');
    await details.locator('.u-switch[aria-checked="false"]').click();
    await details.waitForSelector('.u-switch[aria-checked="true"]');
    await details.close();
  });

  await step("when the anonymity network is down, calls fail closed instead of going out directly", async () => {
    await sw.evaluate(async () => {
      const { settings } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...settings, network: "tor", torGateways: ["not-a-gateway"] } });
    });
    const seen = providerSaw.length;
    const reply = await pageRpc(`${TP}/rpc`, 92).catch((e) => ({ error: String(e) }));
    assert.equal(providerSaw.length, seen, "nothing reached the provider");
    const message = reply.body?.error?.message ?? reply.error ?? "";
    assert.match(message, /Unlinked|Failed to fetch/, `expected a refusal, got ${JSON.stringify(reply)}`);
    console.log(`    (refused with: ${message.slice(0, 90)})`);
  });

  console.log(failed ? "FAILED" : "all passed");
} finally {
  await context.close();
  thirdParty.close();
  dapp.close();
  await rm(profile, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
