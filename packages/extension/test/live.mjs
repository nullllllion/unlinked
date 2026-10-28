// Live smoke test: Quiet Swap against real Sepolia and the real Arkiv
// testnet, with Unlinked in the loop. No mocks.
//
//   NETWORK=passthrough node test/live.mjs   # plumbing only, fast
//   NETWORK=tor node test/live.mjs           # real Tor via the EF demo gateway
//
// Build both first: npm run build (at the repo root).

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright";

const EXT = resolve(import.meta.dirname, "../dist/unpacked");
const SITE = resolve(import.meta.dirname, "../../quiet-swap/dist");
const ARTIFACTS = resolve(import.meta.dirname, "artifacts");
const NETWORK = process.env.NETWORK ?? "passthrough";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = createServer(async (req, res) => {
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
  try {
    const body = await readFile(join(SITE, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "max-age=600" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

await mkdir(ARTIFACTS, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "unlinked-live-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
  viewport: { width: 1100, height: 720 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await sw.evaluate(async (network) => {
    const stored = (await chrome.storage.local.get("settings")).settings ?? {};
    await chrome.storage.local.set({ settings: { ...stored, network } });
  }, NETWORK);

  const page = await context.newPage();
  const started = Date.now();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  console.log(`unlinked live (${NETWORK})`);

  await page.waitForFunction(() => /^\d+\.\d\d$/.test(document.getElementById("quote")?.textContent ?? ""), null, { timeout: 240_000 });
  const quote = await page.locator("#quote").innerText();
  console.log(`  ✔ real Uniswap v4 quote through ${NETWORK}: 0.001 ETH → ${quote} USDC (${((Date.now() - started) / 1000).toFixed(1)} s)`);

  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "http://127.0.0.1/*" }))[0]?.id);
  const reportOf = () => sw.evaluate(async (id) => (await chrome.storage.session.get(`report:${id}`))[`report:${id}`], tabId);
  let report;
  for (let i = 0; i < 400; i++) {
    report = await reportOf();
    if (report?.code && report.code.state !== "pending") break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.ok(report.rpc.calls > 0);
  assert.equal(report.rpc.routed + report.rpc.cached, report.rpc.calls, JSON.stringify(report.rpc));
  console.log(`  ✔ ${report.rpc.calls} calls, all routed or cached; ${report.rpc.keys.length} circuit(s); avg ${Math.round(report.rpc.latencyTotal / Math.max(1, report.rpc.latencyCount))} ms`);
  assert.ok(["unattested", "verified"].includes(report.code.state), JSON.stringify(report.code));
  console.log(`  ✔ real Arkiv lookup through ${NETWORK}: ${report.code.state}`);

  await page.waitForSelector("unlinked-summary", { state: "attached", timeout: 20_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: join(ARTIFACTS, `live-${NETWORK}.png`) });
  console.log(`  screenshot: test/artifacts/live-${NETWORK}.png`);
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
