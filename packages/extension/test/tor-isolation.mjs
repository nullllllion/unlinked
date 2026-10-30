// Does the deployed tor-js worker honour isolation, and does Unlinked's
// strict-mode fallback (a slot marker in the config) give a separate client?
//
// Asks check.torproject.org which exit each request left from:
//   - one worker, alternating isolationKey "alice" / "bob"
//   - a second worker booted with { unlinkedSlot: 1 } in its config
//
// Without isolation, a Tor client reuses one circuit for ~10 minutes, so every
// request would show the same exit. Run it at the event to re-check:
//
//   node test/tor-isolation.mjs

import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { DEFAULT_TOR_GATEWAYS, NETWORKS } from "../src/config.ts";

const probe = `
  import { AnonRpcWorker } from "@anon-rpc/browser-harness";
  const bootstrap = {
    request: async ({ method, params }) => {
      const r = await fetch("https://ethereum-rpc.publicnode.com", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      return (await r.json()).result;
    },
  };
  const exitOf = async (worker, isolationKey) => {
    const res = await worker.fetch("https://check.torproject.org/api/ip", { anonOptions: isolationKey ? { isolationKey } : undefined });
    return res.json();
  };
  window.run = async (specifier, gateways) => {
    const out = { keyed: [], slot: null, errors: [] };
    const t0 = performance.now();
    const main = new AnonRpcWorker({ address: specifier, config: { gateways }, preExisting: { rpcProvider: bootstrap } });
    await main.ready;
    out.bootMs = Math.round(performance.now() - t0);
    for (const key of ["alice", "bob", "alice", "bob"]) {
      try { out.keyed.push({ key, ...(await exitOf(main, key)) }); } catch (e) { out.errors.push(key + ": " + e.message); }
    }
    try {
      const second = new AnonRpcWorker({ address: specifier, config: { gateways, unlinkedSlot: 1 }, preExisting: { rpcProvider: bootstrap } });
      await second.ready;
      out.slot = await exitOf(second, undefined);
    } catch (e) { out.errors.push("slot: " + e.message); }
    return out;
  };`;

const bundle = await build({
  stdin: { contents: probe, resolveDir: import.meta.dirname, loader: "js" },
  bundle: true,
  format: "esm",
  write: false,
  platform: "browser",
});
const js = bundle.outputFiles[0].text;
const server = createServer((req, res) => {
  if (req.url === "/probe.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(js);
  res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><script type="module" src="/probe.js"></script>');
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const profile = await mkdtemp(join(tmpdir(), "unlinked-tor-"));
const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, executablePath: process.env.CHROME_PATH || undefined });
try {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => typeof window.run === "function");
  const out = await page.evaluate(([s, g]) => window.run(s, g), [NETWORKS.tor.specifier, DEFAULT_TOR_GATEWAYS]);

  console.log(`tor-js booted in ${(out.bootMs / 1000).toFixed(1)} s`);
  for (const r of out.keyed) console.log(`  isolationKey ${r.key.padEnd(5)} → exit ${r.IP}  (IsTor: ${r.IsTor})`);
  if (out.slot) console.log(`  slot-1 client     → exit ${out.slot.IP}  (IsTor: ${out.slot.IsTor})`);
  for (const e of out.errors) console.log(`  error: ${e}`);

  const ip = (k) => out.keyed.filter((r) => r.key === k).map((r) => r.IP);
  const [a, b] = [ip("alice"), ip("bob")];
  const honoured = a.length === 2 && b.length === 2 && a[0] === a[1] && b[0] === b[1] && a[0] !== b[0];
  const ignored = new Set(out.keyed.map((r) => r.IP)).size === 1;
  console.log(
    honoured ? "\n→ isolationKey honoured: each key keeps its own exit"
    : ignored ? "\n→ isolationKey ignored: every key shared one exit (strict mode's separate clients are needed)"
    : "\n→ inconclusive: exits changed between requests",
  );
  if (out.slot) console.log(out.slot.IP !== out.keyed[0]?.IP ? "→ slot marker works: the second client left from a different exit" : "→ slot client booted, but happened to share the exit");
} finally {
  await context.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
