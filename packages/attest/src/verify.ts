#!/usr/bin/env node
// Check a build you have — an unpacked extension, a downloaded zip, a site's
// dist folder — against the attestations on Arkiv.
//
//   node packages/attest/src/verify.ts packages/extension/dist/unlinked-0.1.0.zip
//   node packages/attest/src/verify.ts ~/.config/google-chrome/Default/Extensions/<id>/<version> --trust 0xabc…,0xdef…
//
// Exits 0 when at least one (trusted) attester published this exact root.
// To keep the lookup itself private, run it under torsocks.

import { parseArgs } from "node:util";
import { arkivQueryRequest, buildsByRootQuery, parseArkivPage, ARKIV_BLOCK_SECONDS } from "../../core/src/arkiv.ts";
import { normalizeAddress } from "../../core/src/addresses.ts";
import { readBuild } from "./build-files.ts";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    arkiv: { type: "string", default: "https://rpc.tiramisu.db-chain.testnet.arkiv.network" },
    trust: { type: "string", default: "" },
  },
});
const target = positionals[0];
if (!target) {
  console.error("usage: verify.ts <build dir | zip> [--trust 0x…,0x…] [--arkiv URL]");
  process.exit(2);
}

const trusted = new Set(args.trust.split(",").map(normalizeAddress).filter((a): a is string => a !== null));
const build = await readBuild(target);
console.log(`${Object.keys(build.files).length} files, root ${build.root}`);

const res = await fetch(args.arkiv, {
  method: "POST",
  headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0" },
  body: JSON.stringify(arkivQueryRequest(1, buildsByRootQuery([build.root]))),
});
if (!res.ok) throw new Error(`Arkiv answered HTTP ${res.status}`);
const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
if (body.error) throw new Error(`Arkiv: ${body.error.message}`);
const page = parseArkivPage(body.result);

const attestations = page.entities.filter((e) => trusted.size === 0 || trusted.has(e.owner));
if (attestations.length === 0) {
  console.log(page.entities.length ? `✗ attested only by untrusted wallets: ${page.entities.map((e) => e.owner).join(", ")}` : "✗ no attestation for this exact build");
  process.exit(1);
}
for (const e of attestations) {
  const daysLeft = Math.floor((Number(e.expiresAt - page.blockNumber) * ARKIV_BLOCK_SECONDS) / 86_400);
  const a = e.attributes;
  console.log(`✓ ${a.name} ${a.version} · ${a.repo} @ ${String(a.commit).slice(0, 12)} · by ${e.owner} · ${daysLeft} days left`);
}
